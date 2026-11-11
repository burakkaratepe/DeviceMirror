// Mac side of the iOS touch runner protocol (see native/ios-runner).
// One TCP connection through usbmuxd; commands are queued and sent one at a
// time because the device-side XCTest daemon accepts a single event at once.

import type net from 'node:net';
import { connectToDevice, usbDeviceId } from './usbmux';

export const RUNNER_PORT = 47310;

/** Protocol version this app speaks (DMRunnerTests.m kProtocolVersion). */
export const RUNNER_PROTOCOL = 3;
export class OutdatedRunnerError extends Error {}

export interface Hello { width: number; height: number; scale: number; version: number }
/** resolve gets the ack's result byte: 1 ok, 0 failed (op 9: the orientation). */
interface Pending { frame: Buffer; resolve: (result: number) => void }

export class IosTouchClient {
  private sock: net.Socket | undefined;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private inflight: (Pending & { seq: number }) | undefined;
  private seq = 1;
  private closed = false;
  hello: Hello | undefined;
  onClose?: () => void;

  /** Connects (retrying while the runner starts) and waits for its hello. */
  static async connect(udid: string, timeoutMs = 60000): Promise<IosTouchClient> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const id = await usbDeviceId(udid);
        if (id === undefined) throw new Error('The device is not connected over USB.');
        const { sock, leftover } = await connectToDevice(id, RUNNER_PORT);
        const client = new IosTouchClient();
        await client.attach(sock, leftover);
        return client;
      } catch (e) {
        if (e instanceof OutdatedRunnerError) throw e; // waiting will not help
        lastError = e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Could not reach the touch helper on the device.');
  }

  /** True when a runner answers on the device (connects and hangs up). */
  static async probe(udid: string): Promise<boolean> {
    try { (await IosTouchClient.connect(udid, 1500)).close(); return true; } catch { return false; }
  }

  private attach(sock: net.Socket, leftover: Buffer): Promise<void> {
    this.sock = sock;
    sock.setNoDelay(true);
    this.buf = leftover;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('no hello')); }, 3000);
      const onData = (d: Buffer) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!this.hello && this.buf.length >= 16) {
          if (this.buf[0] !== 0x80) { sock.destroy(); reject(new Error('unexpected reply')); return; }
          this.hello = { version: this.buf[1], width: this.buf.readFloatLE(4), height: this.buf.readFloatLE(8), scale: this.buf.readFloatLE(12) };
          this.buf = this.buf.subarray(16);
          clearTimeout(timer);
          if (this.hello.version < RUNNER_PROTOCOL) {
            // A runner from an older build (it can outlive the app): never talk
            // to it, the setup replaces it with the current one.
            sock.destroy();
            reject(new OutdatedRunnerError(`touch runner protocol ${this.hello.version} < ${RUNNER_PROTOCOL}`));
            return;
          }
          resolve();
        }
        this.readAcks();
      };
      sock.on('data', onData);
      sock.on('close', () => { clearTimeout(timer); reject(new Error('closed')); this.close(); });
      sock.on('error', () => undefined);
    });
  }

  private readAcks() {
    while (this.hello && this.buf.length >= 12) {
      const result = this.buf[1];
      const seq = this.buf.readUInt32LE(4);
      this.buf = this.buf.subarray(12);
      if (this.inflight?.seq === seq) {
        const p = this.inflight;
        this.inflight = undefined;
        p.resolve(result);
        this.pump();
      }
    }
  }

  private pump() {
    if (this.inflight || !this.sock || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    const seq = this.seq++;
    next.frame.writeUInt32LE(seq, 4);
    this.inflight = { ...next, seq };
    this.sock.write(next.frame);
  }

  private enqueue(op: number, count: number, payload: Buffer): Promise<boolean> {
    return this.request(op, count, payload).then((r) => r === 1);
  }

  private request(op: number, count: number, payload: Buffer): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    // Taps pile up quickly while the daemon is busy; keep the queue short so
    // the device never lags seconds behind the user.
    if (this.queue.length >= 4) this.queue.shift()?.resolve(0);
    const header = Buffer.alloc(8);
    header[0] = op;
    header.writeUInt16LE(payload.length, 2); // protocol 2: payload bytes (count kept for readability at call sites)
    void count;
    return new Promise((resolve) => {
      this.queue.push({ frame: Buffer.concat([header, payload]), resolve });
      this.pump();
    });
  }

  /** x/y normalized 0…1 of the portrait screen. */
  tap(x: number, y: number, holdSeconds = 0.03) {
    const p = Buffer.alloc(12);
    p.writeFloatLE(x, 0); p.writeFloatLE(y, 4); p.writeFloatLE(holdSeconds, 8);
    return this.enqueue(1, 0, p);
  }

  /** A whole drag: points with seconds since the first one. */
  gesture(points: { x: number; y: number; t: number }[]) {
    const pts = points.slice(0, 600);
    const p = Buffer.alloc(pts.length * 12);
    pts.forEach((pt, i) => { p.writeFloatLE(pt.x, i * 12); p.writeFloatLE(pt.y, i * 12 + 4); p.writeFloatLE(pt.t, i * 12 + 8); });
    return this.enqueue(2, pts.length, p);
  }

  text(s: string) {
    const p = Buffer.from(s, 'utf8').subarray(0, 4000);
    return this.enqueue(3, p.length, p);
  }

  home() { return this.enqueue(4, 0, Buffer.alloc(0)); }

  /** Device orientation for the user's quarter turns (0 upright, 1 landscape left, 2 upside down, 3 landscape right). */
  orientation(turns: number) {
    const p = Buffer.alloc(12);
    p.writeFloatLE([1, 3, 2, 4][turns] ?? 1, 0); // UIDeviceOrientation values
    return this.enqueue(8, 0, p);
  }

  /** How the device is held, as the user's quarter turns (0–3); undefined if unknown. */
  async currentTurns(): Promise<number | undefined> {
    const o = await this.request(9, 0, Buffer.alloc(0));
    return ({ 1: 0, 3: 1, 2: 2, 4: 3 } as Record<number, number>)[o]; // UIDeviceOrientation → turns
  }

  /** Wakes a sleeping screen with a keyboard key press (harmless when it is on). */
  wake() { return this.enqueue(7, 0, Buffer.alloc(0)); }

  /** Side buttons: 'volumeUp' | 'volumeDown' | 'lock'. */
  button(which: 'volumeUp' | 'volumeDown' | 'lock') {
    const p = Buffer.alloc(12);
    p.writeFloatLE(which === 'volumeUp' ? 2 : which === 'volumeDown' ? 3 : 100, 0);
    return this.enqueue(5, 0, p);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.inflight?.resolve(0);
    for (const q of this.queue) q.resolve(0);
    this.queue = [];
    this.sock?.destroy();
    this.onClose?.();
  }
}

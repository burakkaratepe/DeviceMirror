// Android mirroring session on top of scrcpy-server (protocol of scrcpy 4.x/5.x,
// see doc/develop.md in the scrcpy repo). We push the server jar, start it
// with app_process over an adb shell, connect a video and a control socket
// through an adb forward, and re-emit H.264 packets ready for WebCodecs.

import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { forward, openDeviceService, push, removeForward, shell } from './adb';
import type { Quality } from '../../shared/types';

export const SCRCPY_VERSION = '5.0.1';
const DEVICE_JAR = `/data/local/tmp/devicemirror-server-${SCRCPY_VERSION}.jar`;
const DEVICE_NAME_LENGTH = 64;
const HID_KEYBOARD_ID = 1;

/** Boot-protocol style keyboard: 8 modifier bits, reserved byte, 6 key slots (usages 0x00–0x65), 5 LEDs. */
const HID_KEYBOARD_REPORT_DESC = Buffer.from([
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, // Usage Page (Generic Desktop), Usage (Keyboard), Collection (Application)
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // modifiers
  0x75, 0x08, 0x95, 0x01, 0x81, 0x01, // reserved byte
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x75, 0x01, 0x95, 0x05, 0x91, 0x02, // LEDs
  0x75, 0x03, 0x95, 0x01, 0x91, 0x01, // LED padding
  0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x15, 0x00, 0x25, 0x65, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00, // keys
  0xc0, // End Collection
]);

export interface QualityParams { shortSide: number; bitRate: number; maxFps: number }

export const QUALITY_PARAMS: Record<Quality, QualityParams> = {
  low: { shortSide: 720, bitRate: 2_000_000, maxFps: 30 },
  medium: { shortSide: 1080, bitRate: 6_000_000, maxFps: 60 },
  high: { shortSide: 0, bitRate: 12_000_000, maxFps: 60 }, // 0 = native resolution
};

/** scrcpy's max_size limits the long side; derive it from the wanted short side. */
export function maxSizeFor(q: QualityParams, deviceW: number, deviceH: number): number {
  const short = Math.min(deviceW, deviceH);
  const long = Math.max(deviceW, deviceH);
  if (!q.shortSide || !short || q.shortSide >= short) return 0;
  return Math.round((q.shortSide * long) / short / 8) * 8;
}

export type VideoEvent =
  | { type: 'codec'; codec: string }
  | { type: 'size'; width: number; height: number }
  | { type: 'packet'; data: Buffer; key: boolean; pts: number };

export interface SessionEvents {
  onVideo(e: VideoEvent): void;
  onDeviceName(name: string): void;
  onClosed(error?: Error): void;
}

/** Buffered reader for a socket that hands out exact byte counts. */
class SocketReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private wait: (() => void) | undefined;
  private done = false;
  error: Error | undefined;

  constructor(sock: net.Socket) {
    sock.on('data', (d) => { this.chunks.push(d); this.length += d.length; this.wake(); });
    sock.on('close', () => { this.done = true; this.wake(); });
    sock.on('error', (e) => { this.error = e; this.done = true; this.wake(); });
  }

  private wake() { const w = this.wait; this.wait = undefined; w?.(); }

  async read(n: number): Promise<Buffer> {
    while (this.length < n) {
      if (this.done) throw this.error ?? new Error('stream closed');
      await new Promise<void>((r) => { this.wait = r; });
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }
}

/** Builds the WebCodecs codec string (avc1.PPCCLL) from an H.264 config packet. */
export function avcCodecString(config: Buffer): string | undefined {
  for (let i = 0; i + 4 < config.length; i++) {
    const startCode3 = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (!startCode3) continue;
    const nal = i + 3;
    if ((config[nal] & 0x1f) === 7 && nal + 3 < config.length) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(config[nal + 1])}${hex(config[nal + 2])}${hex(config[nal + 3])}`;
    }
  }
  return undefined;
}

function connectLocal(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.removeAllListeners('error'); s.setNoDelay(true); resolve(s); });
    s.once('error', reject);
  });
}

export class AndroidMirrorSession {
  private shellSock: net.Socket | undefined;
  private video: net.Socket | undefined;
  private control: net.Socket | undefined;
  private localPort: number | undefined;
  private closed = false;
  private log = '';
  /** Current encoded frame size; touch events must carry it. */
  width = 0;
  height = 0;

  constructor(
    private serial: string,
    private serverJar: string,
    private quality: QualityParams,
    private events: SessionEvents,
  ) {}

  async start(): Promise<void> {
    try {
      await this.ensureServer();
      const [w, h] = await this.physicalSize();
      const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
      this.localPort = await forward(this.serial, `localabstract:scrcpy_${scid}`);

      const params = [
        `scid=${scid}`,
        'log_level=info',
        'tunnel_forward=true',
        'audio=false',
        'video_codec=h264',
        `video_bit_rate=${this.quality.bitRate}`,
        `max_fps=${this.quality.maxFps}`,
        `max_size=${maxSizeFor(this.quality, w, h)}`,
        'clipboard_autosync=false',
        'power_on=true',
        'cleanup=true',
      ];
      this.shellSock = await openDeviceService(
        this.serial,
        `shell:CLASSPATH=${DEVICE_JAR} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${params.join(' ')}`,
      );
      this.shellSock.on('data', (d) => { this.log = (this.log + d.toString()).slice(-4000); });
      this.shellSock.on('close', () => this.close(new Error(this.serverError() ?? 'The mirroring server stopped.')));

      const { sock: video, reader } = await this.connectVideo();
      this.video = video;
      this.control = await connectLocal(this.localPort);
      this.control.on('data', () => undefined); // device messages (clipboard etc.) are not used yet
      this.control.on('error', () => undefined);

      const name = (await reader.read(DEVICE_NAME_LENGTH)).toString('utf8').replace(/\0.*$/s, '');
      this.events.onDeviceName(name);
      const codecId = (await reader.read(4)).readUInt32BE(0);
      if (codecId !== 0x68323634) throw new Error('Unexpected video codec from device.');
      void this.pump(reader);
    } catch (e) {
      this.close(e as Error);
      throw e;
    }
  }

  private async ensureServer() {
    const jar = readFileSync(this.serverJar);
    const ls = await shell(this.serial, `stat -c %s ${DEVICE_JAR} 2>/dev/null`);
    if (Number(ls.trim()) !== jar.length) await push(this.serial, jar, DEVICE_JAR);
  }

  private async physicalSize(): Promise<[number, number]> {
    const out = await shell(this.serial, 'wm size');
    const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  }

  /** The server needs a moment to start listening; the dummy byte proves it is up. */
  private async connectVideo(): Promise<{ sock: net.Socket; reader: SocketReader }> {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (this.closed) throw new Error('closed');
      const sock = await connectLocal(this.localPort!);
      const reader = new SocketReader(sock);
      try {
        await reader.read(1); // dummy byte
        return { sock, reader };
      } catch {
        sock.destroy();
        if (Date.now() > deadline) throw new Error(this.serverError() ?? 'The device did not start mirroring in time.');
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  private async pump(reader: SocketReader) {
    let pendingConfig: Buffer | undefined;
    try {
      for (;;) {
        const header = await reader.read(12);
        if (header[0] & 0x80) {
          // session packet: a (new) capture session with its size
          this.width = header.readUInt32BE(4);
          this.height = header.readUInt32BE(8);
          this.events.onVideo({ type: 'size', width: this.width, height: this.height });
          continue;
        }
        const config = (header[0] & 0x40) !== 0;
        const key = (header[0] & 0x20) !== 0;
        const pts = Number(header.readBigUInt64BE(0) & 0x1fffffffffffffffn);
        const size = header.readUInt32BE(8);
        const data = Buffer.from(await reader.read(size));
        if (config) {
          pendingConfig = data;
          const codec = avcCodecString(data);
          if (codec) this.events.onVideo({ type: 'codec', codec }); // decoder resets on every config
          continue;
        }
        // WebCodecs wants SPS/PPS in-band with the following key frame (Annex B).
        const payload = pendingConfig ? Buffer.concat([pendingConfig, data]) : data;
        this.events.onVideo({ type: 'packet', data: payload, key: key || !!pendingConfig, pts });
        pendingConfig = undefined;
      }
    } catch (e) {
      this.close(this.closed ? undefined : (e as Error));
    }
  }

  // ---- control messages (see scrcpy app/src/control_msg.c) -------------

  private send(buf: Buffer) {
    if (!this.closed && this.control && !this.control.destroyed) this.control.write(buf);
  }

  /** action: 0 down, 1 up, 2 move. x/y in video frame pixels. */
  touch(action: 0 | 1 | 2, x: number, y: number) {
    if (!this.width || !this.height) return;
    const b = Buffer.alloc(32);
    b[0] = 2; // INJECT_TOUCH_EVENT
    b[1] = action;
    b.writeBigUInt64BE(0xfffffffffffffffen, 2); // POINTER_ID_GENERIC_FINGER
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(this.width, 18);
    b.writeUInt16BE(this.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22); // pressure
    b.writeUInt32BE(0, 24); // action button
    b.writeUInt32BE(0, 28); // buttons
    this.send(b);
  }

  /** hscroll/vscroll in [-16, 16] "clicks". */
  scroll(x: number, y: number, hscroll: number, vscroll: number) {
    if (!this.width || !this.height) return;
    const fp = (v: number) => {
      const n = Math.max(-1, Math.min(1, v / 16));
      return n >= 1 ? 0x7fff : Math.round(n * 0x8000);
    };
    const b = Buffer.alloc(21);
    b[0] = 3; // INJECT_SCROLL_EVENT
    b.writeInt32BE(Math.round(x), 1);
    b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(this.width, 9);
    b.writeUInt16BE(this.height, 11);
    b.writeInt16BE(fp(hscroll), 13);
    b.writeInt16BE(fp(vscroll), 15);
    b.writeUInt32BE(0, 17);
    this.send(b);
  }

  /** Presses and releases an Android keycode (BACK 4, HOME 3, APP_SWITCH 187, …). */
  key(keycode: number, metaState = 0) {
    for (const action of [0, 1]) {
      const b = Buffer.alloc(14);
      b[0] = 0; // INJECT_KEYCODE
      b[1] = action;
      b.writeInt32BE(keycode, 2);
      b.writeInt32BE(0, 6); // repeat
      b.writeInt32BE(metaState, 10);
      this.send(b);
    }
  }

  // ---- virtual hardware keyboard (UHID) --------------------------------
  //
  // Text injection (INJECT_TEXT) goes through Android's virtual key map and
  // drops every non-ASCII character (ç, ş, ğ, ı, ö, ü …). Instead we register
  // a real HID keyboard on the device and send physical key reports, so
  // Android applies the keyboard layout chosen for it (e.g. Turkish Q) and
  // every character, shortcut and app works like with a USB keyboard.

  private keyboardCreated = false;

  /** Creates the keyboard on first use (needs Android 9+ for /dev/uhid). */
  private ensureKeyboard() {
    if (this.keyboardCreated) return;
    this.keyboardCreated = true;
    const name = Buffer.from('Device Mirror Keyboard', 'utf8');
    const head = Buffer.alloc(7);
    head[0] = 12; // UHID_CREATE
    head.writeUInt16BE(HID_KEYBOARD_ID, 1);
    head.writeUInt16BE(0, 3); // vendor id
    head.writeUInt16BE(0, 5); // product id
    const descLen = Buffer.alloc(2);
    descLen.writeUInt16BE(HID_KEYBOARD_REPORT_DESC.length);
    this.send(Buffer.concat([head, Buffer.from([name.length]), name, descLen, HID_KEYBOARD_REPORT_DESC]));
  }

  /** Sends one 8-byte keyboard input report (modifiers, reserved, 6 keys). */
  hidKeyboard(report: Uint8Array) {
    if (report.length !== 8) return;
    this.ensureKeyboard();
    const b = Buffer.alloc(5);
    b[0] = 13; // UHID_INPUT
    b.writeUInt16BE(HID_KEYBOARD_ID, 1);
    b.writeUInt16BE(8, 3);
    this.send(Buffer.concat([b, Buffer.from(report)]));
  }

  /** Opens Android's physical keyboard settings (to pick e.g. Turkish Q). */
  openKeyboardSettings() {
    this.ensureKeyboard();
    this.send(Buffer.from([15])); // OPEN_HARD_KEYBOARD_SETTINGS
  }

  private clipboardSeq = 0n;

  /** Sets the device clipboard; with `paste` it is also pasted into the focused field. */
  setClipboard(text: string, paste: boolean) {
    const body = Buffer.from(text, 'utf8').subarray(0, 256 * 1024 - 14);
    const b = Buffer.alloc(14);
    b[0] = 9; // SET_CLIPBOARD
    b.writeBigUInt64BE(++this.clipboardSeq, 1);
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(body.length, 10);
    this.send(Buffer.concat([b, body]));
  }

  private serverError(): string | undefined {
    const m = /ERROR:?\s*(.+)/.exec(this.log);
    return m ? m[1].trim() : undefined;
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.shellSock?.destroy();
    if (this.localPort) void removeForward(this.serial, this.localPort).catch(() => undefined);
    this.events.onClosed(error);
  }
}

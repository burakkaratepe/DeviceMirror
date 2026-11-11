// usbmuxd client: device attach/detach events, pair-record lookup and
// tunnelled connections to lockdownd for basic device info. Implemented on top
// of the documented-by-the-community usbmux protocol so we do not have to ship
// libimobiledevice or go-ios just to list devices.
//
// Endpoints: macOS/Linux use the unix socket /var/run/usbmuxd; Windows uses
// Apple Mobile Device Service on 127.0.0.1:27015.

import net from 'node:net';
import { asDict, buildPlist, parsePlist, type PlistValue } from '../plist';

const MSG_PLIST = 8;
const LOCKDOWN_PORT = 62078;
const PROG_NAME = 'DeviceMirror';

export function connectUsbmux(): net.Socket {
  return process.platform === 'win32'
    ? net.connect({ host: '127.0.0.1', port: 27015 })
    : net.connect({ path: '/var/run/usbmuxd' });
}

function frame(payload: PlistValue, tag: number): Buffer {
  const body = Buffer.from(buildPlist(payload), 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + body.length, 0);
  header.writeUInt32LE(1, 4); // protocol version 1 (plist)
  header.writeUInt32LE(MSG_PLIST, 8);
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, body]);
}

/** Splits a usbmux byte stream into decoded plist messages. */
export class UsbmuxDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): { tag: number; msg: Record<string, PlistValue> }[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: { tag: number; msg: Record<string, PlistValue> }[] = [];
    while (this.buf.length >= 16) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < len) break;
      const tag = this.buf.readUInt32LE(12);
      const body = this.buf.subarray(16, len).toString('utf8');
      this.buf = this.buf.subarray(len);
      out.push({ tag, msg: asDict(parsePlist(body)) });
    }
    return out;
  }

  /** Bytes received after the last complete message (used once a tunnel opens). */
  takeRest(): Buffer {
    const r = this.buf;
    this.buf = Buffer.alloc(0);
    return r;
  }
}

const baseMsg = (type: string) => ({
  MessageType: type,
  ClientVersionString: PROG_NAME,
  ProgName: PROG_NAME,
  kLibUSBMuxVersion: 3,
});

/** Sends one request on a fresh connection and resolves with the first reply. */
function oneShot(payload: Record<string, PlistValue>, timeoutMs = 3000): Promise<Record<string, PlistValue>> {
  return new Promise((resolve, reject) => {
    const sock = connectUsbmux();
    const dec = new UsbmuxDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('usbmuxd: timeout')); }, timeoutMs);
    sock.on('connect', () => sock.write(frame(payload, 1)));
    sock.on('data', (d) => {
      const [first] = dec.push(d);
      if (first) { clearTimeout(timer); sock.destroy(); resolve(first.msg); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** True when this computer holds a pair record for the device (user tapped "Trust"). */
export async function hasPairRecord(udid: string): Promise<boolean> {
  const reply = await oneShot({ ...baseMsg('ReadPairRecord'), PairRecordID: udid });
  return Buffer.isBuffer(reply.PairRecordData) && reply.PairRecordData.length > 0;
}

/** Opens a raw TCP tunnel to a port on the device. */
export function connectToDevice(deviceId: number, port: number, timeoutMs = 3000): Promise<{ sock: net.Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const sock = connectUsbmux();
    const dec = new UsbmuxDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('usbmuxd: connect timeout')); }, timeoutMs);
    const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff); // network byte order
    sock.on('connect', () => sock.write(frame({ ...baseMsg('Connect'), DeviceID: deviceId, PortNumber: swapped }, 1)));
    const onData = (d: Buffer) => {
      const [first] = dec.push(d);
      if (!first) return;
      clearTimeout(timer);
      sock.off('data', onData);
      if (first.msg.MessageType === 'Result' && first.msg.Number === 0) resolve({ sock, leftover: dec.takeRest() });
      else { sock.destroy(); reject(new Error(`usbmuxd: connect refused (${String(first.msg.Number)})`)); }
    };
    sock.on('data', onData);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Reads values from lockdownd without starting an SSL session. Only the
 * "public" keys (DeviceName, ProductType, ProductVersion, …) are available
 * this way, which is all the device list needs.
 */
export async function lockdownGetValues(deviceId: number, keys: string[]): Promise<Record<string, PlistValue>> {
  const { sock, leftover } = await connectToDevice(deviceId, LOCKDOWN_PORT);
  let buf = leftover;
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  sock.on('error', (e) => { failure = e; wake?.(); });
  sock.on('close', () => { failure ??= new Error('lockdown: closed'); wake?.(); });

  const send = (v: Record<string, PlistValue>) => {
    const body = Buffer.from(buildPlist({ Label: PROG_NAME, ...v }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    sock.write(Buffer.concat([len, body]));
  };
  const recv = async (): Promise<Record<string, PlistValue>> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const msg = asDict(parsePlist(buf.subarray(4, 4 + n).toString('utf8')));
        buf = buf.subarray(4 + n);
        return msg;
      }
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('lockdown: timeout');
      await new Promise<void>((r) => { wake = r; setTimeout(r, 200); });
    }
  };

  try {
    send({ Request: 'QueryType' });
    await recv();
    const out: Record<string, PlistValue> = {};
    for (const key of keys) {
      send({ Request: 'GetValue', Key: key });
      const reply = await recv();
      if (reply.Value !== undefined) out[key] = reply.Value;
    }
    return out;
  } finally {
    sock.destroy();
  }
}

export interface UsbmuxDevice {
  deviceId: number;
  udid: string;
  connectionType: string;
}

export interface ListenerEvents {
  onAttached(d: UsbmuxDevice): void;
  onDetached(deviceId: number): void;
  onStatus(ok: boolean, message?: string): void;
  /** Called when the listener reconnects so stale devices can be dropped. */
  onReset(): void;
}

/** Long-lived "Listen" connection with automatic reconnect. */
export class UsbmuxListener {
  private sock: net.Socket | undefined;
  private stopped = false;
  private retryMs = 1000;

  constructor(private events: ListenerEvents) {}

  start() { this.connect(); }

  stop() { this.stopped = true; this.sock?.destroy(); }

  private connect() {
    if (this.stopped) return;
    const sock = connectUsbmux();
    this.sock = sock;
    const dec = new UsbmuxDecoder();
    sock.on('connect', () => sock.write(frame(baseMsg('Listen'), 1)));
    sock.on('data', (d) => {
      for (const { msg } of dec.push(d)) this.handle(msg);
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      const missing = e.code === 'ENOENT' || e.code === 'ECONNREFUSED';
      this.events.onStatus(false, missing ? usbmuxMissingMessage() : `Lost connection to usbmuxd: ${e.message}`);
    });
    sock.on('close', () => {
      this.events.onReset();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10000);
    });
  }

  private handle(msg: Record<string, PlistValue>) {
    switch (msg.MessageType) {
      case 'Result':
        if (msg.Number === 0) { this.retryMs = 1000; this.events.onStatus(true); }
        else this.events.onStatus(false, `usbmuxd refused to list devices (${String(msg.Number)}).`);
        break;
      case 'Attached': {
        const p = asDict(msg.Properties);
        this.events.onAttached({
          deviceId: Number(msg.DeviceID),
          udid: String(p.SerialNumber ?? ''),
          connectionType: String(p.ConnectionType ?? 'USB'),
        });
        break;
      }
      case 'Detached':
        this.events.onDetached(Number(msg.DeviceID));
        break;
    }
  }
}

function usbmuxMissingMessage(): string {
  if (process.platform === 'win32') return 'Apple Mobile Device Support is not running. Install Apple Devices (or iTunes) to detect iOS devices.';
  if (process.platform === 'linux') return 'usbmuxd is not running. Install the usbmuxd package to detect iOS devices.';
  return 'usbmuxd is not available. iOS devices cannot be detected.';
}

/** usbmuxd's current DeviceID for a UDID connected over USB. */
export async function usbDeviceId(udid: string): Promise<number | undefined> {
  const reply = await oneShot({ ...baseMsg('ListDevices') });
  const list = Array.isArray(reply.DeviceList) ? reply.DeviceList.map(asDict) : [];
  const want = udid.replace(/-/g, '').toLowerCase();
  const hit = list.find((d) => {
    const p = asDict(d.Properties);
    return String(p.SerialNumber ?? '').replace(/-/g, '').toLowerCase() === want && p.ConnectionType === 'USB';
  });
  return hit ? Number(hit.DeviceID) : undefined;
}

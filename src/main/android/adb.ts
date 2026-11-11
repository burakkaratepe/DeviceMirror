// Talks to the adb server directly over its host protocol (TCP 5037) instead
// of spawning `adb` for every query. The adb binary is only used to start the
// server when none is running.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ADB_PORT = 5037;
const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';

/** Locate an adb binary: bundled first, then the usual SDK locations, then PATH. */
export function findAdb(resourcesDir?: string): string | undefined {
  const candidates: string[] = [];
  if (resourcesDir) candidates.push(path.join(resourcesDir, 'bin', exe));
  candidates.push(path.join(process.cwd(), 'resources', 'bin', `${platformDir()}-${process.arch}`, exe));
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const v = process.env[env];
    if (v) candidates.push(path.join(v, 'platform-tools', exe));
  }
  const home = os.homedir();
  if (process.platform === 'darwin') candidates.push(path.join(home, 'Library/Android/sdk/platform-tools', exe), '/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  if (process.platform === 'win32') candidates.push(path.join(process.env.LOCALAPPDATA ?? '', 'Android/Sdk/platform-tools', exe));
  if (process.platform === 'linux') candidates.push(path.join(home, 'Android/Sdk/platform-tools', exe), '/usr/bin/adb');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  return candidates.find((c) => existsSync(c));
}

function platformDir(): string {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
}

const encodeRequest = (s: string) => {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0'), 'ascii'), body]);
};

/** Reads framed adb replies ("OKAY"/"FAIL" + hex4 length payloads) from a socket. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private error: Error | undefined;

  constructor(sock: net.Socket) {
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.wake(); });
    sock.on('end', () => { this.ended = true; this.wake(); });
    sock.on('close', () => { this.ended = true; this.wake(); });
    sock.on('error', (e) => { this.error = e; this.ended = true; this.wake(); });
  }

  private wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error('adb: connection closed');
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readAll(): Promise<Buffer> {
    while (!this.ended) await new Promise<void>((r) => this.waiters.push(r));
    if (this.error) throw this.error;
    const out = this.buf;
    this.buf = Buffer.alloc(0);
    return out;
  }

  async readFramed(): Promise<string> {
    const len = parseInt((await this.read(4)).toString('ascii'), 16);
    return (await this.read(len)).toString('utf8');
  }

  async expectOkay(): Promise<void> {
    const status = (await this.read(4)).toString('ascii');
    if (status === 'OKAY') return;
    if (status === 'FAIL') throw new Error(`adb: ${await this.readFramed()}`);
    throw new Error(`adb: unexpected reply ${status}`);
  }
}

function connect(port = ADB_PORT): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
    s.once('error', reject);
  });
}

async function request(service: string, port?: number): Promise<{ sock: net.Socket; reader: Reader }> {
  const sock = await connect(port);
  const reader = new Reader(sock);
  sock.write(encodeRequest(service));
  try {
    await reader.expectOkay();
  } catch (e) {
    sock.destroy();
    throw e;
  }
  return { sock, reader };
}

/** Opens a device service (`shell:…`, `exec:…`) and returns everything it writes. */
async function deviceService(serial: string, service: string, port?: number): Promise<Buffer> {
  const sock = await connect(port);
  const reader = new Reader(sock);
  try {
    sock.write(encodeRequest(`host:transport:${serial}`));
    await reader.expectOkay();
    sock.write(encodeRequest(service));
    await reader.expectOkay();
    return await reader.readAll();
  } finally {
    sock.destroy();
  }
}

/** Runs a shell command on a device and returns its stdout. */
export async function shell(serial: string, command: string, port?: number): Promise<string> {
  return (await deviceService(serial, `shell:${command}`, port)).toString('utf8');
}

/** Binary-safe command output (`exec:` has no pty, so no CRLF mangling). */
export function exec(serial: string, command: string, port?: number): Promise<Buffer> {
  return deviceService(serial, `exec:${command}`, port);
}

/** True when the display is on (`dumpsys power` → mWakefulness=Awake). */
export async function isScreenOn(serial: string, port?: number): Promise<boolean> {
  const out = await shell(serial, 'dumpsys power | grep -m1 mWakefulness=', port);
  return /mWakefulness=Awake/.test(out) || !/mWakefulness=/.test(out); // unknown → assume on
}

/** Full-resolution PNG screenshot of the device. */
export async function screenshotPng(serial: string, port?: number): Promise<Buffer> {
  const png = await exec(serial, 'screencap -p', port);
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('screencap did not return a PNG');
  return png;
}

export interface AdbDeviceEntry {
  serial: string;
  state: string; // device | unauthorized | offline | ...
  props: Record<string, string>; // usb, product, model, device, transport_id
}

/** Parses one `host:track-devices-l` payload. */
export function parseDeviceList(payload: string): AdbDeviceEntry[] {
  return payload
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const props: Record<string, string> = {};
      for (const kv of rest) {
        const i = kv.indexOf(':');
        if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return { serial, state, props };
    });
}

export async function startServer(adbPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(adbPath, ['start-server'], { stdio: 'ignore', windowsHide: true });
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`adb start-server exited with ${code}`))));
  });
}

export interface TrackerEvents {
  onDevices(list: AdbDeviceEntry[]): void;
  onStatus(ok: boolean, message?: string): void;
}

/**
 * Keeps a `host:track-devices-l` connection open; adb pushes the full list on
 * every change. Reconnects (and starts the server if needed) with backoff.
 */
export class AdbTracker {
  private sock: net.Socket | undefined;
  private stopped = false;
  private retryMs = 500;

  constructor(private events: TrackerEvents, private resolveAdb: () => string | undefined, private port = ADB_PORT) {}

  start() { void this.loop(); }

  stop() { this.stopped = true; this.sock?.destroy(); }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.track();
      } catch (e) {
        if (this.stopped) return;
        const msg = await this.recover(e as NodeJS.ErrnoException);
        if (msg) this.events.onStatus(false, msg);
      }
      this.events.onDevices([]);
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.retryMs));
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    }
  }

  /** Returns an error message for the UI, or undefined if a retry should just happen. */
  private async recover(err: NodeJS.ErrnoException): Promise<string | undefined> {
    if (err.code !== 'ECONNREFUSED') return `Lost connection to adb: ${err.message}`;
    const adb = this.resolveAdb();
    if (!adb) return 'adb was not found. Android devices cannot be detected.';
    try {
      await startServer(adb);
      this.retryMs = 100;
      return undefined;
    } catch (e) {
      return `Could not start adb: ${(e as Error).message}`;
    }
  }

  private async track() {
    const { sock, reader } = await request('host:track-devices-l', this.port);
    this.sock = sock;
    this.events.onStatus(true);
    this.retryMs = 500;
    for (;;) this.events.onDevices(parseDeviceList(await reader.readFramed()));
  }
}

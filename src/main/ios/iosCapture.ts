// Talks to the native ios-capture helper (macOS only). The helper runs as a
// single long-lived process: when the process that enabled iPhone screen
// capture exits, macOS tears capture mode down and it takes 15–60 s to come
// back, so we never spawn one process per request.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { QualityParams, SessionEvents } from '../android/scrcpy';

export function findIosHelper(resourcesDir?: string): string | undefined {
  const candidates = [
    resourcesDir && path.join(resourcesDir, 'bin', 'ios-capture'),
    path.join(process.cwd(), 'resources', 'bin', `mac-${process.arch}`, 'ios-capture'),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c));
}

/** Splits the helper's [type u8][id u32][len u32][payload] stream. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): { type: number; id: number; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { type: number; id: number; payload: Buffer }[] = [];
    while (this.buf.length >= 9) {
      const len = this.buf.readUInt32BE(5);
      if (this.buf.length < 9 + len) break;
      out.push({ type: this.buf[0], id: this.buf.readUInt32BE(1), payload: Buffer.from(this.buf.subarray(9, 9 + len)) });
      this.buf = this.buf.subarray(9 + len);
    }
    return out;
  }
}

type Handler = (type: number, payload: Buffer) => void;

/** The shared helper process and request routing. */
class IosHelper {
  private child: ChildProcess | undefined;
  private handlers = new Map<number, Handler>();
  private nextId = 1;

  constructor(private path: string) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    // DM_DEBUG=1 passes the helper's diagnostics through to our stderr.
    const child = spawn(this.path, [], { stdio: ['pipe', 'pipe', process.env.DM_DEBUG ? 'inherit' : 'ignore'] });
    const parser = new FrameParser();
    child.stdout!.on('data', (d: Buffer) => {
      for (const f of parser.push(d)) this.handlers.get(f.id)?.(f.type, f.payload);
    });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = undefined;
      // Fail every open request; the next request starts a new helper.
      for (const h of [...this.handlers.values()]) h(4, Buffer.from('The iOS capture helper stopped.'));
      this.handlers.clear();
    });
    child.on('error', () => undefined);
    this.child = child;
    return child;
  }

  request(cmd: Record<string, unknown>, handler: Handler): number {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    this.ensure().stdin!.write(JSON.stringify({ ...cmd, id }) + '\n');
    return id;
  }

  stop(id: number) {
    if (!this.handlers.delete(id)) return;
    this.child?.stdin?.write(JSON.stringify({ cmd: 'stop', id }) + '\n');
  }

  done(id: number) { this.handlers.delete(id); }

  shutdown() {
    this.child?.stdin?.end(); // helper exits when stdin closes
    this.child = undefined;
  }
}

const helpers = new Map<string, IosHelper>();
function helperFor(p: string): IosHelper {
  let h = helpers.get(p);
  if (!h) { h = new IosHelper(p); helpers.set(p, h); }
  return h;
}

export function shutdownIosHelpers() {
  for (const h of helpers.values()) h.shutdown();
}

// The helper shares one capture between a mirror and a snapshot, but there is
// no need for background previews while a device is being mirrored.
const streaming = new Set<string>();

export class IosMirrorSession {
  private id: number | undefined;
  private closed = false;
  width = 0;
  height = 0;

  constructor(
    private helperPath: string,
    private udid: string,
    private name: string,
    private quality: QualityParams,
    private events: SessionEvents,
  ) {}

  start(): Promise<void> {
    streaming.add(this.udid);
    return new Promise((resolve, reject) => {
      let started = false;
      const firstFrameTimer = setTimeout(() => {
        if (!started) this.close(new Error('No picture arrived from the iOS device. Unlock it, keep the screen on, and try again.'));
      }, 35000);
      const helper = helperFor(this.helperPath);
      this.id = helper.request(
        { cmd: 'stream', udid: this.udid, name: this.name, shortSide: this.quality.shortSide, bitRate: this.quality.bitRate, fps: this.quality.maxFps },
        (type, p) => {
          if (this.closed) return;
          if (type === 1) this.events.onVideo({ type: 'codec', codec: p.toString('utf8') });
          else if (type === 2) {
            this.width = p.readUInt32BE(0);
            this.height = p.readUInt32BE(4);
            this.events.onVideo({ type: 'size', width: this.width, height: this.height });
          } else if (type === 3) {
            if (!started) { started = true; clearTimeout(firstFrameTimer); resolve(); }
            this.events.onVideo({ type: 'packet', key: (p[0] & 1) === 1, pts: Number(p.readBigUInt64BE(1)), data: p.subarray(9) });
          } else if (type === 4) {
            clearTimeout(firstFrameTimer);
            const err = new Error(p.toString('utf8'));
            if (!started) reject(err);
            if (this.id !== undefined) helper.done(this.id);
            this.close(err);
          }
        },
      );
    });
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    streaming.delete(this.udid);
    if (this.id !== undefined) helperFor(this.helperPath).stop(this.id);
    this.events.onClosed(error);
  }
}

/** One PNG of the device screen (for the device card preview). Never prompts for camera access. */
export function iosSnapshot(helperPath: string, udid: string, name: string): Promise<Buffer> {
  if (streaming.has(udid)) return Promise.reject(new Error('busy'));
  return new Promise((resolve, reject) => {
    const helper = helperFor(helperPath);
    const id = helper.request({ cmd: 'snapshot', udid, name }, (type, p) => {
      if (type !== 4 && type !== 5) return;
      helper.done(id);
      clearTimeout(timer);
      if (type === 5) resolve(p);
      else reject(new Error(p.toString('utf8')));
    });
    const timer = setTimeout(() => { helper.stop(id); reject(new Error('timeout')); }, 15000);
  });
}

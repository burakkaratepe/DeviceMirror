// Runs the native ios-capture helper (macOS only) and turns its framed stdout
// into the same video events the Android session produces.

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

/** Splits the helper's [type u8][len u32][payload] stream. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): { type: number; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { type: number; payload: Buffer }[] = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push({ type: this.buf[0], payload: Buffer.from(this.buf.subarray(5, 5 + len)) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

function run(helper: string, args: string[], onFrame: (type: number, payload: Buffer) => void, onExit: (code: number | null, error?: string) => void): ChildProcess {
  const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const parser = new FrameParser();
  let error: string | undefined;
  child.stdout!.on('data', (d: Buffer) => {
    for (const f of parser.push(d)) {
      if (f.type === 4) error = f.payload.toString('utf8');
      else onFrame(f.type, f.payload);
    }
  });
  child.on('error', (e) => { error = e.message; });
  child.on('close', (code) => onExit(code, error));
  return child;
}

export class IosMirrorSession {
  private child: ChildProcess | undefined;
  private closed = false;
  width = 0;
  height = 0;

  constructor(
    private helper: string,
    private udid: string,
    private name: string,
    private quality: QualityParams,
    private events: SessionEvents,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      const args = ['stream', this.udid, this.name, String(this.quality.shortSide), String(this.quality.bitRate), String(this.quality.maxFps)];
      this.child = run(
        this.helper,
        args,
        (type, p) => {
          if (type === 1) this.events.onVideo({ type: 'codec', codec: p.toString('utf8') });
          else if (type === 2) {
            this.width = p.readUInt32BE(0);
            this.height = p.readUInt32BE(4);
            this.events.onVideo({ type: 'size', width: this.width, height: this.height });
          } else if (type === 3) {
            if (!started) { started = true; resolve(); }
            this.events.onVideo({ type: 'packet', key: (p[0] & 1) === 1, pts: Number(p.readBigUInt64BE(1)), data: p.subarray(9) });
          }
        },
        (code, error) => {
          const err = this.closed ? undefined : new Error(error ?? `The iOS capture helper stopped (${code}).`);
          if (!started) reject(err ?? new Error('closed'));
          this.close(err);
        },
      );
    });
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    this.child?.stdin?.end(); // helper exits when stdin closes
    setTimeout(() => this.child?.kill(), 500);
    this.events.onClosed(error);
  }
}

/** One PNG of the device screen (for the device card preview). */
export function iosSnapshot(helper: string, udid: string, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let png: Buffer | undefined;
    const child = run(helper, ['snapshot', udid, name], (type, p) => { if (type === 5) png = p; }, (_code, error) => {
      if (png) resolve(png);
      else reject(new Error(error ?? 'No snapshot'));
    });
    setTimeout(() => child.kill(), 20000);
  });
}

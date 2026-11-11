// Screenshots and screen recordings taken from mirror windows.
//
// Files live in userData/Captures with an index.json next to them. Videos are
// streamed in while recording (MediaRecorder chunks are appended to the file),
// so stopping only has to close the file and write a thumbnail.
// The main window shows them through the dm-capture:// protocol.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type WebContents } from 'electron';
import type { Capture, CaptureKind } from '../shared/types';
import { fixFragmentedMp4Duration } from './mp4Duration';

export const CAPTURE_SCHEME = 'dm-capture';

/** Must run before the app is ready. */
export function registerCaptureScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: CAPTURE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

interface Recording { id: string; file: string; out: WriteStream; meta: CaptureMeta; owner: WebContents; started: number }
export interface CaptureMeta { deviceId: string; serial: string; deviceName: string; platform: 'android' | 'ios'; width: number; height: number }

export class CaptureStore {
  private items: Capture[] = [];
  private recordings = new Map<string, Recording>();
  private listeners = new Set<() => void>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    try {
      const all = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Capture[];
      this.items = all.filter((c) => existsSync(path.join(dir, c.file)));
    } catch { /* first run */ }
  }

  private get indexFile() { return path.join(this.dir, 'index.json'); }
  private save() { writeFileSync(this.indexFile, JSON.stringify(this.items, null, 1)); }
  private changed() { this.save(); for (const l of this.listeners) l(); }
  onChange(cb: () => void) { this.listeners.add(cb); }

  list(): Capture[] { return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  private baseName(meta: CaptureMeta, kind: CaptureKind) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
    const device = meta.deviceName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Device';
    let name = `${device} ${kind === 'video' ? 'Recording' : 'Screenshot'} ${stamp}`;
    for (let i = 2; existsSync(path.join(this.dir, `${name}.png`)) || existsSync(path.join(this.dir, `${name}.webp`)) || existsSync(path.join(this.dir, `${name}.mp4`)) || existsSync(path.join(this.dir, `${name}.webm`)); i++) {
      name = `${device} ${kind === 'video' ? 'Recording' : 'Screenshot'} ${stamp} (${i})`;
    }
    return name;
  }

  /** The small JPEG the mirror window made, stored next to the capture. */
  private writeThumb(name: string, jpeg?: Buffer): string | undefined {
    if (!jpeg?.length) return undefined;
    const thumb = `${name}.thumb.jpg`;
    writeFileSync(path.join(this.dir, thumb), jpeg);
    return thumb;
  }

  /** image: WebP (or PNG) already compressed by the mirror window. */
  addScreenshot(image: Buffer, ext: 'webp' | 'png', thumb: Buffer | undefined, meta: CaptureMeta): Capture {
    const name = this.baseName(meta, 'screenshot');
    const file = `${name}.${ext}`;
    writeFileSync(path.join(this.dir, file), image);
    const item: Capture = {
      id: name, kind: 'screenshot', file, thumb: this.writeThumb(name, thumb),
      deviceId: meta.deviceId, serial: meta.serial, deviceName: meta.deviceName, platform: meta.platform, width: meta.width, height: meta.height,
      size: image.length, createdAt: new Date().toISOString(),
    };
    this.items.push(item);
    this.changed();
    return item;
  }

  startRecording(owner: WebContents, meta: CaptureMeta, mime: string): string {
    const name = this.baseName(meta, 'video');
    const file = `${name}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    const out = createWriteStream(path.join(this.dir, file));
    this.recordings.set(name, { id: name, file, out, meta, owner, started: Date.now() });
    return name;
  }

  appendRecording(id: string, chunk: Buffer) { this.recordings.get(id)?.out.write(chunk); }

  async finishRecording(id: string, durationMs?: number, thumb?: Buffer): Promise<Capture | undefined> {
    const rec = this.recordings.get(id);
    if (!rec) return undefined;
    this.recordings.delete(id);
    await new Promise<void>((r) => rec.out.end(r));
    const full = path.join(this.dir, rec.file);
    if (statSync(full).size === 0) { rmSync(full, { force: true }); return undefined; }
    // Fill in the total length so players show a steady seek bar.
    let fileDuration: number | undefined;
    if (rec.file.endsWith('.mp4')) fileDuration = await fixFragmentedMp4Duration(full).catch(() => undefined);
    const size = statSync(full).size;
    const item: Capture = {
      id, kind: 'video', file: rec.file, thumb: this.writeThumb(id, thumb),
      deviceId: rec.meta.deviceId, serial: rec.meta.serial, deviceName: rec.meta.deviceName, platform: rec.meta.platform, width: rec.meta.width, height: rec.meta.height,
      size, durationMs: fileDuration ?? durationMs ?? Date.now() - rec.started, createdAt: new Date(rec.started).toISOString(),
    };
    this.items.push(item);
    this.changed();
    return item;
  }

  /** A mirror window closed while recording: keep what was recorded. */
  finishAllFor(owner: WebContents) {
    for (const rec of [...this.recordings.values()]) if (rec.owner === owner) void this.finishRecording(rec.id);
  }

  remove(id: string) {
    const item = this.items.find((c) => c.id === id);
    if (!item) return;
    rmSync(path.join(this.dir, item.file), { force: true });
    if (item.thumb) rmSync(path.join(this.dir, item.thumb), { force: true });
    this.items = this.items.filter((c) => c !== item);
    this.changed();
  }

  /** Opens Finder / Explorer / the file manager with the capture selected. */
  reveal(id: string) {
    const item = this.items.find((c) => c.id === id);
    if (item) shell.showItemInFolder(path.join(this.dir, item.file));
  }

  removeAll() {
    for (const item of this.items) {
      rmSync(path.join(this.dir, item.file), { force: true });
      if (item.thumb) rmSync(path.join(this.dir, item.thumb), { force: true });
    }
    this.items = [];
    this.changed();
  }

  /** "Download": saves a copy wherever the user picks (Downloads by default). */
  async exportCopy(id: string, win?: BrowserWindow): Promise<boolean> {
    const item = this.items.find((c) => c.id === id);
    if (!item) return false;
    const opts = { defaultPath: path.join(app.getPath('downloads'), item.file) };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return false;
    await copyFile(path.join(this.dir, item.file), res.filePath);
    return true;
  }

  /** Serves dm-capture://files/<name> from the captures folder. */
  serve() {
    protocol.handle(CAPTURE_SCHEME, (req) => {
      const name = path.basename(decodeURIComponent(new URL(req.url).pathname));
      const known = this.items.some((c) => c.file === name || c.thumb === name);
      if (!known) return new Response('Not found', { status: 404 });
      return serveFile(path.join(this.dir, name), req.headers.get('range'));
    });
  }
}

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };

/**
 * A file with HTTP range support. The video player seeks by asking for byte
 * ranges; without 206 answers the seek bar could not be used.
 */
function serveFile(file: string, range: string | null): Response {
  let size: number;
  try { size = statSync(file).size; } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = (start: number, end: number) => Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (!m[1] && !m[2])) {
    return new Response(size ? body(0, size - 1) : null, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  }
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); // "bytes=-N": the last N bytes
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  start = Math.max(0, start);
  return new Response(body(start, end), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

/** IPC for mirror windows (saving) and the main window (listing, download, delete). */
export function registerCaptureIpc(store: CaptureStore, deps: { deviceFor(wc: WebContents): { id: string; serial: string; name: string; platform: 'android' | 'ios' } | undefined; mainWindow(): BrowserWindow | undefined; showCaptures(): void }) {
  const metaFor = (wc: WebContents, w: unknown, h: unknown): CaptureMeta | undefined => {
    const d = deps.deviceFor(wc);
    return d ? { deviceId: d.id, serial: d.serial, deviceName: d.name, platform: d.platform, width: Number(w) || 0, height: Number(h) || 0 } : undefined;
  };
  ipcMain.handle('capture:screenshot', (e, image: unknown, ext: unknown, thumb: unknown, w: unknown, h: unknown) => {
    const meta = metaFor(e.sender, w, h);
    if (!meta || !(image instanceof Uint8Array) || image.length > 64 * 1024 * 1024) return undefined;
    return store.addScreenshot(Buffer.from(image), ext === 'png' ? 'png' : 'webp', thumb instanceof Uint8Array ? Buffer.from(thumb) : undefined, meta);
  });
  ipcMain.handle('capture:recStart', (e, mime: unknown, w: unknown, h: unknown) => {
    const meta = metaFor(e.sender, w, h);
    if (!meta || typeof mime !== 'string') return undefined;
    return store.startRecording(e.sender, meta, mime);
  });
  ipcMain.on('capture:recChunk', (_e, id: unknown, chunk: unknown) => {
    if (typeof id === 'string' && chunk instanceof Uint8Array) store.appendRecording(id, Buffer.from(chunk));
  });
  ipcMain.handle('capture:recStop', (_e, id: unknown, durationMs: unknown, poster: unknown) => {
    if (typeof id !== 'string') return undefined;
    return store.finishRecording(id, typeof durationMs === 'number' ? durationMs : undefined, poster instanceof Uint8Array ? Buffer.from(poster) : undefined);
  });
  ipcMain.on('capture:show', () => deps.showCaptures());

  ipcMain.handle('captures:list', () => store.list());
  ipcMain.handle('captures:download', (_e, id: unknown) => typeof id === 'string' ? store.exportCopy(id, deps.mainWindow()) : false);
  ipcMain.handle('captures:delete', (_e, id: unknown) => { if (typeof id === 'string') store.remove(id); });
  ipcMain.handle('captures:deleteAll', () => store.removeAll());
  ipcMain.on('captures:reveal', (_e, id: unknown) => { if (typeof id === 'string') store.reveal(id); });
}

// Owns mirror windows and their device sessions; enforces the concurrent limit.

import { BrowserWindow, clipboard, ipcMain, screen, type IpcMainEvent } from 'electron';
import path from 'node:path';
import { shell } from './android/adb';
import { AndroidMirrorSession, QUALITY_PARAMS, type SessionEvents } from './android/scrcpy';
import { IosMirrorSession } from './ios/iosCapture';
import { parseKeyboardLayout } from './keyboardLayout';
import type { Settings } from './settings';
import type { Device, MirrorInfo, MirrorResult, MirrorStatus, Quality } from '../shared/types';

export const MAX_MIRRORS = 2;

/** Input goes only to Android sessions for now (iOS touch arrives in Phase 5). */
const controlOf = (e: { session?: AndroidMirrorSession | IosMirrorSession } | undefined) =>
  e?.session instanceof AndroidMirrorSession ? e.session : undefined;
const TOOLBAR_HEIGHT = 56; // keep in sync with mirror.css
const QUALITIES: Quality[] = ['low', 'medium', 'high'];

interface Entry {
  device: Device;
  win: BrowserWindow;
  session?: AndroidMirrorSession | IosMirrorSession;
  /** Last frame size, to keep the window's aspect ratio in step with rotation. */
  size?: { width: number; height: number };
  status: MirrorStatus;
}

export interface MirrorDeps {
  serverJar: () => string;
  /** Path of the macOS ios-capture helper, if available. */
  iosHelper: () => string | undefined;
  settings: Settings;
  findDevice(id: string): Device | undefined;
  /** Called when the set of mirrored devices or a quality changes. */
  onChange(): void;
}

export class MirrorManager {
  private entries = new Map<string, Entry>();

  constructor(private deps: MirrorDeps) {
    const entryFor = (e: IpcMainEvent) => [...this.entries.values()].find((x) => x.win.webContents === e.sender);
    ipcMain.handle('mirror:info', (e) => {
      const entry = [...this.entries.values()].find((x) => x.win.webContents === e.sender);
      return entry ? this.info(entry) : undefined;
    });
    ipcMain.on('mirror:touch', (e, action: unknown, x: unknown, y: unknown) => {
      if ((action === 0 || action === 1 || action === 2) && typeof x === 'number' && typeof y === 'number') controlOf(entryFor(e))?.touch(action, x, y);
    });
    ipcMain.on('mirror:scroll', (e, x: unknown, y: unknown, h: unknown, v: unknown) => {
      if ([x, y, h, v].every((n) => typeof n === 'number')) controlOf(entryFor(e))?.scroll(x as number, y as number, h as number, v as number);
    });
    ipcMain.on('mirror:key', (e, code: unknown, meta: unknown) => {
      if (Number.isInteger(code) && (code as number) > 0 && (code as number) < 400) {
        controlOf(entryFor(e))?.key(code as number, Number.isInteger(meta) ? (meta as number) : 0);
      }
    });
    ipcMain.on('mirror:hid', (e, report: unknown) => {
      if (report instanceof Uint8Array && report.length === 8) controlOf(entryFor(e))?.hidKeyboard(report);
    });
    ipcMain.on('mirror:keyboardSettings', (e) => controlOf(entryFor(e))?.openKeyboardSettings());
    ipcMain.handle('mirror:keyboardLayout', async (e) => {
      const entry = [...this.entries.values()].find((x) => x.win.webContents === e.sender);
      if (!entry) return undefined;
      try {
        return parseKeyboardLayout(await shell(entry.device.serial, 'dumpsys input'));
      } catch {
        return undefined;
      }
    });
    ipcMain.on('mirror:paste', async (e) => {
      const text = await clipboard.readText(); // async in recent Electron versions
      if (text) controlOf(entryFor(e))?.setClipboard(text, true);
    });
    ipcMain.on('mirror:quality', (e, q: unknown) => {
      const entry = entryFor(e);
      if (entry && QUALITIES.includes(q as Quality)) this.setQuality(entry.device.id, q as Quality);
    });
    ipcMain.on('mirror:retry', (e) => {
      const entry = entryFor(e);
      if (entry) void this.startSession(entry);
    });
  }

  isMirroring(id: string): boolean { return this.entries.has(id); }

  open(device: Device, replaceId?: string): MirrorResult {
    const existing = this.entries.get(device.id);
    if (existing) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return { ok: true };
    }
    if (device.platform === 'ios' && (process.platform !== 'darwin' || !this.deps.iosHelper())) {
      return { ok: false, reason: 'error', message: 'iOS mirroring on this platform is coming soon.' };
    }
    if (replaceId && this.entries.has(replaceId)) this.close(replaceId);
    if (this.entries.size >= MAX_MIRRORS) {
      return { ok: false, reason: 'limit', active: [...this.entries.values()].map((e) => ({ id: e.device.id, name: e.device.name })) };
    }

    const entry: Entry = { device, win: this.createWindow(device), status: { state: 'connecting' } };
    this.entries.set(device.id, entry);
    entry.win.on('closed', () => {
      entry.session?.close();
      if (this.entries.get(device.id) === entry) this.entries.delete(device.id);
      this.deps.onChange();
    });
    entry.win.webContents.once('did-finish-load', () => void this.startSession(entry));
    this.deps.onChange();
    return { ok: true };
  }

  close(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.session?.close();
    if (!e.win.isDestroyed()) e.win.close();
    this.deps.onChange();
  }

  closeAll() { for (const id of [...this.entries.keys()]) this.close(id); }

  /** Called when the quality changes from the device list or the mirror toolbar. */
  setQuality(id: string, q: Quality) {
    this.deps.settings.setQuality(id, q);
    const e = this.entries.get(id);
    if (e) {
      e.device = { ...e.device, quality: q };
      this.send(e, 'mirror:info', this.info(e));
      void this.startSession(e); // restart with the new encoder settings
    }
    this.deps.onChange();
  }

  /** Closes mirrors of devices that were unplugged or lost authorization. */
  syncDevices(devices: Device[]) {
    for (const [id, e] of this.entries) {
      const d = devices.find((x) => x.id === id);
      if (!d || d.state !== 'ready') this.close(id);
      else if (d.name !== e.device.name) {
        e.device = { ...e.device, name: d.name };
        if (!e.win.isDestroyed()) e.win.setTitle(d.name);
      }
    }
  }

  private info(e: Entry): MirrorInfo {
    return { deviceId: e.device.id, name: e.device.name, platform: e.device.platform, quality: this.deps.settings.quality(e.device.id) };
  }

  private send(e: Entry, channel: string, payload: unknown) {
    if (!e.win.isDestroyed()) e.win.webContents.send(channel, payload);
  }

  private setStatus(e: Entry, s: MirrorStatus) {
    e.status = s;
    this.send(e, 'mirror:status', s);
  }

  private async startSession(e: Entry) {
    e.session?.close();
    e.session = undefined;
    this.setStatus(e, { state: 'connecting' });
    const quality = QUALITY_PARAMS[this.deps.settings.quality(e.device.id)];
    let firstFrame = true;
    let session: AndroidMirrorSession | IosMirrorSession | undefined;
    const events: SessionEvents = {
      onVideo: (v) => {
        if (e.session !== session) return;
        if (v.type === 'size') this.fitToFrame(e, v.width, v.height);
        if (v.type === 'packet' && firstFrame) { firstFrame = false; this.setStatus(e, { state: 'live' }); }
        this.send(e, 'mirror:video', v); // Buffers arrive in the renderer as Uint8Array (MirrorVideo)
      },
      onDeviceName: () => undefined,
      onClosed: (err) => {
        if (e.session !== session) return;
        e.session = undefined;
        if (this.entries.get(e.device.id) === e) this.setStatus(e, { state: 'error', message: err?.message ?? 'Mirroring stopped.' });
      },
    };
    session = e.device.platform === 'ios'
      ? new IosMirrorSession(this.deps.iosHelper()!, e.device.serial, e.device.name, quality, events)
      : new AndroidMirrorSession(e.device.serial, this.deps.serverJar(), quality, events);
    e.session = session;
    try {
      await session.start();
    } catch {
      // onClosed already reported the error to the window
    }
  }


  private createWindow(device: Device): BrowserWindow {
    const work = screen.getPrimaryDisplay().workAreaSize;
    const h = Math.min(860, work.height - 60);
    const ratio = device.preview ? device.preview.width / device.preview.height : 9 / 19.5;
    const w = Math.round((h - TOOLBAR_HEIGHT) * ratio);
    const win = new BrowserWindow({
      width: Math.max(w, 300),
      height: h,
      minWidth: 260,
      minHeight: 320,
      title: device.name,
      backgroundColor: '#0b0e14',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'mirrorPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    win.removeMenu();
    win.once('ready-to-show', () => win.show());
    void win.loadFile(path.join(__dirname, 'renderer', 'mirror.html'));
    return win;
  }

  /** Resizes the window to the frame's aspect ratio (keeps its height). */
  private fitToFrame(e: Entry, width: number, height: number) {
    if (e.win.isDestroyed()) return;
    const rotated = !e.size || (e.size.width > e.size.height) !== (width > height);
    e.size = { width, height };
    e.win.setAspectRatio(width / height, { width: 0, height: TOOLBAR_HEIGHT });
    if (!rotated || e.win.isMaximized() || e.win.isFullScreen()) return;
    const [, curH] = e.win.getContentSize();
    const work = screen.getDisplayMatching(e.win.getBounds()).workAreaSize;
    let videoH = Math.min(curH - TOOLBAR_HEIGHT, work.height - 60 - TOOLBAR_HEIGHT);
    let videoW = Math.round((videoH * width) / height);
    if (videoW > work.width - 40) { videoW = work.width - 40; videoH = Math.round((videoW * height) / width); }
    e.win.setContentSize(Math.max(videoW, 260), videoH + TOOLBAR_HEIGHT);
  }
}

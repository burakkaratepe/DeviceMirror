// Owns mirror windows and their device sessions; enforces the concurrent limit.

import { BrowserWindow, clipboard, ipcMain, screen, type IpcMainEvent, type WebContents } from 'electron';
import path from 'node:path';
import { shell } from './android/adb';
import { AndroidMirrorSession, QUALITY_PARAMS, type SessionEvents } from './android/scrcpy';
import { IosMirrorSession } from './ios/iosCapture';
import { IosTouchClient } from './ios/touchClient';
import { parseKeyboardLayout } from './keyboardLayout';
import type { Settings } from './settings';
import type { Device, MirrorInfo, MirrorResult, MirrorStatus, Quality } from '../shared/types';

export const MAX_MIRRORS = 2;

/** Input goes only to Android sessions for now (iOS touch arrives in Phase 5). */
const controlOf = (e: { session?: AndroidMirrorSession | IosMirrorSession } | undefined) =>
  e?.session instanceof AndroidMirrorSession ? e.session : undefined;
/** Control rail to the right of the phone, margins included (mirror.css #toolbar). */
const TOOLBAR_WIDTH = 58;
const FRAME_PAD_X = 60; // room for the frame and side keys, well away from the resize edge (mirror.css #screen)
const FRAME_PAD_Y = 28;
const QUALITIES: Quality[] = ['low', 'medium', 'high'];

interface Entry {
  device: Device;
  win: BrowserWindow;
  session?: AndroidMirrorSession | IosMirrorSession;
  /** iOS: connection to the touch runner once touch control is on. */
  touch?: IosTouchClient;
  /** iOS: the user switched touch off; do not reconnect on our own. */
  touchOff?: boolean;
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
  /** Called with a mirror window's webContents just before it goes away. */
  onWindowClosed?: (wc: WebContents) => void;

  constructor(private deps: MirrorDeps) {
    const entryFor = (e: IpcMainEvent) => [...this.entries.values()].find((x) => x.win.webContents === e.sender);
    ipcMain.handle('mirror:info', (e) => {
      const entry = [...this.entries.values()].find((x) => x.win.webContents === e.sender);
      return entry ? this.info(entry) : undefined;
    });
    ipcMain.on('mirror:touch', (e, action: unknown, x: unknown, y: unknown) => {
      if ([0, 1, 2, 7, 9, 10].includes(action as number) && typeof x === 'number' && typeof y === 'number') controlOf(entryFor(e))?.touch(action as 0 | 1 | 2 | 7 | 9 | 10, x, y);
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
      if (!text) return;
      const entry = entryFor(e);
      if (entry?.touch) void entry.touch.text(text);
      else controlOf(entry)?.setClipboard(text, true);
    });
    ipcMain.on('mirror:quality', (e, q: unknown) => {
      const entry = entryFor(e);
      if (entry && QUALITIES.includes(q as Quality)) this.setQuality(entry.device.id, q as Quality);
    });
    const touchOf = (e: IpcMainEvent) => entryFor(e)?.touch;
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN;
    ipcMain.on('ios:tap', (e, x: unknown, y: unknown, hold: unknown) => {
      const hx = n(x), hy = n(y);
      if (!Number.isNaN(hx) && !Number.isNaN(hy)) void touchOf(e)?.tap(hx, hy, typeof hold === 'number' ? Math.min(5, Math.max(0.02, hold)) : 0.03);
    });
    ipcMain.on('ios:gesture', (e, pts: unknown) => {
      if (!Array.isArray(pts)) return;
      const clean = pts.map((p) => ({ x: n(p?.x), y: n(p?.y), t: typeof p?.t === 'number' ? Math.max(0, Math.min(10, p.t)) : NaN }))
        .filter((p) => !Number.isNaN(p.x) && !Number.isNaN(p.y) && !Number.isNaN(p.t));
      if (clean.length >= 2) void touchOf(e)?.gesture(clean);
    });
    ipcMain.on('ios:text', (e, text: unknown) => { if (typeof text === 'string' && text) void touchOf(e)?.text(text); });
    ipcMain.on('ios:home', (e) => void touchOf(e)?.home());
    ipcMain.on('ios:button', (e, which: unknown) => {
      if (which === 'volumeUp' || which === 'volumeDown' || which === 'lock') void touchOf(e)?.button(which);
    });
    // Touch switched off by the user: drop the connection, keep the runner
    // running on the device so switching back on is instant.
    ipcMain.on('ios:touchOff', (e) => {
      const entry = entryFor(e);
      if (!entry) return;
      const client = entry.touch;
      entry.touch = undefined;
      entry.touchOff = true;
      client?.close();
      this.send(entry, 'mirror:touch', false);
    });
    ipcMain.on('mirror:window', (e, action: unknown) => {
      const win = entryFor(e)?.win;
      if (!win) return;
      if (action === 'close') win.close();
      else if (action === 'minimize') win.minimize();
    });
    ipcMain.on('mirror:copy', (_e, text: unknown) => { if (typeof text === 'string' && text.length < 200) clipboard.writeText(text); });
    ipcMain.on('mirror:retry', (e) => {
      const entry = entryFor(e);
      if (entry) void this.startSession(entry);
    });
  }

  isMirroring(id: string): boolean { return this.entries.has(id); }

  /** Connects the touch runner to the device's mirror window (iOS). */
  async attachTouch(deviceId: string, udid: string, timeoutMs?: number) {
    const e = this.entries.get(deviceId);
    if (!e) return;
    e.touchOff = false;
    e.touch?.close();
    const client = await IosTouchClient.connect(udid, timeoutMs);
    if (this.entries.get(deviceId) !== e || e.touchOff) { client.close(); return; }
    e.touch = client;
    client.onClose = () => {
      if (e.touch !== client) return;
      e.touch = undefined;
      // The connection can drop while the runner keeps going (e.g. the
      // device briefly re-enumerates on USB): reconnect quietly first.
      if (!e.touchOff) {
        void this.attachTouch(deviceId, udid, 20000).catch(() => {
          if (e.touch) return;
          this.send(e, 'mirror:touch', false);
          this.send(e, 'mirror:notice', 'Lost the connection to touch control. Turn it on again with the hand button.');
        });
      } else {
        this.send(e, 'mirror:touch', false);
        if (!e.touchOff) this.send(e, 'mirror:notice', 'Touch control stopped on the device. Unlock it if needed, then turn touch on again with the hand button.');
      }
    };
    this.send(e, 'mirror:touch', true);
  }

  /** The device / window behind a mirror window's webContents (for IPC handlers). */
  deviceFor(wc: WebContents): Device | undefined { return [...this.entries.values()].find((x) => x.win.webContents === wc)?.device; }
  windowFor(wc: WebContents): BrowserWindow | undefined { return [...this.entries.values()].find((x) => x.win.webContents === wc)?.win; }

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
    const wc = entry.win.webContents;
    entry.win.on('close', () => this.onWindowClosed?.(wc));
    entry.win.on('closed', () => {
      entry.session?.close();
      entry.touch?.close();
      if (this.entries.get(device.id) === entry) this.entries.delete(device.id);
      this.deps.onChange();
    });
    entry.win.webContents.once('did-finish-load', () => {
      void this.startSession(entry);
      // Touch runner still running from before (this or an earlier app run):
      // connect without the setup flow.
      if (device.platform === 'ios') void this.attachTouch(device.id, device.serial, 2500).catch(() => undefined);
    });
    this.deps.onChange();
    return { ok: true };
  }

  close(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.session?.close();
    e.touch?.close();
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
    return { deviceId: e.device.id, serial: e.device.serial, name: e.device.name, platform: e.device.platform, quality: this.deps.settings.quality(e.device.id) };
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
    const w = Math.round((h - FRAME_PAD_Y) * ratio) + FRAME_PAD_X + TOOLBAR_WIDTH;
    const win = new BrowserWindow({
      width: Math.max(w, 300),
      height: h,
      minWidth: 240,
      minHeight: 460, // the control rail needs this much height
      title: device.name,
      // The window IS the device: no system frame, transparent around the
      // drawn phone (one frame instead of a window frame plus a phone frame).
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
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
    this.placeBesideOthers(win);
    win.once('ready-to-show', () => win.show());
    void win.loadFile(path.join(__dirname, 'renderer', 'mirror.html'));
    return win;
  }

  /**
   * Puts a new mirror window next to the one already open (right, else left)
   * on the same display, aligned at the top. When neither side has room but
   * the two fit side by side, the open window moves over to make room.
   * (The window edges are transparent padding, so they can touch.)
   */
  private placeBesideOthers(win: BrowserWindow) {
    const other = [...this.entries.values()].map((e) => e.win).filter((w) => w !== win && !w.isDestroyed() && !w.isMinimized()).pop();
    if (!other) return; // the first window: the OS centres it
    const b = other.getBounds();
    const [w, h] = win.getSize();
    const wa = screen.getDisplayMatching(b).workArea;
    const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h));
    if (b.x + b.width + w <= wa.x + wa.width) { win.setPosition(b.x + b.width, y); return; }
    if (b.x - w >= wa.x) { win.setPosition(b.x - w, y); return; }
    if (b.width + w <= wa.width) {
      const left = wa.x + Math.round((wa.width - b.width - w) / 2);
      other.setPosition(left, b.y);
      win.setPosition(left + b.width, y);
    }
  }

  /** Resizes the window to the frame's aspect ratio (keeps its height). */
  private fitToFrame(e: Entry, width: number, height: number) {
    if (e.win.isDestroyed()) return;
    const first = !e.size;
    const rotated = first || (e.size!.width > e.size!.height) !== (width > height);
    e.size = { width, height };
    e.win.setAspectRatio(width / height, { width: FRAME_PAD_X + TOOLBAR_WIDTH, height: FRAME_PAD_Y });
    if (!rotated || e.win.isMaximized() || e.win.isFullScreen()) return;
    const [, curH] = e.win.getContentSize();
    const work = screen.getDisplayMatching(e.win.getBounds()).workAreaSize;
    const extraH = FRAME_PAD_Y;
    const extraW = FRAME_PAD_X + TOOLBAR_WIDTH;
    let videoH = Math.min(curH - extraH, work.height - 60 - extraH);
    let videoW = Math.round((videoH * width) / height);
    if (videoW > work.width - 40 - extraW) { videoW = work.width - 40 - extraW; videoH = Math.round((videoW * height) / width); }
    e.win.setContentSize(Math.max(videoW + extraW, 240), videoH + extraH);
    // The real size is known now; keep the window clear of the other one.
    if (first) this.placeBesideOthers(e.win);
  }
}

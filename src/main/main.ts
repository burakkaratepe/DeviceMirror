import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import { findAdb } from './android/adb';
import { DeviceManager } from './deviceManager';
import { findIosHelper, iosSnapshot, shutdownIosHelpers } from './ios/iosCapture';
import { IosRunnerManager } from './ios/runner';
import { registerTouchSetup, SigningStore } from './ios/touchSetup';
import { MirrorManager } from './mirrorManager';
import { loadAndroidModels } from './modelNames';
import { Settings } from './settings';
import type { DeviceSnapshot, MirrorResult, Preview, Quality } from '../shared/types';

const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const PREVIEW_LONG_EDGE = 480; // px; card shows ~214 px tall, 2x for HiDPI
const SPLASH_MIN_MS = 1500; // splash stays at least this long, then the app comes forward if ready
const SPLASH_MAX_WAIT_MS = 4000; // never hold the main window back longer than this
const SPLASH_FADE_MS = 250;

/** Downscales a full screenshot to a small JPEG data URL (~20–40 KB). */
function makePreview(png: Buffer): Preview | undefined {
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) return undefined;
  const { width, height } = img.getSize();
  const scale = PREVIEW_LONG_EDGE / Math.max(width, height);
  const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img;
  const size = small.getSize();
  return { url: `data:image/jpeg;base64,${small.toJPEG(78).toString('base64')}`, width: size.width, height: size.height };
}

const resource = (name: string) =>
  app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), 'resources', name);

let win: BrowserWindow | undefined;
let splash: BrowserWindow | undefined;
let manager: DeviceManager | undefined;
let mirrors: MirrorManager | undefined;
let iosRunner: IosRunnerManager | undefined;

/** Device snapshot plus which devices currently have a mirror window. */
function snapshot(): DeviceSnapshot {
  const s = manager!.snapshot();
  return { ...s, devices: s.devices.map((d) => ({ ...d, mirroring: mirrors?.isMirroring(d.id) ?? false })) };
}

function pushSnapshot() {
  win?.webContents.send('devices:snapshot', snapshot());
}

/** Frameless, transparent window shown while the main window loads. */
function createSplash(): BrowserWindow {
  const s = new BrowserWindow({
    // Larger than the 300 px panel so its soft shadow is not clipped.
    width: 420,
    height: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    center: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  s.once('ready-to-show', () => s.show());
  void s.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  s.on('closed', () => { if (splash === s) splash = undefined; });
  return s;
}

function setSplashStatus(text: string) {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents
    .executeJavaScript(`document.querySelector('.status').textContent = ${JSON.stringify(text)}`)
    .catch(() => undefined);
}

function closeSplash() {
  const s = splash;
  splash = undefined;
  if (!s || s.isDestroyed()) return;
  void s.webContents.executeJavaScript(`document.body.classList.add('leaving')`).catch(() => undefined);
  setTimeout(() => { if (!s.isDestroyed()) s.close(); }, SPLASH_FADE_MS);
}

function createWindow(firstLaunch: boolean) {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Device Mirror',
    backgroundColor: '#141b2d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = undefined; });

  if (!firstLaunch) {
    win.once('ready-to-show', () => win?.show());
    return;
  }

  // Swap the splash for the main window once the UI is painted and the first
  // device list is in (or the max wait passes), but not before SPLASH_MIN_MS.
  const shownAt = Date.now();
  const uiReady = new Promise<void>((r) => win!.once('ready-to-show', () => r()));
  const devicesReady = new Promise<void>((r) => {
    const off = manager!.onSnapshot(() => { off(); r(); });
  });
  uiReady.then(() => setSplashStatus('Looking for devices…'));
  const timeout = new Promise<void>((r) => setTimeout(r, SPLASH_MAX_WAIT_MS));
  void Promise.race([Promise.all([uiReady, devicesReady]), timeout])
    .then(() => uiReady) // the window must be paintable before it is shown
    .then(() => new Promise((r) => setTimeout(r, Math.max(0, SPLASH_MIN_MS - (Date.now() - shownAt)))))
    .then(() => {
      win?.show();
      win?.focus();
      closeSplash();
    });
}

// One instance only: a second one would start a second touch runner for the
// same iPhone, and the two would knock each other off.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  splash = createSplash();

  const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  loadAndroidModels(resource('android-models.tsv.gz'));
  const iosHelper = () => findIosHelper(app.isPackaged ? process.resourcesPath : undefined);
  manager = new DeviceManager(settings, () => findAdb(app.isPackaged ? process.resourcesPath : undefined), makePreview, {
    mirror: process.platform === 'darwin' && !!iosHelper(),
    snapshot: process.platform === 'darwin' ? (udid, name) => iosSnapshot(iosHelper()!, udid, name) : undefined,
  });
  mirrors = new MirrorManager({
    serverJar: () => resource('scrcpy-server'),
    iosHelper,
    settings,
    findDevice: (id) => manager!.find(id),
    runnerRunning: (udid) => iosRunner?.isRunning(udid) ?? false,
    onChange: pushSnapshot,
  });
  // The runner's Xcode project ships with the app; it is built on first use.
  const runnerDir = app.isPackaged ? path.join(process.resourcesPath, 'ios-runner') : path.join(app.getAppPath(), 'native', 'ios-runner');
  const runner = new IosRunnerManager(runnerDir, path.join(app.getPath('userData'), 'ios-runner'));
  iosRunner = runner;
  registerTouchSetup({
    store: new SigningStore(path.join(app.getPath('userData'), 'signing')),
    logFile: path.join(app.getPath('userData'), 'ios-runner', 'setup.log'),
    runner,
    iconDir: path.join(runnerDir, 'Icon'),
    deviceFor: (wc) => mirrors!.deviceFor(wc),
    windowFor: (wc) => mirrors!.windowFor(wc),
    onRunnerReady: (deviceId, udid) => mirrors!.attachTouch(deviceId, udid),
  });

  manager.onSnapshot((s) => {
    mirrors!.syncDevices(s.devices);
    pushSnapshot();
  });
  manager.start();

  ipcMain.handle('devices:get', () => snapshot());
  ipcMain.handle('devices:setQuality', (_e, id: unknown, q: unknown) => {
    if (typeof id !== 'string' || !QUALITIES.includes(q as Quality)) return;
    mirrors!.setQuality(id, q as Quality);
  });
  ipcMain.handle('devices:mirror', (_e, id: unknown, replaceId: unknown): MirrorResult => {
    const device = typeof id === 'string' ? manager!.find(id) : undefined;
    if (!device) return { ok: false, reason: 'error', message: 'The device is no longer connected.' };
    if (device.mirrorUnavailableReason && !mirrors!.isMirroring(device.id)) return { ok: false, reason: 'error', message: device.mirrorUnavailableReason };
    return mirrors!.open(device, typeof replaceId === 'string' ? replaceId : undefined);
  });

  createWindow(true);
  app.on('activate', () => { if (!win) createWindow(false); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Also when the process is ended without a normal quit (Ctrl-C in a terminal).
process.on('exit', () => iosRunner?.stopAll());

app.on('before-quit', () => {
  mirrors?.closeAll();
  manager?.stop();
  shutdownIosHelpers();
  iosRunner?.stopAll();
});

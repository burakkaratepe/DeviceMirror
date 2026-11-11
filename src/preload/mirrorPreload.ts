import { contextBridge, ipcRenderer } from 'electron';
import type { MirrorInfo, MirrorStatus, MirrorVideo, MirrorWindowApi, Quality, SetupStep } from '../shared/types';

const api: MirrorWindowApi = {
  info: () => ipcRenderer.invoke('mirror:info'),
  onVideo: (cb) => { ipcRenderer.on('mirror:video', (_e, v: MirrorVideo) => cb(v)); },
  onStatus: (cb) => { ipcRenderer.on('mirror:status', (_e, s: MirrorStatus) => cb(s)); },
  onInfo: (cb) => { ipcRenderer.on('mirror:info', (_e, i: MirrorInfo) => cb(i)); },
  touch: (action, x, y) => ipcRenderer.send('mirror:touch', action, x, y),
  scroll: (x, y, h, v) => ipcRenderer.send('mirror:scroll', x, y, h, v),
  key: (code, meta) => ipcRenderer.send('mirror:key', code, meta ?? 0),
  hid: (report) => ipcRenderer.send('mirror:hid', report),
  keyboardSettings: () => ipcRenderer.send('mirror:keyboardSettings'),
  keyboardLayout: () => ipcRenderer.invoke('mirror:keyboardLayout'),
  paste: () => ipcRenderer.send('mirror:paste'),
  setQuality: (q: Quality) => ipcRenderer.send('mirror:quality', q),
  retry: () => ipcRenderer.send('mirror:retry'),
  savedIdentity: () => ipcRenderer.invoke('touch:saved'),
  pickFile: (kind) => ipcRenderer.invoke('touch:pick', kind),
  suggestProfile: () => ipcRenderer.invoke('touch:suggest'),
  inspectProfile: (p) => ipcRenderer.invoke('touch:inspect', p),
  checkSigning: (profile, p12, pw) => ipcRenderer.invoke('touch:check', profile, p12, pw),
  runSetup: () => ipcRenderer.invoke('touch:setup'),
  onSetupStep: (cb) => { ipcRenderer.on('touch:step', (_e, s: SetupStep) => cb(s)); },
  copyText: (text) => ipcRenderer.send('mirror:copy', text),
  windowAction: (action) => ipcRenderer.send('mirror:window', action),
  onTouch: (cb) => { ipcRenderer.on('mirror:touch', (_e, on: boolean) => cb(on)); },
  iosTap: (x, y, hold) => ipcRenderer.send('ios:tap', x, y, hold),
  iosGesture: (points) => ipcRenderer.send('ios:gesture', points),
  iosText: (text) => ipcRenderer.send('ios:text', text),
  iosHome: () => ipcRenderer.send('ios:home'),
  iosButton: (which) => ipcRenderer.send('ios:button', which),
  iosTouchOff: () => ipcRenderer.send('ios:touchOff'),
};

contextBridge.exposeInMainWorld('mirror', api);

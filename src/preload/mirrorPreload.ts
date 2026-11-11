import { contextBridge, ipcRenderer } from 'electron';
import type { MirrorInfo, MirrorStatus, MirrorVideo, MirrorWindowApi, Quality } from '../shared/types';

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
};

contextBridge.exposeInMainWorld('mirror', api);

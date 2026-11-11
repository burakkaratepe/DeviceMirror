import { contextBridge, ipcRenderer } from 'electron';
import type { DeviceMirrorApi, DeviceSnapshot, Quality } from '../shared/types';

const api: DeviceMirrorApi = {
  getSnapshot: () => ipcRenderer.invoke('devices:get'),
  onSnapshot: (cb) => {
    const handler = (_e: unknown, s: DeviceSnapshot) => cb(s);
    ipcRenderer.on('devices:snapshot', handler);
    return () => ipcRenderer.off('devices:snapshot', handler);
  },
  setQuality: (id: string, q: Quality) => ipcRenderer.invoke('devices:setQuality', id, q),
  mirror: (id: string, replaceId?: string) => ipcRenderer.invoke('devices:mirror', id, replaceId),
  setDevicesPageShown: (shown) => ipcRenderer.send('devices:pageShown', shown),
  listCaptures: () => ipcRenderer.invoke('captures:list'),
  onCapturesChanged: (cb) => { ipcRenderer.on('captures:changed', () => cb()); },
  downloadCapture: (id) => ipcRenderer.invoke('captures:download', id),
  deleteCapture: (id) => ipcRenderer.invoke('captures:delete', id),
  deleteAllCaptures: () => ipcRenderer.invoke('captures:deleteAll'),
  revealCapture: (id) => ipcRenderer.send('captures:reveal', id),
  platform: process.platform,
  onShowCaptures: (cb) => { ipcRenderer.on('captures:show', () => cb()); },
};

contextBridge.exposeInMainWorld('deviceMirror', api);

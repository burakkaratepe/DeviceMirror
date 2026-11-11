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
  mirror: (id: string) => ipcRenderer.invoke('devices:mirror', id),
};

contextBridge.exposeInMainWorld('deviceMirror', api);

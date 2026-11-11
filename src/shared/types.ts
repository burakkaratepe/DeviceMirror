// Types shared by the main process, preload and renderer.

export type Platform = 'android' | 'ios';

export type DeviceState =
  | 'ready' // connected and authorized
  | 'unauthorized' // Android: USB debugging not allowed yet
  | 'offline' // Android: adb reports the device offline
  | 'notTrusted' // iOS: "Trust This Computer" not accepted yet
  | 'connecting'; // seen, details still loading

export type Quality = 'low' | 'medium' | 'high';

export interface Device {
  /** Stable key: `${platform}:${serial}` */
  id: string;
  platform: Platform;
  /** adb serial or iOS UDID */
  serial: string;
  name: string;
  model?: string;
  osVersion?: string;
  state: DeviceState;
  quality: Quality;
  /** Screenshot taken once when the device became ready. */
  preview?: Preview;
  /** Display was off when the preview would have been taken. */
  screenOff?: boolean;
  /** Why the Mirror button is disabled; undefined when mirroring is possible. */
  mirrorUnavailableReason?: string;
}

export interface Preview {
  /** Small JPEG as a data: URL */
  url: string;
  width: number;
  height: number;
}

export interface ServiceStatus {
  ok: boolean;
  /** Human readable (English) problem description when !ok. */
  message?: string;
}

export interface DeviceSnapshot {
  devices: Device[];
  services: { android: ServiceStatus; ios: ServiceStatus };
}

export interface DeviceMirrorApi {
  getSnapshot(): Promise<DeviceSnapshot>;
  onSnapshot(cb: (s: DeviceSnapshot) => void): () => void;
  setQuality(deviceId: string, quality: Quality): Promise<void>;
  mirror(deviceId: string): Promise<void>;
}

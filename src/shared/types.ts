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
  /** A mirror window is open for this device. */
  mirroring?: boolean;
}

export type MirrorResult =
  | { ok: true }
  | { ok: false; reason: 'limit'; active: { id: string; name: string }[] }
  | { ok: false; reason: 'error'; message: string };

/** Messages from the main process to a mirror window. */
export type MirrorVideo =
  | { type: 'codec'; codec: string }
  | { type: 'size'; width: number; height: number }
  | { type: 'packet'; data: Uint8Array; key: boolean; pts: number };

export type MirrorStatus =
  | { state: 'connecting' }
  | { state: 'live' }
  | { state: 'error'; message: string };

export interface MirrorInfo { deviceId: string; name: string; quality: Quality }

export interface MirrorWindowApi {
  info(): Promise<MirrorInfo>;
  onVideo(cb: (v: MirrorVideo) => void): void;
  onStatus(cb: (s: MirrorStatus) => void): void;
  onInfo(cb: (i: MirrorInfo) => void): void;
  touch(action: 0 | 1 | 2, x: number, y: number): void;
  scroll(x: number, y: number, h: number, v: number): void;
  key(keycode: number, metaState?: number): void;
  text(text: string): void;
  /** Pastes the computer's clipboard into the device. */
  paste(): void;
  setQuality(q: Quality): void;
  retry(): void;
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
  /** Opens (or focuses) a mirror window; `replaceId` closes that mirror first. */
  mirror(deviceId: string, replaceId?: string): Promise<MirrorResult>;
}

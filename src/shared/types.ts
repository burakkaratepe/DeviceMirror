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
  /** Model code (SM-G990E, iPhone14,5). */
  model?: string;
  /** Retail name when known (iOS: from the product type; Android names already use it). */
  marketingName?: string;
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
  /** Connected but no picture yet (an iPhone with its screen off); message says what to do. */
  | { state: 'waiting'; message: string }
  | { state: 'error'; message: string };

export interface MirrorInfo { deviceId: string; serial: string; name: string; platform: Platform; quality: Quality }

/** What a saved / just-checked signing identity looks like to the user. */
export interface StoredIdentitySummary { certificate: string; team: string; profile: string; expires: string; source: 'keychain' | 'p12' }

/** A profile as the signing dialog sees it; keychainCertificate is set when no .p12 is needed. */
export interface ProfileInspection { path: string; name: string; keychainCertificate?: string }

export interface SigningResult { ok: boolean; problems: string[]; identity?: StoredIdentitySummary }

export type SetupStepId = 'trust' | 'developerMode' | 'sign' | 'install' | 'launch';
export interface SetupStep { id: SetupStepId; state: 'pending' | 'running' | 'done' | 'error'; detail?: string }

export interface MirrorWindowApi {
  info(): Promise<MirrorInfo>;
  onVideo(cb: (v: MirrorVideo) => void): void;
  onStatus(cb: (s: MirrorStatus) => void): void;
  onInfo(cb: (i: MirrorInfo) => void): void;
  /** Android MotionEvent action: 0 down, 1 up, 2 move, 7 hover move, 9 hover enter, 10 hover exit. */
  touch(action: 0 | 1 | 2 | 7 | 9 | 10, x: number, y: number): void;
  scroll(x: number, y: number, h: number, v: number): void;
  key(keycode: number, metaState?: number): void;
  /** 8-byte HID keyboard report for the device's virtual hardware keyboard. */
  hid(report: Uint8Array): void;
  /** Opens the device's physical keyboard layout settings. */
  keyboardSettings(): void;
  /** Layout Android uses for the virtual keyboard (undefined until it exists). */
  keyboardLayout(): Promise<{ id: string; label: string } | undefined>;
  /** Pastes the computer's clipboard into the device. */
  paste(): void;
  setQuality(q: Quality): void;
  retry(): void;
  // iOS touch control setup (Phase 4 UI; Phase 5 makes the steps real)
  savedIdentity(): Promise<StoredIdentitySummary | undefined>;
  pickFile(kind: 'p12' | 'profile'): Promise<string | undefined>;
  /** A profile on this Mac that already works for the device with a keychain certificate. */
  suggestProfile(): Promise<ProfileInspection | undefined>;
  inspectProfile(path: string): Promise<ProfileInspection | { error: string }>;
  /** Without p12Path the profile's certificate is taken from the macOS keychain. */
  checkSigning(profilePath: string, p12Path?: string, password?: string): Promise<SigningResult>;
  runSetup(): Promise<void>;
  onSetupStep(cb: (s: SetupStep) => void): void;
  copyText(text: string): void;
  windowAction(action: 'close' | 'minimize'): void;
  // iOS touch control (once the runner is connected)
  onTouch(cb: (on: boolean) => void): void;
  /** Short messages from the main process (shown as a toast). */
  onNotice(cb: (text: string) => void): void;
  iosTap(x: number, y: number, holdSeconds: number): void;
  iosGesture(points: { x: number; y: number; t: number }[]): void;
  iosText(text: string): void;
  iosHome(): void;
  iosButton(which: 'volumeUp' | 'volumeDown' | 'lock'): void;
  saveScreenshot(image: Uint8Array, ext: 'webp' | 'png', thumb: Uint8Array | undefined, width: number, height: number): Promise<Capture | undefined>;
  recStart(mime: string, width: number, height: number): Promise<string | undefined>;
  recChunk(id: string, chunk: Uint8Array): void;
  recStop(id: string, durationMs: number, thumb?: Uint8Array): Promise<Capture | undefined>;
  showCaptures(): void;
  /** Disconnects touch control; the runner keeps running for a quick restart. */
  iosTouchOff(): void;
  notice?(text: string): void;
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

export type CaptureKind = 'screenshot' | 'video';

/** A screenshot or screen recording saved from a mirror window. */
export interface Capture {
  id: string;
  kind: CaptureKind;
  /** File name in the captures folder (served as dm-capture://files/<file>). */
  file: string;
  thumb?: string;
  /** Device the capture came from: Device.id ("ios:<UDID>" / "android:<serial>") and its UDID / serial. */
  deviceId: string;
  serial: string;
  deviceName: string;
  platform: 'android' | 'ios';
  width: number;
  height: number;
  size: number;
  durationMs?: number;
  createdAt: string;
}

export interface DeviceMirrorApi {
  getSnapshot(): Promise<DeviceSnapshot>;
  onSnapshot(cb: (s: DeviceSnapshot) => void): () => void;
  setQuality(deviceId: string, quality: Quality): Promise<void>;
  /** Opens (or focuses) a mirror window; `replaceId` closes that mirror first. */
  mirror(deviceId: string, replaceId?: string): Promise<MirrorResult>;
  listCaptures(): Promise<Capture[]>;
  onCapturesChanged(cb: () => void): void;
  /** Saves a copy where the user picks; false when cancelled. */
  downloadCapture(id: string): Promise<boolean>;
  deleteCapture(id: string): Promise<void>;
  deleteAllCaptures(): Promise<void>;
  /** A mirror window asked to show the captures (e.g. its screenshot thumbnail was clicked). */
  onShowCaptures(cb: () => void): void;
}

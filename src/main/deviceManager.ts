// Merges Android (adb) and iOS (usbmuxd) device events into one list and
// pushes snapshots to listeners whenever anything changes.

import { AdbTracker, isScreenOn, screenshotPng, shell, type AdbDeviceEntry } from './android/adb';
import { hasPairRecord, lockdownGetValues, UsbmuxListener, type UsbmuxDevice } from './ios/usbmux';
import type { Settings } from './settings';
import type { Device, DeviceSnapshot, DeviceState, Preview, ServiceStatus } from '../shared/types';

const MIRROR_COMING = 'Mirroring is coming in the next update.';
const IOS_PLATFORM_COMING = 'iOS mirroring on this platform is coming soon.';
const TRUST_POLL_MS = 2000;

interface AndroidDetails { name: string; model?: string; osVersion?: string }
interface IosEntry { usb: UsbmuxDevice; device: Device; trustTimer?: NodeJS.Timeout }

export class DeviceManager {
  private android = new Map<string, Device>();
  private androidDetails = new Map<string, AndroidDetails>();
  private androidPending = new Set<string>();
  private ios = new Map<number, IosEntry>();
  private services: DeviceSnapshot['services'] = { android: { ok: true }, ios: { ok: true } };
  private listeners = new Set<(s: DeviceSnapshot) => void>();
  private emitTimer: NodeJS.Timeout | undefined;
  private adb: AdbTracker;
  private usbmux: UsbmuxListener;

  private androidPreview = new Map<string, { preview?: Preview; screenOff?: boolean }>();

  /**
   * @param makePreview turns a full PNG screenshot into a small preview; the
   *   Electron main process passes a nativeImage-based encoder. Without it no
   *   screenshots are taken (e.g. in the headless probe).
   */
  constructor(
    private settings: Settings,
    resolveAdb: () => string | undefined,
    private makePreview?: (png: Buffer) => Preview | undefined,
  ) {
    this.adb = new AdbTracker(
      {
        onDevices: (list) => this.onAndroidList(list),
        onStatus: (ok, message) => this.setService('android', { ok, message }),
      },
      resolveAdb,
    );
    this.usbmux = new UsbmuxListener({
      onAttached: (d) => this.onIosAttached(d),
      onDetached: (id) => this.onIosDetached(id),
      onStatus: (ok, message) => this.setService('ios', { ok, message }),
      onReset: () => { for (const id of [...this.ios.keys()]) this.onIosDetached(id); },
    });
  }

  start() { this.adb.start(); this.usbmux.start(); }

  stop() {
    this.adb.stop();
    this.usbmux.stop();
    for (const e of this.ios.values()) clearTimeout(e.trustTimer);
  }

  onSnapshot(cb: (s: DeviceSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  snapshot(): DeviceSnapshot {
    const devices = [...this.android.values(), ...[...this.ios.values()].map((e) => e.device)]
      .map((d) => ({ ...d, quality: this.settings.quality(d.id) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { devices, services: this.services };
  }

  find(deviceId: string): Device | undefined {
    return this.snapshot().devices.find((d) => d.id === deviceId);
  }

  private setService(key: 'android' | 'ios', s: ServiceStatus) {
    const cur = this.services[key];
    if (cur.ok === s.ok && cur.message === s.message) return;
    this.services = { ...this.services, [key]: s };
    this.emit();
  }

  private emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => {
      const snap = this.snapshot();
      for (const l of this.listeners) l(snap);
    }, 30);
  }

  // ---- Android -----------------------------------------------------------

  private onAndroidList(list: AdbDeviceEntry[]) {
    const next = new Map<string, Device>();
    for (const e of list) {
      const id = `android:${e.serial}`;
      const state = androidState(e.state);
      const details = this.androidDetails.get(e.serial);
      const shot = this.androidPreview.get(e.serial);
      next.set(id, {
        preview: state === 'ready' ? shot?.preview : undefined,
        screenOff: state === 'ready' ? shot?.screenOff : undefined,
        id,
        platform: 'android',
        serial: e.serial,
        name: details?.name ?? prettyModel(e.props.model) ?? e.serial,
        model: details?.model ?? prettyModel(e.props.model),
        osVersion: details?.osVersion,
        state: state === 'ready' && !details ? 'connecting' : state,
        quality: 'medium',
        mirrorUnavailableReason: reasonFor(state) ?? MIRROR_COMING,
      });
      if (state === 'ready' && !details) void this.loadAndroidDetails(e.serial);
    }
    // forget cached details of unplugged devices so a re-plug reloads them
    for (const serial of [...this.androidDetails.keys(), ...this.androidPreview.keys()]) {
      if (!next.has(`android:${serial}`)) { this.androidDetails.delete(serial); this.androidPreview.delete(serial); }
    }
    this.android = next;
    this.emit();
  }

  private async loadAndroidDetails(serial: string) {
    if (this.androidPending.has(serial)) return;
    this.androidPending.add(serial);
    try {
      const out = await shell(serial, 'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release');
      const [manufacturer = '', model = '', release = ''] = out.split(/\r?\n/).map((s) => s.trim());
      const name = [capitalize(manufacturer), model].filter(Boolean).join(' ') || serial;
      this.androidDetails.set(serial, { name, model: model || undefined, osVersion: release ? `Android ${release}` : undefined });
    } catch {
      this.androidDetails.set(serial, { name: serial });
    } finally {
      this.androidPending.delete(serial);
    }
    const id = `android:${serial}`;
    const cur = this.android.get(id);
    const d = this.androidDetails.get(serial)!;
    if (cur) {
      this.android.set(id, { ...cur, name: d.name, model: d.model ?? cur.model, osVersion: d.osVersion, state: cur.state === 'connecting' ? 'ready' : cur.state });
      this.emit();
      void this.captureAndroidPreview(serial);
    }
  }

  /** One screenshot per connection, taken when the device becomes ready. */
  private async captureAndroidPreview(serial: string) {
    if (!this.makePreview || this.androidPreview.has(serial)) return;
    this.androidPreview.set(serial, {}); // mark as in progress / done
    let result: { preview?: Preview; screenOff?: boolean } = {};
    try {
      if (!(await isScreenOn(serial))) result = { screenOff: true };
      else result = { preview: this.makePreview(await screenshotPng(serial)) };
    } catch {
      // screenshot failed (secure screen, device busy): keep the illustration
    }
    if (!this.androidPreview.has(serial)) return; // unplugged meanwhile
    this.androidPreview.set(serial, result);
    const id = `android:${serial}`;
    const cur = this.android.get(id);
    if (cur?.state === 'ready') {
      this.android.set(id, { ...cur, ...result });
      this.emit();
    }
  }

  // ---- iOS ---------------------------------------------------------------

  private onIosAttached(usb: UsbmuxDevice) {
    if (usb.connectionType !== 'USB' || !usb.udid) return; // Wi-Fi sync devices are out of scope
    const id = `ios:${usb.udid}`;
    // usbmuxd can report the same UDID twice (USB + network); keep one entry
    for (const [k, e] of this.ios) if (e.device.id === id) { clearTimeout(e.trustTimer); this.ios.delete(k); }
    this.ios.set(usb.deviceId, {
      usb,
      device: { id, platform: 'ios', serial: usb.udid, name: 'iOS device', state: 'connecting', quality: 'medium', mirrorUnavailableReason: MIRROR_COMING },
    });
    this.emit();
    void this.refreshIos(usb.deviceId, true);
  }

  private onIosDetached(deviceId: number) {
    const e = this.ios.get(deviceId);
    if (!e) return;
    clearTimeout(e.trustTimer);
    this.ios.delete(deviceId);
    this.emit();
  }

  private async refreshIos(deviceId: number, loadInfo: boolean) {
    const entry = this.ios.get(deviceId);
    if (!entry) return;
    let paired = false;
    try { paired = await hasPairRecord(entry.usb.udid); } catch { /* treat as not paired */ }
    let info: Record<string, unknown> = {};
    if (loadInfo || paired) {
      try { info = await lockdownGetValues(deviceId, ['DeviceName', 'ProductType', 'ProductVersion']); } catch { /* locked or not trusted */ }
    }
    const cur = this.ios.get(deviceId);
    if (!cur) return; // unplugged meanwhile
    const state: DeviceState = paired ? 'ready' : 'notTrusted';
    cur.device = {
      ...cur.device,
      name: typeof info.DeviceName === 'string' ? info.DeviceName : cur.device.name,
      model: typeof info.ProductType === 'string' ? info.ProductType : cur.device.model,
      osVersion: typeof info.ProductVersion === 'string' ? `iOS ${info.ProductVersion}` : cur.device.osVersion,
      state,
      mirrorUnavailableReason: reasonFor(state) ?? (process.platform === 'darwin' ? MIRROR_COMING : IOS_PLATFORM_COMING),
    };
    this.emit();
    if (!paired) cur.trustTimer = setTimeout(() => void this.refreshIos(deviceId, false), TRUST_POLL_MS);
  }
}

function androidState(s: string): DeviceState {
  if (s === 'device') return 'ready';
  if (s === 'unauthorized') return 'unauthorized';
  if (s === 'offline') return 'offline';
  return 'connecting'; // authorizing, connecting, recovery, ...
}

function reasonFor(state: DeviceState): string | undefined {
  switch (state) {
    case 'unauthorized': return 'Allow USB debugging on the device.';
    case 'offline': return 'The device is offline. Reconnect the cable.';
    case 'notTrusted': return 'Unlock the device and tap "Trust This Computer".';
    case 'connecting': return 'Connecting…';
    default: return undefined;
  }
}

const prettyModel = (m?: string) => (m ? m.replace(/_/g, ' ') : undefined);
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

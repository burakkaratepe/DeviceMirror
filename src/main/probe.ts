// Headless check of device tracking: `npm run probe [seconds]`.
// Prints every snapshot change; plug and unplug devices while it runs.

import { findAdb } from './android/adb';
import { DeviceManager } from './deviceManager';
import { Settings } from './settings';

const seconds = Number(process.argv[2] ?? 8);
// No image library here: report the screenshot size instead of encoding it.
const manager = new DeviceManager(new Settings(undefined), () => findAdb(), (png) => ({ url: '', width: png.length, height: 0 }));
const t0 = Date.now();
manager.onSnapshot((s) => {
  const t = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[${t}s] android=${s.services.android.ok ? 'ok' : s.services.android.message} ios=${s.services.ios.ok ? 'ok' : s.services.ios.message}`);
  for (const d of s.devices) console.log(`   ${d.platform.padEnd(7)} ${d.state.padEnd(11)} ${d.name} | ${d.model ?? '-'} | ${d.osVersion ?? '-'} | ${d.serial}${d.preview ? ` | screenshot ${d.preview.width} bytes` : ''}${d.screenOff ? ' | screen off' : ''}`);
  if (!s.devices.length) console.log('   (no devices)');
});
manager.start();
setTimeout(() => { manager.stop(); process.exit(0); }, seconds * 1000);

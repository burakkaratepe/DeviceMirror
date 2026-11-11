// Headless check of Android mirroring: `node dist/probeMirror.js <serial> [seconds] [quality]`.
// Prints the negotiated codec/size and frame statistics; sends no input.

import path from 'node:path';
import { AndroidMirrorSession, QUALITY_PARAMS } from './android/scrcpy';
import type { Quality } from '../shared/types';

const [serial, secs = '4', q = 'medium'] = process.argv.slice(2);
if (!serial) { console.error('usage: probeMirror <serial> [seconds] [low|medium|high]'); process.exit(2); }

const t0 = Date.now();
let frames = 0, keys = 0, bytes = 0, first = 0;
const session = new AndroidMirrorSession(serial, path.join(process.cwd(), 'resources', 'scrcpy-server'), QUALITY_PARAMS[q as Quality], {
  onVideo(e) {
    if (e.type === 'packet') {
      frames++; bytes += e.data.length; if (e.key) keys++;
      if (!first) { first = Date.now() - t0; console.log(`first frame after ${first} ms (${e.data.length} bytes, key=${e.key})`); }
    } else console.log(`[${Date.now() - t0} ms]`, e);
  },
  onDeviceName: (n) => console.log(`[${Date.now() - t0} ms] device name: ${n}`),
  onClosed: (err) => console.log('closed', err?.message ?? ''),
});
session.start().then(
  () => console.log(`[${Date.now() - t0} ms] started`),
  (e) => { console.error('start failed:', e.message); process.exit(1); },
);
setTimeout(() => {
  const s = (Date.now() - t0 - first) / 1000;
  console.log(`frames=${frames} key=${keys} fps≈${(frames / s).toFixed(1)} kbps≈${((bytes * 8) / s / 1000).toFixed(0)}`);
  session.close();
  setTimeout(() => process.exit(0), 200);
}, Number(secs) * 1000);

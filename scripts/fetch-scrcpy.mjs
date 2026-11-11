// Downloads the pinned scrcpy-server (Apache-2.0) used for Android mirroring.
// The client protocol in src/main/android/scrcpy.ts must match this version.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

export const SCRCPY_VERSION = '5.0.1';
const SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const url = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;

console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const hash = createHash('sha256').update(buf).digest('hex');
if (hash !== SHA256) throw new Error(`sha256 mismatch: ${hash}`);
mkdirSync('resources', { recursive: true });
writeFileSync('resources/scrcpy-server', buf);
console.log(`scrcpy-server ${SCRCPY_VERSION} ready (${buf.length} bytes, sha256 ${hash})`);

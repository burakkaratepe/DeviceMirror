// Downloads Google's platform-tools for a target platform and keeps only the
// files adb needs (~6–12 MB instead of the full ~40 MB package).
// Usage: node scripts/fetch-adb.mjs [mac|win|linux] [arch]
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const platform = process.argv[2] ?? (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux');
const arch = process.argv[3] ?? process.arch;
const googleName = { mac: 'darwin', win: 'windows', linux: 'linux' }[platform];
const keep = { mac: ['adb'], linux: ['adb'], win: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'] }[platform];
if (!googleName) throw new Error(`unknown platform ${platform}`);

const url = `https://dl.google.com/android/repository/platform-tools-latest-${googleName}.zip`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'adb-'));
const zip = path.join(tmp, 'pt.zip');
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

const extract = path.join(tmp, 'x');
mkdirSync(extract);
if (process.platform === 'linux') execFileSync('unzip', ['-q', zip, '-d', extract]);
else execFileSync('tar', ['-xf', zip, '-C', extract]);

// macOS platform-tools ships a universal adb, so one binary serves both arches.
const out = path.join('resources', 'bin', `${platform}-${arch}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of keep) {
  cpSync(path.join(extract, 'platform-tools', f), path.join(out, f));
  if (!f.endsWith('.dll')) chmodSync(path.join(out, f), 0o755);
}
cpSync(path.join(extract, 'platform-tools', 'NOTICE.txt'), path.join(out, 'adb-NOTICE.txt'));
rmSync(tmp, { recursive: true, force: true });
console.log(`adb ready in ${out}`);

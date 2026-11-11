// Builds, signs, installs and starts the iOS touch runner (macOS, needs Xcode
// for now: xcodebuild compiles the runner once and starts the XCTest session).
//
//   build   xcodebuild build-for-testing, unsigned, cached per Xcode version
//           and runner source; the first run takes ~30 s, later ones none.
//   sign    codesign with the keychain identity, or with a .p12 imported into
//           a throwaway keychain that is deleted right after.
//   install devicectl
//   launch  xcodebuild test-without-building (keeps running while touch is on)

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlist, type PlistValue } from '../plist';
import type { ProfileInfo } from './signing';

const run = (cmd: string, args: string[], opts: { timeout?: number } = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 10 * 60 * 1000 }, (err, stdout, stderr) =>
      err ? reject(new Error(lastLines(`${stdout}\n${stderr}`) || err.message)) : resolve(stdout)));

const lastLines = (s: string) => s.split('\n').filter((l) => /error|fail|denied|not /i.test(l)).slice(-3).join(' ').trim();

export type SigningSource =
  | { kind: 'keychain'; sha1: string }
  | { kind: 'p12'; p12: Buffer; password: string; sha1: string };

export class RunnerError extends Error {}

export class IosRunnerManager {
  private sessions = new Map<string, ChildProcess>();
  /** Diagnostic lines (runner start / exit). */
  onLog?: (line: string) => void;

  constructor(private projectDir: string, private cacheDir: string) {}

  /** Xcode version string, or undefined when Xcode is not installed. */
  async xcodeVersion(): Promise<string | undefined> {
    if (process.platform !== 'darwin') return undefined;
    try {
      return (await run('/usr/bin/xcrun', ['xcodebuild', '-version'], { timeout: 30000 })).split('\n')[0].trim();
    } catch {
      return undefined;
    }
  }

  /** true / false when known; undefined when it could not be read. */
  async developerMode(udid: string): Promise<boolean | undefined> {
    const out = path.join(os.tmpdir(), `dm-devinfo-${randomBytes(4).toString('hex')}.json`);
    try {
      await run('/usr/bin/xcrun', ['devicectl', 'device', 'info', 'details', '--device', udid, '--json-output', out], { timeout: 30000 });
      const json = JSON.parse(readFileSync(out, 'utf8'));
      const status = json?.result?.deviceProperties?.developerModeStatus;
      return status === undefined ? undefined : status === 'enabled';
    } catch {
      return undefined;
    } finally {
      rmSync(out, { force: true });
    }
  }

  /** Identifies the runner source + Xcode version (the build cache key). */
  buildHash(xcode: string): string {
    const hash = createHash('sha1').update(xcode);
    for (const f of ['DMRunner/DMRunnerTests.m', 'DMRunner/XCTestPrivate.h', 'DeviceMirrorRunner.xcodeproj/project.pbxproj']) {
      hash.update(readFileSync(path.join(this.projectDir, f)));
    }
    const icons = path.join(this.projectDir, 'Icon');
    for (const f of existsSync(icons) ? readdirSync(icons).sort() : []) hash.update(readFileSync(path.join(icons, f)));
    return hash.digest('hex').slice(0, 12);
  }

  /** Version stamp for a signed runner: same build + profile + certificate → same stamp. */
  stamp(xcode: string, profile: ProfileInfo, source: SigningSource): string {
    const h = createHash('sha1').update(this.buildHash(xcode)).update(profile.uuid).update(source.sha1).digest();
    return `1.${h.readUInt32BE(0)}`; // CFBundleVersion: digits and dots only
  }

  /** The signed work folder from an earlier run, if it carries this stamp. */
  signedFor(stamp: string): string | undefined {
    const work = path.join(this.cacheDir, 'signed');
    try {
      const marker = JSON.parse(readFileSync(path.join(work, 'stamp.json'), 'utf8')) as { stamp: string };
      const xctestrun = path.join(work, 'runner.xctestrun');
      return marker.stamp === stamp && existsSync(xctestrun) ? xctestrun : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * CFBundleVersion of the runner installed on the device; null when it is
   * not installed, undefined when the device could not be asked.
   */
  async installedVersion(udid: string, xctestrun: string): Promise<string | null | undefined> {
    const app = path.join(path.dirname(xctestrun), 'Release-iphoneos', 'DeviceMirrorRunner-Runner.app');
    const bundleId = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Info.plist')])).trim();
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = path.join(os.tmpdir(), `dm-apps-${randomBytes(4).toString('hex')}.json`);
      try {
        await run('/usr/bin/xcrun', ['devicectl', 'device', 'info', 'apps', '--device', udid, '--bundle-id', bundleId, '--json-output', out], { timeout: 30000 });
        const apps = JSON.parse(readFileSync(out, 'utf8'))?.result?.apps ?? [];
        return apps[0]?.bundleVersion ?? null;
      } catch {
        await new Promise((r) => setTimeout(r, 1000)); // e.g. the device re-enumerated on USB
      } finally {
        rmSync(out, { force: true });
      }
    }
    return undefined;
  }

  /** Unsigned runner products for this Xcode + source (built once). */
  async build(xcode: string): Promise<{ app: string; xctestrun: string }> {
    const dir = path.join(this.cacheDir, `build-${this.buildHash(xcode)}`);
    const products = path.join(dir, 'Build', 'Products');
    const find = () => {
      if (!existsSync(products)) return undefined;
      const xctestrun = readdirSync(products).find((f) => f.endsWith('.xctestrun'));
      const app = path.join(products, 'Release-iphoneos', 'DeviceMirrorRunner-Runner.app');
      return xctestrun && existsSync(app) ? { app, xctestrun: path.join(products, xctestrun) } : undefined;
    };
    const cached = find();
    if (cached) return cached;
    // Build from a copy so the app bundle's resources stay read-only.
    const src = path.join(dir, 'src');
    rmSync(dir, { recursive: true, force: true });
    cpSync(this.projectDir, src, { recursive: true });
    await run('/usr/bin/xcrun', [
      'xcodebuild', 'build-for-testing', '-quiet',
      '-project', path.join(src, 'DeviceMirrorRunner.xcodeproj'), '-scheme', 'DeviceMirrorRunner',
      '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-derivedDataPath', dir,
      'CODE_SIGNING_ALLOWED=NO',
    ]);
    const built = find();
    if (!built) throw new RunnerError('Building the touch helper failed.');
    // Builds for older runner sources or Xcode versions are no longer used.
    for (const f of readdirSync(this.cacheDir)) {
      if (f.startsWith('build-') && path.join(this.cacheDir, f) !== dir) rmSync(path.join(this.cacheDir, f), { recursive: true, force: true });
    }
    return built;
  }

  /** Copies the products to a work folder and signs them for this profile. */
  async sign(built: { app: string; xctestrun: string }, profile: ProfileInfo, profileData: Buffer, source: SigningSource, stamp: string, iconDir?: string): Promise<string> {
    const work = path.join(this.cacheDir, 'signed');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(path.join(work, 'Release-iphoneos'), { recursive: true });
    const app = path.join(work, 'Release-iphoneos', 'DeviceMirrorRunner-Runner.app');
    cpSync(built.app, app, { recursive: true });
    const xctestrun = path.join(work, 'runner.xctestrun');
    cpSync(built.xctestrun, xctestrun);
    // A DSTROOT entry makes xcodebuild try a "root install", which devices refuse.
    await run('/usr/bin/plutil', ['-remove', 'TestConfigurations.0.TestTargets.0.DSTROOTPath', xctestrun]).catch(() => undefined);

    // Bundle id: the default works with wildcard profiles; explicit app ids get theirs.
    const appIdPrefix = `${profile.teamId}.`;
    const explicitId = profile.appIdentifier.startsWith(appIdPrefix) && !profile.appIdentifier.endsWith('*')
      ? profile.appIdentifier.slice(appIdPrefix.length) : undefined;
    const infoPlist = path.join(app, 'Info.plist');
    if (explicitId) {
      await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', explicitId, infoPlist]);
      await run('/usr/bin/plutil', ['-replace', 'TestConfigurations.0.TestTargets.0.TestHostBundleIdentifier', '-string', explicitId, xctestrun]);
    }
    const bundleId = explicitId ?? (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', infoPlist])).trim();
    await run('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Device Mirror', infoPlist]);
    await run('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', stamp, infoPlist]);
    if (iconDir) await this.applyIcon(app, iconDir);

    // Entitlements = the profile's, with this bundle id.
    const ent: Record<string, PlistValue> = { ...profile.entitlements, 'application-identifier': `${profile.teamId}.${bundleId}` };
    const entFile = path.join(work, 'entitlements.plist');
    writeFileSync(entFile, buildPlist(ent));
    writeFileSync(path.join(app, 'embedded.mobileprovision'), profileData);

    const keychain = source.kind === 'p12' ? await this.tempKeychain(source.p12, source.password) : undefined;
    try {
      const sign = (target: string, extra: string[] = []) =>
        run('/usr/bin/codesign', ['--force', '--sign', source.sha1, '--timestamp=none', ...(keychain ? ['--keychain', keychain.file] : []), ...extra, target]);
      const fw = path.join(app, 'Frameworks');
      for (const f of existsSync(fw) ? readdirSync(fw) : []) await sign(path.join(fw, f));
      for (const f of readdirSync(path.join(app, 'PlugIns'))) await sign(path.join(app, 'PlugIns', f));
      await sign(app, ['--entitlements', entFile, '--generate-entitlement-der']);
    } finally {
      if (keychain) await run('/usr/bin/security', ['delete-keychain', keychain.file]).catch(() => undefined);
    }
    writeFileSync(path.join(work, 'stamp.json'), JSON.stringify({ stamp }));
    return xctestrun;
  }

  /** Imports a .p12 into a throwaway, unlocked keychain codesign can use without prompts. */
  private async tempKeychain(p12: Buffer, password: string): Promise<{ file: string }> {
    const file = path.join(os.tmpdir(), `dm-signing-${randomBytes(6).toString('hex')}.keychain-db`);
    const kcPass = randomBytes(16).toString('hex');
    const p12File = path.join(os.tmpdir(), `dm-${randomBytes(6).toString('hex')}.p12`);
    writeFileSync(p12File, p12, { mode: 0o600 });
    try {
      await run('/usr/bin/security', ['create-keychain', '-p', kcPass, file]);
      await run('/usr/bin/security', ['set-keychain-settings', file]);
      await run('/usr/bin/security', ['unlock-keychain', '-p', kcPass, file]);
      await run('/usr/bin/security', ['import', p12File, '-k', file, '-P', password, '-T', '/usr/bin/codesign']);
      await run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', kcPass, file]);
      return { file };
    } finally {
      rmSync(p12File, { force: true });
    }
  }

  /** Gives the runner the Device Mirror home-screen icon. */
  private async applyIcon(app: string, iconDir: string) {
    const files = readdirSync(iconDir).filter((f) => f.startsWith('AppIcon') && f.endsWith('.png'));
    if (!files.length) return;
    for (const f of files) cpSync(path.join(iconDir, f), path.join(app, f));
    const info = path.join(app, 'Info.plist');
    const icons = { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60', 'AppIcon76x76'], CFBundleIconName: 'AppIcon' } };
    const json = JSON.stringify(icons);
    await run('/usr/bin/plutil', ['-replace', 'CFBundleIcons', '-json', json, info]);
    await run('/usr/bin/plutil', ['-replace', 'CFBundleIcons~ipad', '-json', json, info]);
  }

  async install(udid: string, xctestrun: string) {
    const app = path.join(path.dirname(xctestrun), 'Release-iphoneos', 'DeviceMirrorRunner-Runner.app');
    await run('/usr/bin/xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, app], { timeout: 3 * 60 * 1000 });
  }

  /** Starts the XCTest session; resolves once the runner says it is listening. */
  launch(udid: string, xctestrun: string): Promise<void> {
    this.stop(udid);
    return new Promise((resolve, reject) => {
      // detached: own session without a controlling terminal, so nothing in
      // xcodebuild can ever prompt for a password on the user's terminal.
      // One derived-data folder for all launches (xcodebuild otherwise makes a new one each time).
      const derived = path.join(this.cacheDir, 'run');
      const child = spawn('/usr/bin/xcrun', ['xcodebuild', 'test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`, '-derivedDataPath', derived], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      this.sessions.set(udid, child);
      let log = '';
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { this.stop(udid); reject(new RunnerError('The touch helper did not start in time.')); } }, 120000);
      const onData = (d: Buffer) => {
        log = (log + d.toString()).slice(-8000);
        if (!ready && log.includes('[DMRunner] listening')) { ready = true; clearTimeout(timer); resolve(); }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('close', (code, signal) => {
        this.onLog?.(`runner exited (code ${code ?? '-'}, signal ${signal ?? '-'})${ready ? '' : `: ${lastLines(log)}`}`);
        clearTimeout(timer);
        if (this.sessions.get(udid) === child) this.sessions.delete(udid);
        if (!ready) reject(new RunnerError(explainLaunchFailure(log)));
      });
    });
  }

  isRunning(udid: string) { return this.sessions.has(udid); }

  stop(udid: string) {
    const child = this.sessions.get(udid);
    if (!child) return;
    this.sessions.delete(udid);
    // Kill the whole process group (xcrun → xcodebuild); synchronous so it
    // also works from a process 'exit' handler.
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }

  stopAll() { for (const udid of [...this.sessions.keys()]) this.stop(udid); }
}

function explainLaunchFailure(log: string): string {
  if (/developer mode/i.test(log)) return 'Developer Mode is off. Turn it on in Settings → Privacy & Security → Developer Mode, then try again.';
  if (/locked/i.test(log)) return 'The device is locked. Unlock it and try again.';
  if (/untrusted|not trusted|verify/i.test(log)) return 'Trust the developer on the device: Settings → General → VPN & Device Management.';
  const line = log.split('\n').filter((l) => /error/i.test(l)).pop();
  return line ? `The touch helper could not start: ${line.trim().slice(0, 200)}` : 'The touch helper could not start.';
}

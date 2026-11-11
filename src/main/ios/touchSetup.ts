// Main-process side of the iOS "Enable touch control" flow: file pickers,
// signing checks, encrypted storage of the signing choice, and the setup
// checklist. Phase 4 runs the Sign/Install/Launch steps as placeholders;
// Phase 5 replaces them with the real runner installation.
//
// Two ways to sign:
//  - keychain (macOS): the profile's certificate is already in the keychain
//    with its private key (Xcode / Keychain Access) → only a profile needed;
//  - .p12: certificate + key exported to a file, with its password.

import { dialog, ipcMain, safeStorage, type BrowserWindow, type WebContents } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keychainIdentities, type KeychainIdentity } from './keychain';
import { RunnerError, type IosRunnerManager, type SigningSource } from './runner';
import { checkSigning, readP12, readProfile, SigningError, type CertificateInfo, type ProfileInfo } from './signing';
import type { Device, ProfileInspection, SetupStep, SigningResult, StoredIdentitySummary } from '../../shared/types';

type StoredIdentity =
  | { kind: 'keychain'; sha1: string; profile: string; savedAt: string } // profile: base64
  | { kind: 'p12'; p12: string; password: string; profile: string; savedAt: string };

/** Where Xcode and Finder keep downloaded profiles. */
const LOCAL_PROFILE_DIRS = [
  path.join(os.homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles'),
  path.join(os.homedir(), 'Library/MobileDevice/Provisioning Profiles'),
];

/** Signing choices, encrypted with the OS keychain (Electron safeStorage). One file per profile. */
export class SigningStore {
  constructor(private dir: string) {}

  private load(file: string): StoredIdentity | undefined {
    try {
      const v = JSON.parse(safeStorage.decryptString(readFileSync(path.join(this.dir, file)))) as StoredIdentity;
      return v.kind ? v : { ...(v as object), kind: 'p12' } as StoredIdentity; // entries saved before keychain support
    } catch {
      return undefined; // unreadable (other user / keychain reset): ignore
    }
  }

  save(profileUuid: string, id: StoredIdentity) {
    if (!safeStorage.isEncryptionAvailable()) return; // never store secrets in plain text
    mkdirSync(this.dir, { recursive: true });
    const safeName = profileUuid.replace(/[^A-Za-z0-9-]/g, '') || 'profile';
    writeFileSync(path.join(this.dir, `${safeName}.identity`), safeStorage.encryptString(JSON.stringify(id)), { mode: 0o600 });
  }

  /** A saved choice that is still valid for this device, if any. */
  async findFor(udid: string): Promise<{ cert: CertificateInfo; profile: ProfileInfo; fromKeychain: boolean; profileData: Buffer; source: SigningSource } | undefined> {
    let files: string[] = [];
    try { files = readdirSync(this.dir).filter((f) => f.endsWith('.identity')); } catch { /* none yet */ }
    const keychain = files.length ? await keychainIdentities() : [];
    for (const f of files) {
      const id = this.load(f);
      if (!id) continue;
      try {
        const profileData = Buffer.from(id.profile, 'base64');
        const profile = readProfile(profileData);
        const cert = id.kind === 'keychain' ? keychain.find((k) => k.sha1 === id.sha1) : readP12(Buffer.from(id.p12, 'base64'), id.password);
        if (!cert || checkSigning(cert, profile, udid).length) continue;
        const source: SigningSource = id.kind === 'keychain'
          ? { kind: 'keychain', sha1: cert.sha1 }
          : { kind: 'p12', p12: Buffer.from(id.p12, 'base64'), password: id.password, sha1: cert.sha1 };
        return { cert, profile, fromKeychain: id.kind === 'keychain', profileData, source };
      } catch {
        // damaged entry: skip
      }
    }
    return undefined;
  }
}

const summary = (cert: CertificateInfo, profile: ProfileInfo, fromKeychain: boolean): StoredIdentitySummary => ({
  certificate: cert.commonName,
  team: profile.teamName ? `${profile.teamName} (${profile.teamId})` : profile.teamId,
  profile: profile.name,
  expires: (cert.notAfter < profile.expiration ? cert.notAfter : profile.expiration).toISOString().slice(0, 10),
  source: fromKeychain ? 'keychain' : 'p12',
});

const matchKeychain = (profile: ProfileInfo, ids: KeychainIdentity[]) => ids.find((k) => profile.certificateSha1s.includes(k.sha1));

function inspect(profilePath: string, ids: KeychainIdentity[]): ProfileInspection {
  const profile = readProfile(readFileSync(profilePath));
  const k = matchKeychain(profile, ids);
  return { path: profilePath, name: profile.name, keychainCertificate: k?.commonName };
}

/** A profile already on this Mac that, with a keychain identity, can sign for this device. */
function suggestLocalProfile(udid: string, ids: KeychainIdentity[]): ProfileInspection | undefined {
  if (!ids.length) return undefined;
  for (const dir of LOCAL_PROFILE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mobileprovision'))) {
      const p = path.join(dir, f);
      try {
        const profile = readProfile(readFileSync(p));
        const k = matchKeychain(profile, ids);
        if (k && checkSigning(k, profile, udid).length === 0) return { path: p, name: profile.name, keychainCertificate: k.commonName };
      } catch {
        // not a readable profile
      }
    }
  }
  return undefined;
}

export interface TouchSetupDeps {
  store: SigningStore;
  runner: IosRunnerManager;
  /** Folder with the runner's AppIcon*.png files. */
  iconDir: string;
  deviceFor(wc: WebContents): Device | undefined;
  windowFor(wc: WebContents): BrowserWindow | undefined;
  /** The runner is up on this device: connect touch for its mirror window. */
  onRunnerReady(deviceId: string, udid: string): Promise<void>;
}

export function registerTouchSetup(deps: TouchSetupDeps) {
  const { store, deviceFor, windowFor } = deps;
  ipcMain.handle('touch:saved', async (e): Promise<StoredIdentitySummary | undefined> => {
    const d = deviceFor(e.sender);
    const found = d ? await store.findFor(d.serial) : undefined;
    return found ? summary(found.cert, found.profile, found.fromKeychain) : undefined;
  });

  ipcMain.handle('touch:suggest', async (e): Promise<ProfileInspection | undefined> => {
    const d = deviceFor(e.sender);
    return d ? suggestLocalProfile(d.serial, await keychainIdentities()) : undefined;
  });

  ipcMain.handle('touch:inspect', async (_e, profilePath: unknown): Promise<ProfileInspection | { error: string }> => {
    if (typeof profilePath !== 'string') return { error: 'Choose a profile.' };
    try {
      return inspect(profilePath, await keychainIdentities());
    } catch (err) {
      return { error: err instanceof SigningError ? err.message : 'Could not read the profile.' };
    }
  });

  ipcMain.handle('touch:pick', async (e, kind: unknown) => {
    const win = windowFor(e.sender);
    if (!win || (kind !== 'p12' && kind !== 'profile')) return undefined;
    const res = await dialog.showOpenDialog(win, {
      title: kind === 'p12' ? 'Choose your development certificate (.p12)' : 'Choose the provisioning profile (.mobileprovision)',
      properties: ['openFile'],
      filters: kind === 'p12' ? [{ name: 'Certificate', extensions: ['p12', 'pfx'] }] : [{ name: 'Provisioning profile', extensions: ['mobileprovision'] }],
    });
    return res.canceled ? undefined : res.filePaths[0];
  });

  /** Checks and saves the choice. Without a .p12 the profile's keychain identity is used. */
  ipcMain.handle('touch:check', async (e, profilePath: unknown, p12Path: unknown, password: unknown): Promise<SigningResult> => {
    const d = deviceFor(e.sender);
    if (!d) return { ok: false, problems: ['The device is no longer connected.'] };
    if (typeof profilePath !== 'string') return { ok: false, problems: ['Choose a provisioning profile first.'] };
    try {
      const prof = readFileSync(profilePath);
      const profile = readProfile(prof);
      if (typeof p12Path === 'string' && p12Path) {
        const p12 = readFileSync(p12Path);
        const cert = readP12(p12, typeof password === 'string' ? password : '');
        const problems = checkSigning(cert, profile, d.serial);
        if (problems.length) return { ok: false, problems };
        store.save(profile.uuid, { kind: 'p12', p12: p12.toString('base64'), password: String(password), profile: prof.toString('base64'), savedAt: new Date().toISOString() });
        return { ok: true, problems: [], identity: summary(cert, profile, false) };
      }
      const cert = matchKeychain(profile, await keychainIdentities());
      if (!cert) return { ok: false, problems: ['The certificate of this profile is not in this Mac\'s keychain. Choose the .p12 file exported from it.'] };
      const problems = checkSigning(cert, profile, d.serial);
      if (problems.length) return { ok: false, problems };
      store.save(profile.uuid, { kind: 'keychain', sha1: cert.sha1, profile: prof.toString('base64'), savedAt: new Date().toISOString() });
      return { ok: true, problems: [], identity: summary(cert, profile, true) };
    } catch (err) {
      return { ok: false, problems: [err instanceof SigningError ? err.message : `Could not read the files: ${(err as Error).message}`] };
    }
  });

  ipcMain.handle('touch:setup', async (e) => {
    const d = deviceFor(e.sender);
    const send = (st: SetupStep) => { if (!e.sender.isDestroyed()) e.sender.send('touch:step', st); };
    const fail = (id: SetupStep['id'], detail: string) => { send({ id, state: 'error', detail }); };
    if (d?.state !== 'ready') return fail('trust', 'Unlock the device and tap "Trust This Computer".');
    send({ id: 'trust', state: 'done' });
    const udid = d.serial;
    const { runner } = deps;

    send({ id: 'developerMode', state: 'running' });
    const devMode = await runner.developerMode(udid);
    if (devMode === false) return fail('developerMode', 'Turn on Developer Mode: Settings → Privacy & Security → Developer Mode. The device restarts once.');
    send({ id: 'developerMode', state: 'done', detail: devMode === undefined ? 'Could not check; continuing.' : undefined });

    send({ id: 'sign', state: 'running', detail: 'Preparing the helper app. The first time takes about a minute.' });
    const xcode = await runner.xcodeVersion();
    if (!xcode) return fail('sign', 'Touch control currently needs Xcode on this Mac. Install Xcode from the App Store and try again.');
    const identity = await store.findFor(udid);
    if (!identity) return fail('sign', 'No signing certificate is saved for this device. Choose "Use other files".');
    let xctestrun: string;
    try {
      const built = await runner.build(xcode);
      xctestrun = await runner.sign(built, identity.profile, identity.profileData, identity.source, deps.iconDir);
    } catch (err) {
      return fail('sign', (err as Error).message);
    }
    send({ id: 'sign', state: 'done' });

    send({ id: 'install', state: 'running' });
    try {
      await runner.install(udid, xctestrun);
    } catch (err) {
      return fail('install', `Installing failed: ${(err as Error).message}`);
    }
    send({ id: 'install', state: 'done' });

    send({ id: 'launch', state: 'running' });
    try {
      await runner.launch(udid, xctestrun);
      await deps.onRunnerReady(d.id, udid);
    } catch (err) {
      return fail('launch', err instanceof RunnerError ? err.message : `Could not start touch control: ${(err as Error).message}`);
    }
    send({ id: 'launch', state: 'done', detail: 'Touch control is on.' });
  });
}

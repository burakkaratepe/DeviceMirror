// Main-process side of the iOS "Enable touch control" flow: file pickers,
// signing checks, encrypted storage of the signing identity, and the setup
// checklist. Phase 4 runs the Sign/Install/Launch steps as placeholders;
// Phase 5 replaces them with the real runner installation.

import { dialog, ipcMain, safeStorage, type BrowserWindow, type WebContents } from 'electron';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkSigning, readP12, readProfile, SigningError, type CertificateInfo, type ProfileInfo } from './signing';
import type { Device, SetupStep, SigningResult, StoredIdentitySummary } from '../../shared/types';

interface StoredIdentity {
  p12: string; // base64
  password: string;
  profile: string; // base64
  savedAt: string;
}

/** Signing identities, encrypted with the OS keychain (Electron safeStorage). One file per profile. */
export class SigningStore {
  constructor(private dir: string) {}

  private files(): string[] {
    try { return readdirSync(this.dir).filter((f) => f.endsWith('.identity')); } catch { return []; }
  }

  private load(file: string): StoredIdentity | undefined {
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(path.join(this.dir, file)))) as StoredIdentity;
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

  /** A saved identity that is still valid for this device, if any. */
  findFor(udid: string): { id: StoredIdentity; cert: CertificateInfo; profile: ProfileInfo } | undefined {
    for (const f of this.files()) {
      const id = this.load(f);
      if (!id) continue;
      try {
        const cert = readP12(Buffer.from(id.p12, 'base64'), id.password);
        const profile = readProfile(Buffer.from(id.profile, 'base64'));
        if (checkSigning(cert, profile, udid).length === 0) return { id, cert, profile };
      } catch {
        // damaged entry: skip
      }
    }
    return undefined;
  }
}

const summary = (cert: CertificateInfo, profile: ProfileInfo): StoredIdentitySummary => ({
  certificate: cert.commonName,
  team: profile.teamName ? `${profile.teamName} (${profile.teamId})` : profile.teamId,
  profile: profile.name,
  expires: (cert.notAfter < profile.expiration ? cert.notAfter : profile.expiration).toISOString().slice(0, 10),
});

export function registerTouchSetup(store: SigningStore, deviceFor: (wc: WebContents) => Device | undefined, windowFor: (wc: WebContents) => BrowserWindow | undefined) {
  ipcMain.handle('touch:saved', (e): StoredIdentitySummary | undefined => {
    const d = deviceFor(e.sender);
    const found = d ? store.findFor(d.serial) : undefined;
    return found ? summary(found.cert, found.profile) : undefined;
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

  ipcMain.handle('touch:check', (e, p12Path: unknown, password: unknown, profilePath: unknown): SigningResult => {
    const d = deviceFor(e.sender);
    if (!d) return { ok: false, problems: ['The device is no longer connected.'] };
    if (typeof p12Path !== 'string' || typeof password !== 'string' || typeof profilePath !== 'string') return { ok: false, problems: ['Choose both files first.'] };
    try {
      const p12 = readFileSync(p12Path);
      const prof = readFileSync(profilePath);
      const cert = readP12(p12, password);
      const profile = readProfile(prof);
      const problems = checkSigning(cert, profile, d.serial);
      if (problems.length) return { ok: false, problems };
      store.save(profile.uuid, { p12: p12.toString('base64'), password, profile: prof.toString('base64'), savedAt: new Date().toISOString() });
      return { ok: true, problems: [], identity: summary(cert, profile) };
    } catch (err) {
      return { ok: false, problems: [err instanceof SigningError ? err.message : `Could not read the files: ${(err as Error).message}`] };
    }
  });

  ipcMain.handle('touch:setup', async (e) => {
    const d = deviceFor(e.sender);
    const send = (s: SetupStep) => { if (!e.sender.isDestroyed()) e.sender.send('touch:step', s); };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    send({ id: 'trust', state: d?.state === 'ready' ? 'done' : 'error', detail: d?.state === 'ready' ? undefined : 'Unlock the device and tap "Trust This Computer".' });
    if (d?.state !== 'ready') return;
    // Placeholders until Phase 5 installs and launches the real runner.
    for (const id of ['developerMode', 'sign', 'install', 'launch'] as const) {
      send({ id, state: 'running' });
      await wait(450);
      send({ id, state: id === 'launch' ? 'pending' : 'done', detail: id === 'launch' ? 'Touch control arrives in the next update.' : undefined });
    }
  });
}

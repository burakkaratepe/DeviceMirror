// macOS: finds Apple development identities (certificate + private key) that
// are already in the user's keychain — installed by Xcode or Keychain Access —
// so a .p12 export is not needed. `codesign -s <sha1>` signs with them later.

import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import type { CertificateInfo } from './signing';

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));

export interface KeychainIdentity extends CertificateInfo {}

/** Valid code-signing identities in the keychain (expired/untrusted ones are left out by `security -v`). */
export async function keychainIdentities(): Promise<KeychainIdentity[]> {
  if (process.platform !== 'darwin') return [];
  let list: string;
  try {
    list = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch {
    return [];
  }
  const ids = [...list.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/gm)].map((m) => ({ sha1: m[1], name: m[2] }));
  const out: KeychainIdentity[] = [];
  for (const { sha1, name } of ids) {
    const cert = await certificateFor(name, sha1);
    if (cert) out.push(cert);
  }
  return out;
}

/** Reads the certificate (dates, team) for an identity from the keychain. */
async function certificateFor(name: string, sha1: string): Promise<KeychainIdentity | undefined> {
  let pems: string;
  try {
    pems = await run('/usr/bin/security', ['find-certificate', '-a', '-c', name, '-p']);
  } catch {
    return undefined;
  }
  for (const pem of pems.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    try {
      const x = new X509Certificate(pem);
      if (createHash('sha1').update(x.raw).digest('hex').toUpperCase() !== sha1) continue;
      const field = (key: string) => new RegExp(`^${key}=(.+)$`, 'm').exec(x.subject)?.[1];
      return {
        commonName: field('CN') ?? name,
        teamId: field('OU'),
        notBefore: new Date(x.validFrom),
        notAfter: new Date(x.validTo),
        sha1,
      };
    } catch {
      // not parseable: try the next one
    }
  }
  return undefined;
}

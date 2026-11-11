// Reads and checks the signing material the user provides for iOS touch
// control: a .p12 (certificate + private key) and a .mobileprovision. The
// XCUITest runner is re-signed with these in Phase 5; here we make sure they
// fit together and include the device, so problems surface before signing.

import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { asDict, parsePlist, type PlistValue } from '../plist';

export interface CertificateInfo {
  commonName: string;
  teamId?: string;
  notBefore: Date;
  notAfter: Date;
  /** SHA-1 of the DER certificate, upper-case hex (what Apple tools show). */
  sha1: string;
}

export interface ProfileInfo {
  name: string;
  uuid: string;
  teamId: string;
  teamName?: string;
  appIdentifier: string;
  expiration: Date;
  devices: string[];
  allDevices: boolean;
  getTaskAllow: boolean;
  certificateSha1s: string[];
}

export class SigningError extends Error {}

const sha1 = (der: Buffer) => createHash('sha1').update(der).digest('hex').toUpperCase();

/** Opens a .p12; throws SigningError with a user-facing message on a wrong password or bad file. */
export function readP12(data: Buffer, password: string): CertificateInfo {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(data.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/password|mac|decrypt|invalid/i.test(msg)) throw new SigningError('The password does not open this .p12 file.');
    throw new SigningError('This file is not a valid .p12 certificate.');
  }
  const keys = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const plainKeys = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  if (!keys.length && !plainKeys.length) throw new SigningError('The .p12 file has no private key. Export it from Keychain Access together with its key.');
  const certBag = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).find((b) => b.cert);
  if (!certBag?.cert) throw new SigningError('The .p12 file has no certificate.');
  const cert = certBag.cert;
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const field = (sn: string) => cert.subject.getField(sn)?.value as string | undefined;
  return {
    commonName: field('CN') ?? 'Unknown certificate',
    teamId: field('OU'),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    sha1: sha1(der),
  };
}

/** A .mobileprovision is a CMS-signed XML plist; the plist can be read directly. */
export function readProfile(data: Buffer): ProfileInfo {
  const text = data.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < 0) throw new SigningError('This file is not a valid .mobileprovision profile.');
  let plist: Record<string, PlistValue>;
  try {
    plist = asDict(parsePlist(data.subarray(start, end + 8).toString('utf8')));
  } catch {
    throw new SigningError('This file is not a valid .mobileprovision profile.');
  }
  const ent = asDict(plist.Entitlements);
  const teams = Array.isArray(plist.TeamIdentifier) ? (plist.TeamIdentifier as string[]) : [];
  const certs = Array.isArray(plist.DeveloperCertificates) ? (plist.DeveloperCertificates as PlistValue[]) : [];
  return {
    name: String(plist.Name ?? 'Unnamed profile'),
    uuid: String(plist.UUID ?? ''),
    teamId: String(teams[0] ?? ''),
    teamName: plist.TeamName ? String(plist.TeamName) : undefined,
    appIdentifier: String(ent['application-identifier'] ?? ''),
    expiration: plist.ExpirationDate instanceof Date ? plist.ExpirationDate : new Date(0),
    devices: Array.isArray(plist.ProvisionedDevices) ? (plist.ProvisionedDevices as string[]).map(String) : [],
    allDevices: plist.ProvisionsAllDevices === true,
    getTaskAllow: ent['get-task-allow'] === true,
    certificateSha1s: certs.filter(Buffer.isBuffer).map((b) => sha1(b as Buffer)),
  };
}

const sameUdid = (a: string, b: string) => a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

/**
 * Everything that would stop the runner from launching on this device, as
 * user-facing messages (empty = good to go).
 */
export function checkSigning(cert: CertificateInfo, profile: ProfileInfo, udid: string, now = new Date()): string[] {
  const problems: string[] = [];
  if (cert.notAfter < now) problems.push(`The certificate "${cert.commonName}" expired on ${day(cert.notAfter)}.`);
  else if (cert.notBefore > now) problems.push(`The certificate "${cert.commonName}" is not valid until ${day(cert.notBefore)}.`);
  if (profile.expiration < now) problems.push(`The profile "${profile.name}" expired on ${day(profile.expiration)}.`);
  if (!profile.certificateSha1s.includes(cert.sha1)) problems.push(`The profile "${profile.name}" was not made for this certificate. Download a profile that includes "${cert.commonName}".`);
  if (profile.allDevices) problems.push('This is an enterprise (all devices) profile. Touch control needs a development profile.');
  else if (!profile.getTaskAllow) problems.push('This is a distribution profile. Touch control needs a development profile.');
  else if (!profile.devices.some((d) => sameUdid(d, udid))) problems.push('This device is not in the profile. Add its UDID to your Apple Developer account and download the profile again.');
  return problems;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

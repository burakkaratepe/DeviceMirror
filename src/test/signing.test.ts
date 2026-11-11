import assert from 'node:assert/strict';
import { test } from 'node:test';
import forge from 'node-forge';
import { checkSigning, readP12, readProfile, SigningError } from '../main/ios/signing';
import { buildPlist } from '../main/plist';

const UDID = '00008101-001A2B3C4D5E6F70';

/** Makes a self-signed "Apple Development" style cert + key wrapped in a .p12. */
function makeIdentity(password: string, days = 365) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + days * 86400e3);
  const attrs = [{ shortName: 'CN', value: 'Apple Development: Test User (ABCDE12345)' }, { shortName: 'OU', value: 'TEAM123456' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { p12: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), der };
}

/** Wraps a profile plist in junk bytes, like the CMS envelope of a real one. */
function makeProfile(opts: { certs: Buffer[]; devices?: string[]; getTaskAllow?: boolean; allDevices?: boolean; expires?: Date }) {
  const plist = buildPlist({
    Name: 'DM Dev Profile',
    UUID: 'AAAA-BBBB',
    TeamIdentifier: ['TEAM123456'],
    TeamName: 'Test Team',
    ExpirationDate: opts.expires ?? new Date(Date.now() + 30 * 86400e3),
    DeveloperCertificates: opts.certs,
    ...(opts.allDevices ? { ProvisionsAllDevices: true } : { ProvisionedDevices: opts.devices ?? [UDID] }),
    Entitlements: { 'application-identifier': 'TEAM123456.*', 'get-task-allow': opts.getTaskAllow ?? true },
  });
  return Buffer.concat([Buffer.from([0x30, 0x80, 0x06, 0x09]), Buffer.from(plist), Buffer.from([0xa0, 0x82, 0x00])]);
}

test('reads a .p12 and rejects a wrong password', () => {
  const { p12 } = makeIdentity('secret');
  const info = readP12(p12, 'secret');
  assert.equal(info.commonName, 'Apple Development: Test User (ABCDE12345)');
  assert.equal(info.teamId, 'TEAM123456');
  assert.throws(() => readP12(p12, 'wrong'), (e) => e instanceof SigningError && /password/.test(e.message));
  assert.throws(() => readP12(Buffer.from('not a p12'), 'x'), SigningError);
});

test('reads a profile and accepts a matching identity and device', () => {
  const { p12, der } = makeIdentity('pw');
  const profile = readProfile(makeProfile({ certs: [der] }));
  assert.equal(profile.teamId, 'TEAM123456');
  assert.equal(profile.appIdentifier, 'TEAM123456.*');
  assert.deepEqual(checkSigning(readP12(p12, 'pw'), profile, UDID.toLowerCase()), []);
});

test('explains every mismatch', () => {
  const { p12, der } = makeIdentity('pw');
  const other = makeIdentity('pw').der;
  const cert = readP12(p12, 'pw');
  const msg = (p: Buffer) => checkSigning(cert, readProfile(p), UDID).join(' | ');
  assert.match(msg(makeProfile({ certs: [other] })), /not made for this certificate/);
  assert.match(msg(makeProfile({ certs: [der], devices: ['00008030-000000000000000A'] })), /device is not in the profile/);
  assert.match(msg(makeProfile({ certs: [der], getTaskAllow: false })), /distribution profile/);
  assert.match(msg(makeProfile({ certs: [der], allDevices: true })), /enterprise/);
  assert.match(msg(makeProfile({ certs: [der], expires: new Date(Date.now() - 86400e3) })), /expired/);
  assert.match(checkSigning(readP12(makeIdentity('pw', -1).p12, 'pw'), readProfile(makeProfile({ certs: [der] })), UDID).join(), /certificate .* expired/);
  assert.throws(() => readProfile(Buffer.from('nope')), SigningError);
});

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MINISIG_NAME,
  RELEASE_SIGNING_PUBLIC_KEY,
  SUMS_NAME,
  parseMinisig,
  verifySumsSignature,
} from './release-signing.js';

const sums = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Vigil-at-Home-0.2.0-arm64.dmg',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  Vigil-at-Home-0.2.0-x64.dmg',
].join('\n');

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

function minisigFor(data: string, privatePem: string): string {
  const sig = sign(null, Buffer.from(data, 'utf8'), createPrivateKey(privatePem));
  return `untrusted comment: Vigil at Home release signature\n${sig.toString('base64')}\n`;
}

describe('parseMinisig', () => {
  it('reads the comment-plus-base64 shape and nothing else', () => {
    expect(parseMinisig(minisigFor(sums, keyPair().privatePem))).toHaveLength(64);
    expect(parseMinisig('')).toBeUndefined();
    expect(parseMinisig('no comment line\n' + 'A'.repeat(88))).toBeUndefined();
    expect(parseMinisig('untrusted comment: x\nnot base64 !!!')).toBeUndefined();
    // A raw ed25519 signature is exactly 64 bytes; anything else is refused.
    expect(parseMinisig('untrusted comment: x\nAAAA')).toBeUndefined();
    expect(parseMinisig('untrusted comment: x\n' + 'A'.repeat(88))).toBeUndefined();
  });
});

describe('verifySumsSignature', () => {
  it('accepts a signature by the matching key over the exact sums bytes', () => {
    const kp = keyPair();
    expect(verifySumsSignature(sums, minisigFor(sums, kp.privatePem), kp.publicPem)).toBe(true);
  });

  it('rejects tampered sums, the wrong key, and mangled signatures', () => {
    const kp = keyPair();
    const sig = minisigFor(sums, kp.privatePem);
    // One extra line, or one changed hash, must fail the check.
    expect(verifySumsSignature(`${sums}\ncccc  extra.bin\n`, sig, kp.publicPem)).toBe(false);
    expect(verifySumsSignature(sums.replace('aaaa', 'ffff'), sig, kp.publicPem)).toBe(false);
    expect(verifySumsSignature(sums, minisigFor(sums, keyPair().privatePem), kp.publicPem)).toBe(
      false,
    );
    expect(verifySumsSignature(sums, 'untrusted comment: x\nAAAA\n', kp.publicPem)).toBe(false);
    expect(verifySumsSignature(sums, 'garbage', kp.publicPem)).toBe(false);
  });

  it('rejects rather than throwing when the key material itself is bad', () => {
    expect(verifySumsSignature(sums, minisigFor(sums, keyPair().privatePem), 'not a key')).toBe(
      false,
    );
  });

  it('pairs the committed public key with the dogfood key CI signs releases with', () => {
    // scripts/release/dogfood-signing-key.b64 is the private half of
    // RELEASE_SIGNING_PUBLIC_KEY — the pairing the dogfood workflow run and
    // the app's verification both depend on.
    const b64 = readFileSync(
      new URL('../../../../scripts/release/dogfood-signing-key.b64', import.meta.url),
      'utf8',
    ).trim();
    const der = Buffer.from(b64, 'base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
    // Verifies against the constant the app actually compiles in.
    expect(verifySumsSignature(sums, minisigFor(sums, pem), RELEASE_SIGNING_PUBLIC_KEY)).toBe(true);
    expect(verifySumsSignature(sums, minisigFor(sums, pem))).toBe(true);
    // …and refuses a signature by any other key (a fork's, or an attacker's).
    expect(verifySumsSignature(sums, minisigFor(sums, keyPair().privatePem))).toBe(false);
  });

  it('names the files the release ships', () => {
    expect(SUMS_NAME).toBe('SHA256SUMS.txt');
    expect(MINISIG_NAME).toBe(`${SUMS_NAME}.minisig`);
  });
});

/**
 * Tests for scripts/release/sign-checksums.mjs — the tool the Release
 * workflow signs SHA256SUMS.txt with. Runs it as a real subprocess so the
 * CLI contract (arguments, .minisig output, non-zero exits) is what CI gets.
 */

import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'sign-checksums.mjs');
const sumsBody = 'deadbeef  Vigil-at-Home-0.2.0-arm64.dmg\n';
const dirs = [];

const workDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'vigil-sign-'));
  dirs.push(d);
  return d;
};

const run = (args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

afterAll(() => {
  // Nothing here is sensitive (fresh throwaway keys), but leave no litter.
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('sign-checksums.mjs', () => {
  it('signs sums with a PEM key and the signature verifies', () => {
    const d = workDir();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyPath = join(d, 'key.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(d, 'sums.txt'), sumsBody);

    const out = run(['--sums', join(d, 'sums.txt'), '--key', keyPath]);
    expect(out).toMatch(/Signed .*sums\.txt -> .*sums\.txt\.minisig/);

    const minisig = readFileSync(join(d, 'sums.txt.minisig'), 'utf8');
    expect(minisig).toMatch(/^untrusted comment: Vigil at Home release signature\n/);
    const sig = Buffer.from(minisig.split('\n')[1], 'base64');
    expect(sig).toHaveLength(64);
    // Node <22's createPublicKey refuses an already-public KeyObject; pass it
    // to verify directly — the form every supported Node accepts.
    expect(verify(null, Buffer.from(sumsBody), publicKey, sig)).toBe(true);
  });

  it('accepts a base64 DER key file, the form the committed dogfood key uses', () => {
    const d = workDir();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ type: 'pkcs8', format: 'der' });
    const keyPath = join(d, 'key.b64');
    writeFileSync(keyPath, der.toString('base64'));
    writeFileSync(join(d, 'sums.txt'), sumsBody);

    run(['--sums', join(d, 'sums.txt'), '--key', keyPath]);
    const minisig = readFileSync(join(d, 'sums.txt.minisig'), 'utf8');
    const sig = Buffer.from(minisig.split('\n')[1], 'base64');
    expect(verify(null, Buffer.from(sumsBody), publicKey, sig)).toBe(true);
  });

  it('fails loudly on a missing key or sums file', () => {
    const d = workDir();
    writeFileSync(join(d, 'sums.txt'), sumsBody);
    expect(() => run(['--sums', join(d, 'sums.txt'), '--key', join(d, 'nope.pem')])).toThrow(
      /Could not read the signing key/,
    );

    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(d, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => run(['--sums', join(d, 'missing.txt'), '--key', join(d, 'key.pem')])).toThrow();
  });

  it('refuses a file that is not a private key', () => {
    const d = workDir();
    writeFileSync(join(d, 'sums.txt'), sumsBody);
    writeFileSync(
      join(d, 'key.pem'),
      '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n',
    );
    expect(() => run(['--sums', join(d, 'sums.txt'), '--key', join(d, 'key.pem')])).toThrow(
      /not a readable private key/,
    );
  });

  it('the committed dogfood key signs for the committed public key in the app', () => {
    // The pairing the dogfood workflow run relies on: this private key's
    // public half is RELEASE_SIGNING_PUBLIC_KEY in release-signing.ts.
    const b64 = readFileSync(
      resolve(import.meta.dirname, 'dogfood-signing-key.b64'),
      'utf8',
    ).trim();
    const d = workDir();
    writeFileSync(join(d, 'key.b64'), b64);
    writeFileSync(join(d, 'sums.txt'), sumsBody);
    run(['--sums', join(d, 'sums.txt'), '--key', join(d, 'key.b64')]);
    const minisig = readFileSync(join(d, 'sums.txt.minisig'), 'utf8');
    const sig = Buffer.from(minisig.split('\n')[1], 'base64');
    const appPub = readFileSync(
      resolve(import.meta.dirname, '../../apps/desktop/src/main/release-signing.ts'),
      'utf8',
    );
    const pubB64 = appPub.match(/MCowBQYDK2VwAyEA[A-Za-z0-9+/=]+/)[0];
    const pub = createPublicKey({
      key: Buffer.from(pubB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, Buffer.from(sumsBody), pub, sig)).toBe(true);
  });
});

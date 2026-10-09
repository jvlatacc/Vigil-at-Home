#!/usr/bin/env node
/**
 * Signs SHA256SUMS.txt with the release signing key (audit REL-01).
 *
 * The Release workflow calls this with the private key from the
 * VIGIL_RELEASE_SIGNING_KEY secret; apps/desktop verifies the resulting
 * .minisig with the committed public key before offering an update.
 *
 * The signature is minisign-style ed25519, made with node:crypto so the
 * repo stays dependency-free: the .minisig file is an untrusted-comment
 * line plus the base64 raw 64-byte signature over the exact sums bytes.
 * The key file may be a PEM private key (what the secret holds) or the
 * base64 DER of one (what the committed dogfood test key is stored as).
 *
 * Usage: node scripts/release/sign-checksums.mjs --sums <path> --key <path>
 * Writes <sums>.minisig next to the sums file. Fails loudly on any problem.
 */

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sumsPath = arg('--sums');
const keyPath = arg('--key');
if (!sumsPath || !keyPath) {
  console.error('Usage: sign-checksums.mjs --sums <SHA256SUMS.txt path> --key <private key file>');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(keyPath, 'utf8').trim();
} catch (err) {
  console.error(`Could not read the signing key at ${keyPath}: ${err.message}`);
  process.exit(1);
}
let key;
try {
  key = raw.startsWith('-----BEGIN')
    ? createPrivateKey(raw)
    : createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
} catch (err) {
  console.error(`That file is not a readable private key (PEM or base64 DER): ${err.message}`);
  process.exit(1);
}

const sums = readFileSync(sumsPath);
const signature = sign(null, sums, key);
const minisigPath = `${sumsPath}.minisig`;
writeFileSync(
  minisigPath,
  `untrusted comment: Vigil at Home release signature\n${signature.toString('base64')}\n`,
);
console.log(`Signed ${sumsPath} -> ${minisigPath}`);

#!/usr/bin/env node
/**
 * Generates the ed25519 keypair for release signing (audit REL-01).
 *
 * The private half goes into the GitHub secret VIGIL_RELEASE_SIGNING_KEY;
 * the public half replaces the committed verification key in
 * apps/desktop/src/main/release-signing.ts. After that, every Release
 * workflow run signs SHA256SUMS.txt, and the app refuses to offer updates
 * whose checksums don't verify (until then it stays fail-open, logged).
 *
 * Usage: node scripts/release/generate-signing-key.mjs [--out <dir>]
 * Writes vigil-release-signing-key.pem (0600) and
 * vigil-release-signing-pub.pem in the output directory (default: cwd).
 * Refuses to overwrite an existing private key.
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const outDir = resolve(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] || '.' : '.',
);
const privatePath = join(outDir, 'vigil-release-signing-key.pem');
const publicPath = join(outDir, 'vigil-release-signing-pub.pem');

if (existsSync(privatePath)) {
  console.error(`${privatePath} already exists — move it aside before generating a new key.`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

mkdirSync(outDir, { recursive: true, mode: 0o700 });
writeFileSync(privatePath, pem, { mode: 0o600 });
chmodSync(privatePath, 0o600);
writeFileSync(publicPath, pubPem);

console.log(`Wrote ${privatePath} (keep private — this is the secret)`);
console.log(`Wrote ${publicPath}`);
console.log(`
Next steps (owner):
  1. gh secret set VIGIL_RELEASE_SIGNING_KEY < ${privatePath}
  2. Replace RELEASE_SIGNING_PUBLIC_KEY in
     apps/desktop/src/main/release-signing.ts with the contents of ${publicPath}
  3. Rebase any draft PR after step 2 so app and releases agree on the key.
Until the secret exists, releases stay unsigned and the app logs and offers
them anyway (fail-open).`);

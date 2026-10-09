import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * Release-signing verification (audit REL-01). Releases publish
 * SHA256SUMS.txt plus an ed25519 signature over its exact bytes, in a
 * minisign-style .minisig file made by scripts/release/sign-checksums.mjs.
 * Before the update checker offers a download, it verifies that signature
 * here — so a compromised release repo cannot steer users to a doctored
 * installer without the signing key.
 *
 * The signature format stays dependency-free: an "untrusted comment:" line
 * and the base64 raw 64-byte ed25519 signature, like minisign's output
 * minus its key-number header (we pin the one key this app trusts).
 */

/** The checksums file the release workflow uploads with every release. */
export const SUMS_NAME = 'SHA256SUMS.txt';
/** Its signature, same asset list, same release. */
export const MINISIG_NAME = 'SHA256SUMS.txt.minisig';

/**
 * The release signing key this build trusts, as a SPKI PEM.
 *
 * This is the public half of the in-repo dogfood test key (scripts/release/),
 * committed so tests and the dogfood workflow run pair up. Before signing
 * real releases, the owner generates the real keypair with
 * scripts/release/generate-signing-key.mjs and replaces both this constant
 * and the VIGIL_RELEASE_SIGNING_KEY secret.
 */
export const RELEASE_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAke4unQXdN0SrlNk0TG9Hzx0dgzeeUogEHq0q5o3EBkg=
-----END PUBLIC KEY-----
`;

/**
 * The raw signature from a .minisig file, or undefined when the file isn't
 * the two-line comment-plus-base64 shape (wrong length, junk, empty).
 */
export function parseMinisig(raw: string): Buffer | undefined {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length !== 2 || !lines[0]!.startsWith('untrusted comment:')) return undefined;
  const sig = Buffer.from(lines[1]!, 'base64');
  // A raw ed25519 signature is exactly 64 bytes.
  return sig.length === 64 ? sig : undefined;
}

/**
 * True when `minisig` is a valid signature by `publicKey` over the exact
 * bytes of `sums`. Every malformed input — bad key material, mangled
 * signature, wrong length — is "not verified", never a throw: the caller's
 * whole job is deciding whether to trust the release.
 */
export function verifySumsSignature(
  sums: string | Buffer,
  minisig: string | Buffer,
  publicKey: string | KeyObject = RELEASE_SIGNING_PUBLIC_KEY,
): boolean {
  try {
    const sig = typeof minisig === 'string' ? parseMinisig(minisig) : minisig;
    if (!sig) return false;
    const data = typeof sums === 'string' ? Buffer.from(sums, 'utf8') : sums;
    return cryptoVerify(null, data, createPublicKey(publicKey), sig);
  } catch {
    return false;
  }
}

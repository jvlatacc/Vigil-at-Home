# Release signing

Releases ship a `SHA256SUMS.txt` (sha256 of every installer) plus an ed25519
signature over its exact bytes, `SHA256SUMS.txt.minisig` (audit REL-01). The
desktop app verifies that signature against the public key compiled into
`apps/desktop/src/main/release-signing.ts` before it offers an update — so a
compromised release repo cannot steer users to a doctored installer without
the signing key.

The format is minisign-style and dependency-free (made with `node:crypto`):
the `.minisig` file is an `untrusted comment:` line and the base64 raw
64-byte signature. It is produced by `scripts/release/sign-checksums.mjs` and
checked by `verifySumsSignature()` in the app.

## Owner setup (once)

Until the signing key exists, releases stay unsigned and the app still offers
them, with a logged warning — **fail-open**, so forks and historical releases
keep working. Provisioning the key is what turns this on:

1. Generate a keypair (ed25519, PKCS#8):

   ```sh
   node scripts/release/generate-signing-key.mjs --out ~/.config/vigil-release-signing
   ```

2. Add the private key as the repository secret:

   ```sh
   gh secret set VIGIL_RELEASE_SIGNING_KEY < ~/.config/vigil-release-signing/vigil-release-signing-key.pem
   ```

3. Replace `RELEASE_SIGNING_PUBLIC_KEY` in
   `apps/desktop/src/main/release-signing.ts` with the public key the script
   wrote (`vigil-release-signing-pub.pem`), commit, and merge.

4. The next Release workflow run signs its checksums; the app then refuses to
   offer releases whose signature doesn't verify. To flip the app to
   fail-closed for _unsigned_ releases too, make `verifyAssets` return
   `refused` instead of `unsigned` — the follow-up is one branch in
   `apps/desktop/src/main/updates.ts`.

Keep the private key offline and out of the repo: `.gitignore` refuses
`*.pem` for exactly that reason.

## Dogfood test key (deliberately public)

`dogfood-signing-key.b64` is the private half of the keypair whose public
half is committed in `release-signing.ts` today. It exists so the pipeline
can be exercised end-to-end without the real secret: run the Release
workflow with the `test_sign` input checked and it signs the checksums with
this key; the app verifies against the committed public key and offers the
update. **Anyone with the repo can produce this signature, so a dogfood
signature proves nothing about provenance** — it only proves the plumbing.
Never use it for a real release; step 2 above is what makes releases real.

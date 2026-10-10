# `pkg_abi_for` — install.sh

**Script:** `appliance/opnsense/install.sh`. Builds the pkg ABI string for
installing packages into the jail root.

```sh
pkg_abi_for() {
  # $1 = release (e.g. 14.2-RELEASE), $2 = arch -> pkg ABI string for jail.
  _major=${1%%.*}
  printf 'FreeBSD:%s:%s\n' "$_major" "$2"
}
```

## Purpose

Derive the ABI `pkg(8)` uses when installing into the jail root
(`pkg -r "$JAIL_ROOT"` with `ABI="$PKG_ABI"`), so packages match the jail
userland's FreeBSD major version and architecture rather than whatever the
host tooling would guess. For `14.2-RELEASE` on `amd64` this is
`FreeBSD:14:amd64`.

## Inputs and outputs

- Inputs: `$1` release (e.g. `14.2-RELEASE`), `$2` arch (`amd64`, `arm64`,
  `i386`).
- Output: the ABI string on stdout.
- Return status: 0 (no validation — inputs come from `detect_abi`, which has
  already validated them).

## Side effects

None — pure function.

## Failure modes and exit codes

None of its own; a malformed release string would produce a malformed ABI that
`install_softflowd`'s `pkg` calls would then fail on, loudly, with pkg's own
error.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"pkg_abi_for and base_txz_url build the official FreeBSD coordinates" —
`pkg_abi_for 14.2-RELEASE amd64` → `FreeBSD:14:amd64`.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)

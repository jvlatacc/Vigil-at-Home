# `base_txz_url` — install.sh

**Script:** `appliance/opnsense/install.sh`. Builds the official FreeBSD
download URL for the jail's base.txz.

```sh
base_txz_url() {
  # $1 = release, $2 = arch -> official FreeBSD download URL for base.txz.
  printf '%s/%s/%s/base.txz\n' "$BASE_URL_PREFIX" "$2" "$1"
}
```

## Purpose

Name the exact artifact the jail userland comes from: the official FreeBSD
release server (`$BASE_URL_PREFIX`, by default
`https://download.freebsd.org/ftp/releases`), the architecture directory, the
release directory, and `base.txz`. The URL is printed by `main` before
provisioning, so the operator can see where the userland came from.

## Inputs and outputs

- Inputs: `$1` release, `$2` arch.
- Output: the URL on stdout, for example
  `https://download.freebsd.org/ftp/releases/amd64/14.2-RELEASE/base.txz`.
- Return status: 0 (no validation — inputs come from `detect_abi`).

## Side effects

None — pure function.

## Failure modes and exit codes

None of its own. A wrong URL surfaces at `fetch_base_txz`, which dies with
"check network egress and the release name".

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"pkg_abi_for and base_txz_url build the official FreeBSD coordinates" —
asserts the full URL with the official host and release directory.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)

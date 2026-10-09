# `fetch_base_txz` — install.sh

**Script:** `appliance/opnsense/install.sh`. Downloads the matching FreeBSD
base.txz into the jail root.

```sh
fetch_base_txz() {
  # Fetches the matching FreeBSD base.txz unless the jail userland is
  # already in place (idempotent re-runs must not re-download).
  if [ -f "$JAIL_ROOT/bin/sh" ]; then
    printf '%s: jail userland already present, skipping base.txz fetch\n' "${0##*/}"
    return 0
  fi
  mkdir -p "$JAIL_ROOT" || die "cannot create $JAIL_ROOT"
  printf '%s: fetching %s\n' "${0##*/}" "$BASE_TXZ_URL"
  fetch -o "$JAIL_ROOT/base.txz" "$BASE_TXZ_URL" ||
    die "fetching $BASE_TXZ_URL failed: check network egress and the release name"
}
```

## Purpose

Bring the official release artifact for the detected ABI onto the appliance.
The presence of `$JAIL_ROOT/bin/sh` marks an already-provisioned userland, so
idempotent re-runs skip the download. `fetch(1)` is used because it is part of
the FreeBSD base system (installer header).

## Inputs and outputs

- Inputs: `JAIL_ROOT`, `BASE_TXZ_URL` (from `detect_abi`).
- Output: none on success; progress line with the URL on stdout.
- Return status: 0 on success or skip; fatal (`die`, exit 1) on failure.

## Side effects

Creates `$JAIL_ROOT` and writes `$JAIL_ROOT/base.txz` (removed again by
`extract_base_txz`). Network egress to the FreeBSD release server.

## Failure modes and exit codes

Dies when the directory cannot be created or when the fetch fails; the cause
names the URL and the two usual suspects ("check network egress and the
release name").

## Tests covering it

No direct bats case — it performs a real download. Part of the on-device
verification boundary: a successful install shows the fetched-URL progress
line, and CI deliberately proves nothing about it.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)

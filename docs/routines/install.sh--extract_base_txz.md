# `extract_base_txz` — install.sh

**Script:** `appliance/opnsense/install.sh`. Unpacks the base userland into
the jail root and removes the archive.

```sh
extract_base_txz() {
  if [ -f "$JAIL_ROOT/bin/sh" ]; then
    printf '%s: jail userland already present, skipping extraction\n' "${0##*/}"
    return 0
  fi
  tar -C "$JAIL_ROOT" -xzf "$JAIL_ROOT/base.txz" ||
    die "extracting $JAIL_ROOT/base.txz failed: the jail root may be unusable"
  rm -f "$JAIL_ROOT/base.txz"
}
```

## Purpose

Turn the downloaded base.txz into the jail's userland tree. Same idempotency
marker as `fetch_base_txz` (`$JAIL_ROOT/bin/sh`), and the archive is deleted
after a successful extraction so the jail root holds no leftover payload.

## Inputs and outputs

- Inputs: `JAIL_ROOT`, plus the `base.txz` left there by `fetch_base_txz`.
- Output: none.
- Return status: 0 on success or skip; fatal (`die`, exit 1) on extraction
  failure.

## Side effects

Extracts the full userland tree into `$JAIL_ROOT` (bin, lib, etc, usr, …) and
removes `$JAIL_ROOT/base.txz` afterwards.

## Failure modes and exit codes

Dies when tar fails, with the honest warning "the jail root may be unusable" —
a half-extracted root is not retried automatically; a re-run with
`$JAIL_ROOT/bin/sh` still absent attempts the extraction again.

## Tests covering it

No direct bats case (needs a real tarball); exercised on device as part of
every fresh install.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)

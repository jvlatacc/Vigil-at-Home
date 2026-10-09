# `freebsd_release_from_userland` — install.sh

**Script:** `appliance/opnsense/install.sh`. Derives a downloadable `-RELEASE`
from the host's userland version.

```sh
freebsd_release_from_userland() {
  # $1 = `freebsd-version -u` output -> the matching -RELEASE build that has
  # a downloadable base.txz. Patch levels (14.2-RELEASE-p3) map to the base
  # release; -STABLE/-CURRENT/-PRERELEASE builds have no release artifact.
  case $1 in
    *-STABLE | *-CURRENT | *-PRERELEASE | *-ALPHA*)
      err "userland '$1' is not a -RELEASE build: no base.txz exists for it"
      return 1
      ;;
    *-RELEASE)
      printf '%s\n' "$1"
      ;;
    *-RELEASE-*)
      printf '%s\n' "${1%%-p*}"
      ;;
    *)
      err "unrecognized freebsd-version -u output '$1'"
      return 1
      ;;
  esac
}
```

## Purpose

Make the "matching base.txz" rule concrete: the jail userland is built from
the official release artifact for the userland the appliance actually runs.
Patch levels map down to their base release (a `-p3` build uses the
`14.2-RELEASE` artifact); development branches are refused because no release
artifact exists for them.

## Inputs and outputs

- Input: `$1` — `freebsd-version -u` output.
- Output: the release name on stdout (for example `14.2-RELEASE`).
- Return status: 0 on a mappable release, 1 otherwise.

## Side effects

None — pure function.

## Failure modes and exit codes

Returns 1 with a named cause for non-`-RELEASE` builds (`-STABLE`,
`-CURRENT`, `-PRERELEASE`, `-ALPHA`) and for unrecognized output.
`detect_abi` promotes either to a fatal error.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"freebsd_release_from_userland maps patch levels and rejects non-release
builds" — `14.2-RELEASE` passthrough, `14.2-RELEASE-p3` → `14.2-RELEASE`,
`14.3-STABLE` rejected.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)

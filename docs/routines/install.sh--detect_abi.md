# `detect_abi` — install.sh

**Script:** `appliance/opnsense/install.sh`. Detects the jail userland's ABI
and records the coordinates the provisioning steps use.

```sh
detect_abi() {
  # Sets USERLAND_VERSION, RELEASE, ARCH, PKG_ABI, BASE_TXZ_URL.
  command -v freebsd-version >/dev/null 2>&1 ||
    die "freebsd-version not found: cannot detect the jail userland ABI"
  USERLAND_VERSION=$(freebsd-version -u) ||
    die "freebsd-version -u failed: cannot detect the userland version"
  RELEASE=$(freebsd_release_from_userland "$USERLAND_VERSION") ||
    die "cannot derive a downloadable base release from userland '$USERLAND_VERSION'"
  ARCH=$(arch_from_uname "$(uname -m)") ||
    die "cannot map this machine's architecture to a FreeBSD release directory"
  PKG_ABI=$(pkg_abi_for "$RELEASE" "$ARCH")
  BASE_TXZ_URL=$(base_txz_url "$RELEASE" "$ARCH")
}
```

## Purpose

One place where the host is asked what it is: the userland version, the
downloadable release that matches it, the architecture, the pkg ABI, and the
base.txz URL. Everything downstream (`fetch_base_txz`, `install_softflowd`,
the `main` progress line) reads these five variables.

## Inputs and outputs

- Inputs: the host environment (`freebsd-version -u`, `uname -m`).
- Outputs: sets `USERLAND_VERSION`, `RELEASE`, `ARCH`, `PKG_ABI`,
  `BASE_TXZ_URL`.
- Return status: 0 on success; fatal (`die`, exit 1) otherwise.

## Side effects

Sets the five variables. Runs two detection commands; touches no files.

## Failure modes and exit codes

Dies with a named cause when `freebsd-version` is absent (not a FreeBSD host),
when `freebsd-version -u` fails, when the userland version has no
downloadable release (non-`-RELEASE` builds), or when the architecture has no
FreeBSD mapping.

## Tests covering it

No direct bats case — it needs a FreeBSD host. Its building blocks
(`freebsd_release_from_userland`, `pkg_abi_for`, `base_txz_url`) are unit
tested; the composition is verified on device (the runbook's first installer
run prints the detected ABI line).

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
  (the matching-userland rule this implements)

# 0006 — Jail userland from base.txz, softflowd via pkg -r, zero host packages

- **Status:** Accepted
- **Date:** 2026-10-09
- **Source of truth:** component spec (art_4ou8t1mZ), section
  "Locked — architecture and integration", item 6, plus its Layout and
  Platform evidence.

## Context

The spec's layout and evidence fix where the sensor's runtime comes from: the
jail userland comes from the matching FreeBSD `base.txz` ("version detected
via `freebsd-version -u`"), and `softflowd` is installed into the jail root
with `pkg -r` against the official FreeBSD repository — "nothing is installed
on the host except the fragments above."

The merged scaffold implements the chain:

- `install.sh` — `freebsd_release_from_userland` (reads `freebsd-version -u`
  on the host), `arch_from_uname`, `pkg_abi_for`, `detect_abi` (fills
  `FREEBSD_RELEASE`, `PKG_ABI`, `BASE_TXZ_URL`, and dies when any piece is
  missing), `base_txz_url` (join with `base.txz`);
- `fetch_base_txz` / `extract_base_txz` / `install_softflowd` —
  `fetch(1)` (FreeBSD base system), `tar -xzf`, then
  `ABI="$PKG_ABI" pkg -r "$JAIL_ROOT" update` + `install --yes softflowd`;
- each step skips when its marker already exists (`$JAIL_ROOT/bin/sh`,
  `$JAIL_ROOT/usr/local/sbin/softflowd`), so installer re-runs are
  idempotent.

## Decision

The spec's locked item 6, quoted in full:

> "**Jail userland** = matching FreeBSD `base.txz` (detected via
> `freebsd-version -u`) + softflowd installed from the official FreeBSD
> package repository into the jail root. Zero packages installed on the
> host."

## Consequences

- The host stays exactly as OPNsense shipped it plus the fragments from
  [0001](0001-jail-contained-capture-non-vnet-bpf.md) and
  [0005](0005-no-php-gui-configd-actions.md); there is no host package
  repository interaction at all.
- ABI drift is the failure mode the spec's risk table names
  ("FreeBSD/OPNsense version drift (base.txz ABI, port names like `lan0` vs
  legacy drivers)"): the installer detects versions, fails loudly on
  mismatch, accepts explicit interface names, and documents a
  supported-version matrix. `detect_abi` dies when the release or ABI cannot
  be determined; `pkg_abi_for` maps `amd64 → FreeBSD:<major>:amd64` and dies
  on unknown architectures.
- The jail root is fully removable: the manifest records it as
  `tree:<JAIL_ROOT>` and the uninstaller deletes it (`process_manifest`,
  then `rm -rf "$VIGIL_ROOT"`).
- Downloads require network egress at install time (fetch + pkg); the
  on-device runbook covers the boundary — CI deliberately proves nothing
  about it ([0004](0004-posix-sh-runtime-shell-ci.md)).

## Alternatives considered

- **Host softflowd package.** Rejected: locked decision 6 says zero host
  packages, and the host's own softflowd (OPNsense Reporting → NetFlow)
  stays a documented operator fallback, not something this component ships
  ([0001](0001-jail-contained-capture-non-vnet-bpf.md)).
- **A prebuilt jail image tarball shipped in the repo.** Not carried by the
  spec: the locked decision names base.txz + pkg at install time, which
  keeps the repo free of binaries and the ABI always matched to the host.
- **Copying the host userland into the jail.** Not carried by the spec;
  the locked decision names the matching `base.txz` for the detected ABI.

## Related decisions

- [0001 — Capture runs entirely inside the jail](0001-jail-contained-capture-non-vnet-bpf.md)
- [0002 — NetFlow v9 over UDP](0002-netflow-v9-udp-port-2550.md) (softflowd
  is the exporter)
- Routine references: [`detect_abi`](../routines/install.sh--detect_abi.md),
  [`pkg_abi_for`](../routines/install.sh--pkg_abi_for.md),
  [`base_txz_url`](../routines/install.sh--base_txz_url.md),
  [`fetch_base_txz`](../routines/install.sh--fetch_base_txz.md),
  [`extract_base_txz`](../routines/install.sh--extract_base_txz.md),
  [`install_softflowd`](../routines/install.sh--install_softflowd.md).

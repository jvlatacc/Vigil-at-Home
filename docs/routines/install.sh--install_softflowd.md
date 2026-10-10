# `install_softflowd` — install.sh

**Script:** `appliance/opnsense/install.sh`. Installs softflowd into the jail
root — never onto the host.

```sh
install_softflowd() {
  # Installs softflowd into the jail root via pkg -r with the jail
  # userland's ABI override (locked decision 6: zero packages on the host).
  if [ -x "$JAIL_ROOT/usr/local/sbin/softflowd" ]; then
    printf '%s: softflowd already installed in jail, skipping\n' "${0##*/}"
    return 0
  fi
  ASSUME_ALWAYS_YES=yes ABI="$PKG_ABI" pkg -r "$JAIL_ROOT" update ||
    die "pkg -r update failed: cannot refresh the package catalog for the jail"
  ASSUME_ALWAYS_YES=yes ABI="$PKG_ABI" pkg -r "$JAIL_ROOT" install --yes softflowd ||
    die "pkg -r install softflowd failed: see the pkg output above"
}
```

## Purpose

Put the flow exporter inside the jail: `pkg -r "$JAIL_ROOT"` targets the jail
root, and the `ABI="$PKG_ABI"` override makes pkg resolve binaries for the
jail userland's FreeBSD major version and architecture (locked decision 6:
zero packages on the host — the code comment says exactly that).

## Inputs and outputs

- Inputs: `JAIL_ROOT`, `PKG_ABI` (from `detect_abi`).
- Output: none of its own; pkg's own output streams through.
- Return status: 0 on success or skip; fatal (`die`, exit 1) on failure.

## Side effects

Runs `pkg -r update` (catalog refresh) and `pkg -r install --yes softflowd`
against the jail root; network egress to the FreeBSD package repository. The
presence of `$JAIL_ROOT/usr/local/sbin/softflowd` marks it done, so re-runs
skip.

## Failure modes and exit codes

Dies on catalog refresh failure or install failure; the cause points at the
pkg output above for the detail.

## Tests covering it

No direct bats case (needs the network and a FreeBSD jail root). The on-device
runbook's `jexec vigil-flow /usr/local/sbin/softflowd --version`-class checks
(landing with the daemon change) confirm the binary runs inside the jail.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (softflowd is the exporter the version keys configure)

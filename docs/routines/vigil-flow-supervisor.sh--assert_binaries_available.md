# `assert_binaries_available` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. checks softflowd and softflowctl are executable.

```sh
assert_binaries_available() {
  # Capture cannot work without the exporter. Both ship inside the jail via
  # the installer's `pkg -r` step (locked decision 6).
  VALIDATE_ERROR=''
  [ -x "$VIGIL_FLOW_SOFTFLOWD" ] || {
    VALIDATE_ERROR="softflowd_missing: $VIGIL_FLOW_SOFTFLOWD is not executable (install_softflowd runs in the jail root)"
    return 1
  }
  [ -x "$VIGIL_FLOW_SOFTFLOWCTL" ] || {
    VALIDATE_ERROR="softflowctl_missing: $VIGIL_FLOW_SOFTFLOWCTL is not executable"
    return 1
  }
}
```

## Purpose

Capture cannot work without the exporter. Both ship inside the jail via the installer's `pkg -r` step, so a missing binary means the jail userland is incomplete — named, not assumed.

## Inputs and outputs

- Input: `$VIGIL_FLOW_SOFTFLOWD` (default `/usr/local/sbin/softflowd`) and `$VIGIL_FLOW_SOFTFLOWCTL` (default `/usr/local/bin/softflowctl`).
- Return status: 0 both executable; 1 with a named cause otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 with `softflowd_missing: ...` or `softflowctl_missing: ...`.

## Tests covering it

Statemachine suite: "a vanished softflowd binary degrades with softflowd_missing"

## Linked decisions

- [0006 — Jail userland from base.txz, softflowd via pkg -r, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md) — the exporter is installed into the jail root, not the host

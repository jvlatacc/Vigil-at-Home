# `assert_bpf_available` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. fails the gate with a named cause when no bpf device is openable.

```sh
assert_bpf_available() {
  # The runbook's first stop (spec): if the devfs grant is gone — e.g. a
  # firmware upgrade rewrote /etc/devfs.rules — the sensor must say exactly
  # that instead of running blind.
  VALIDATE_ERROR=''
  find_openable_bpf >/dev/null 2>&1 || {
    VALIDATE_ERROR="bpf_missing: no openable $VIGIL_FLOW_BPF_DIR/bpf* device (is the [devfsrules_vigil_flow] grant in /etc/devfs.rules?)"
    return 1
  }
}
```

## Purpose

The runbook's first stop (spec): if the devfs grant is gone — e.g. a firmware upgrade rewrote `/etc/devfs.rules` — the sensor must say exactly that instead of running blind. Wraps `find_openable_bpf` and names the likely cause in the health file.

## Inputs and outputs

- Side output: sets `VALIDATE_ERROR` on failure.
- Return status: 0 a device is openable; 1 with `bpf_missing: ...` otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 with `bpf_missing: no openable /dev/bpf* device (is the [devfsrules_vigil_flow] grant in /etc/devfs.rules?)`.

## Tests covering it

Validator suite: "validation names the lost bpf grant when no bpf device is openable"; statemachine suite: "losing the bpf grant degrades with bpf_missing and recovery is automatic" (degrade plus automatic recovery when the grant returns).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the grant is a real privilege and its loss must be visible

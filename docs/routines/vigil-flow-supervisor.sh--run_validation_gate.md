# `run_validation_gate` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. runs the full validation gate shared by the supervisor and ctl validate.

```sh
run_validation_gate() {
  # The full VALIDATE-phase gate, shared by the supervisor and ctl validate:
  # config grammar, value ranges, required keys, host binaries, interface
  # existence, and an openable bpf device. On failure the named cause is in
  # VALIDATE_ERROR.
  load_config || return 1
  validate_loaded_config || return 1
  assert_binaries_available || return 1
  capture_interfaces_exist || return 1
  assert_bpf_available || return 1
  return 0
}
```

## Purpose

One implementation of the VALIDATE phase: config grammar and per-key checks (`load_config`), required keys (`validate_loaded_config`), exporter binaries (`assert_binaries_available`), interface existence (`capture_interfaces_exist`), and an openable bpf device (`assert_bpf_available`). The ctl script sources the supervisor's functions so validation logic exists exactly once.

## Inputs and outputs

- Inputs: `$VIGIL_FLOW_CONFIG` and the overridable locations it implies.
- Return status: 0 all checks pass; 1 with the first failing check named in `VALIDATE_ERROR`.

## Side effects

None beyond the checks themselves.

## Failure modes and exit codes

Returns 1 naming the first failed check; the cause string is what the health file's `degraded_cause` carries.

## Tests covering it

Validator suite: "validation gate accepts the fixture config end to end"; statemachine suite: "ctl start with an invalid config fails and writes DEGRADED health" (a failed gate from `ctl start` writes the DEGRADED health record).

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — one validation implementation, sourced not copied
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the export values the gate guards

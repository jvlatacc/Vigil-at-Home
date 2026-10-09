# `supervise_once` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. runs one supervision tick.

```sh
supervise_once() {
  # One poll cycle. No `set -e`: a supervisor must survive unexpected
  # command failures, so every fallible command here is handled explicitly.
  if [ "$STATE" = DEGRADED ]; then
    supervise_recover
    return 0
  fi
  # Runtime prerequisites (spec: lost bpf, a vanished interface, or a
  # vanished binary must be named in the health file, never run blind).
  assert_bpf_available || {
    stop_all_children
    degrade "$VALIDATE_ERROR"
    return 0
  }
  capture_interfaces_exist || {
    stop_all_children
    degrade "$VALIDATE_ERROR"
    return 0
  }
  assert_binaries_available || {
    stop_all_children
    degrade "$VALIDATE_ERROR"
    return 0
  }
  supervise_children
  if [ "$STATE" = DEGRADED ]; then
    write_health
    return 0
  fi
  poll_stats
  if [ "$STATE" = RESTARTING ] && registry_all_alive; then
    CONSECUTIVE_RESTART_FAILURES=0
    set_state RUNNING
    return 0
  fi
  write_health
  return 0
}
```

## Purpose

The poll cycle body. In DEGRADED it only attempts recovery. Otherwise the runtime prerequisites are re-checked every tick — bpf openable, interfaces present, binaries executable — and a lost prerequisite stops the children and degrades with the named cause (the spec's lost-bpf case: the sensor must never run blind). Then dead children are restarted (`supervise_children`), statistics polled (`poll_stats`), a completed restart streak returns the state to RUNNING, and the health file is rewritten.

## Inputs and outputs

- Input: `STATE` and the supervision state.
- Effects: the full tick's transitions, spawns, and health write.

## Side effects

Starts and stops children; rewrites the health file.

## Failure modes and exit codes

Never fails the caller: every fallible command is handled explicitly — the supervisor deliberately runs without `set -e`, because an unhandled non-zero must degrade the sensor, not kill it dark.

## Tests covering it

The tick-driven statemachine cases: "losing the bpf grant degrades with bpf_missing and recovery is automatic", "a vanished softflowd binary degrades with softflowd_missing", "a dead child is restarted, counted, and health returns to RUNNING", "restart bound exhaustion degrades with a named cause".

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — never run blind: prerequisites are re-checked every tick

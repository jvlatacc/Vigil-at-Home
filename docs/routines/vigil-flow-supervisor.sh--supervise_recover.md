# `supervise_recover` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. re-runs the gate from DEGRADED and resumes automatically when the cause is fixed.

```sh
supervise_recover() {
  # DEGRADED tick: re-run the whole gate; a fixed cause resumes supervision
  # automatically with no operator restart (the spec's dashed recovery edge
  # is honored either way — reconfigure re-runs this same gate).
  if run_validation_gate && spawn_all_children; then
    CONSECUTIVE_RESTART_FAILURES=0
    DEGRADED_CAUSE=''
    set_state RUNNING
    return 0
  fi
  [ -n "$VALIDATE_ERROR" ] && DEGRADED_CAUSE=$VALIDATE_ERROR
  write_health
  return 0
}
```

## Purpose

The DEGRADED tick: the whole validation gate runs again and, when it passes, all children are respawned and the state returns to RUNNING with the cause and failure counter cleared — automatic recovery, no operator restart needed. `reconfigure` lands here too: it fixes the config and lets the next tick (or a restart) re-run this gate. When the gate still fails, the (possibly new) cause is written and DEGRADED continues.

## Inputs and outputs

- Effects: may respawn children; rewrites the health file either way.

## Side effects

Starts processes on recovery; writes the health file.

## Failure modes and exit codes

Never fails the caller: a still-failing gate keeps the sensor in DEGRADED with the named cause.

## Tests covering it

"losing the bpf grant degrades with bpf_missing and recovery is automatic" asserts recovery is automatic once the bpf grant returns.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — recovery without operator intervention whenever the cause clears

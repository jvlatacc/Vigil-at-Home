# `graceful_stop` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. SIGTERM/SIGINT handler: stop children, leave a final truthful record.

```sh
graceful_stop() {
  # SIGTERM handler (jail exec.stop and ctl stop both land here): flush and
  # stop the children, then leave one final truthful health record.
  trap - TERM INT
  stop_all_children
  rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
  mark_stopped_and_write_health
  exit 0
}
```

## Purpose

The jail's `exec.stop` and `ctl stop` both land here. The trap is removed first (no re-entry), children are stopped gracefully (`stop_all_children` — the final export attempt), the supervisor pidfile is removed, and the health file gets one final STOPPED record before the process exits 0.

## Inputs and outputs

- Effects: stops children; removes the supervisor pidfile; writes the STOPPED health record; exits 0.

## Side effects

Signals children; removes the pidfile; writes the health file.

## Failure modes and exit codes

Exits the process with status 0 by design — a stop is not a failure.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" (STOPPED state, no supervisor process, no children).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the stop path also leaves the health file truthful

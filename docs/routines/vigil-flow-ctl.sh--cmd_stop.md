# `cmd_stop` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. stops the sensor gracefully and leaves a STOPPED record.

```sh
cmd_stop() {
  if supervisor_running; then
    _stop_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)
    # TERM hands the supervisor its graceful path: softflowctl shutdown
    # (final export attempt), then signal escalation, then a STOPPED record.
    kill -TERM "$_stop_pid" 2>/dev/null || true
    if ! wait_for_supervisor_exit "$_stop_pid"; then
      err "supervisor pid $_stop_pid ignored SIGTERM; sending SIGKILL"
      kill -KILL "$_stop_pid" 2>/dev/null || true
      rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
    fi
  fi
  sweep_orphan_softflowd
  # Leave one final truthful record even on the orphan path, where no
  # supervisor existed to write it. The state machine's variables belong
  # to the supervisor — the helper, not raw assignment, writes them.
  load_config >/dev/null 2>&1 || true
  mark_stopped_and_write_health
  printf 'vigil-flow: stopped\n'
  return 0
}
```

## Purpose

The `stop` command. SIGTERM hands the supervisor its graceful path (final export attempt, STOPPED record, pidfile removal); a supervisor that ignores SIGTERM for 10 seconds is SIGKILLed and its pidfile removed. The orphan sweep then removes any softflowd left behind, and — reusing the supervisor's helper so stop-state writes stay in one place — a final truthful STOPPED record is written even on the orphan path, where no supervisor existed to write it. Idempotent: stopping a stopped sensor still writes the record and returns 0.

## Inputs and outputs

- Return status: 0 stopped (always, when the jail commands succeed at all).

## Side effects

Signals the supervisor and orphans; removes stale files; writes the health file.

## Failure modes and exit codes

Exit 0 by design; failures inside the jail surface as the jail's own errors.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" (STOPPED state, no supervisor, no children).

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the operator's stop command
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — even the stop path leaves a truthful health record

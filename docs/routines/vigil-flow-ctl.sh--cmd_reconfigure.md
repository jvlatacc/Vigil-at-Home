# `cmd_reconfigure` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. re-applies the configuration to a running sensor.

```sh
cmd_reconfigure() {
  # Re-apply the configuration: validate first, then restart the sensor so
  # the new values are live. A failing validation leaves a running sensor
  # untouched (it keeps exporting with the last known-good config).
  if ! run_validation_gate; then
    err "$VALIDATE_ERROR"
    exit 1
  fi
  if supervisor_running; then
    _re_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null)
    kill -TERM "$_re_pid" 2>/dev/null || true
    wait_for_supervisor_exit "$_re_pid" ||
      rm -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null || true
  fi
  cmd_start
}
```

## Purpose

The `reconfigure` command. Validates first: a failing validation leaves a running sensor untouched — it keeps exporting with the last known-good configuration — and exits 1 with the cause. A valid configuration restarts the sensor: the running supervisor is SIGTERMed and waited for, then `cmd_start` brings the new values live. This is also the recovery command for a DEGRADED sensor once the cause is fixed.

## Inputs and outputs

- Return status: 0 reconfigured; 1 when validation fails.

## Side effects

Stops and restarts the supervisor; the health file is rewritten through the normal transitions.

## Failure modes and exit codes

Exit 1 with the named cause on a failed validation; the sensor keeps running its previous configuration in that case.

## Tests covering it

"ctl reconfigure applies a changed interface list" (a changed interface list takes effect).

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the operator's apply-changes command

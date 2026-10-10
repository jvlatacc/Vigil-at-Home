# `supervisor_running` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. reports whether the supervisor's pidfile names a live process.

```sh
supervisor_running() {
  # True when the supervisor pidfile points at a live process.
  [ -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ] || return 1
  _srun_pid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null) || return 1
  case $_srun_pid in
    '' | *[!0-9]*) return 1 ;;
  esac
  kill -0 "$_srun_pid" 2>/dev/null
}
```

## Purpose

Reads `$VIGIL_FLOW_SUPERVISOR_PIDFILE` and checks the pid with `kill -0`. Guards idempotent starts and tells stop/reconfigure whether a graceful handoff is possible.

## Inputs and outputs

- Return status: 0 running; 1 not running.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller (a 1 is a state answer).

## Tests covering it

"ctl start is idempotent while the sensor is running" (a second start while running is a no-op) and "ctl stop leaves STOPPED, no supervisor, and no children".

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — idempotent operator commands

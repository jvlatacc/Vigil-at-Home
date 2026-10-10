# `run_supervisor` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. the supervisor's main path: BOOT → VALIDATE → RUNNING → supervise loop.

```sh
run_supervisor() {
  # Deliberately no `set -e`: every fallible command is handled explicitly,
  # because an unhandled nonzero must degrade the sensor, not kill it dark.
  set -u
  trap graceful_stop TERM INT
  # Two supervisors would fight over one softflowd fleet and one health
  # file — refuse instead of clobbering (ctl start checks too; this is the
  # backstop for direct `supervisor.sh run` invocations).
  if [ -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ]; then
    _rs_oldpid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null) || _rs_oldpid=''
    case $_rs_oldpid in
      '' | *[!0-9]*) ;;
      *) kill -0 "$_rs_oldpid" 2>/dev/null &&
        die "supervisor already running (pid $_rs_oldpid)" ;;
    esac
  fi
  write_supervisor_pidfile
  set_state BOOTING
  # BOOT exits when the config file is found and readable (spec); a missing
  # or unreadable file takes the BOOT -> DEGRADED edge directly.
  if [ ! -f "$VIGIL_FLOW_CONFIG" ] || [ ! -r "$VIGIL_FLOW_CONFIG" ]; then
    degrade "config_missing: no readable configuration file at $VIGIL_FLOW_CONFIG"
    supervise_loop
    return 0
  fi
  set_state VALIDATE
  # VALIDATE runs the full gate: grammar, ranges, required keys, binaries,
  # interface existence, and an openable bpf device.
  if run_validation_gate && spawn_all_children; then
    CONSECUTIVE_RESTART_FAILURES=0
    DEGRADED_CAUSE=''
    set_state RUNNING
  else
    degrade "$VALIDATE_ERROR"
  fi
  supervise_loop
  return 0
}
```

## Purpose

Installs the SIGTERM/SIGINT trap, refuses to start when the pidfile names a live supervisor (the backstop behind `ctl start`'s check — two supervisors would fight over one softflowd fleet and one health file), writes its own pidfile, and walks the state machine: BOOTING (config missing or unreadable degrades immediately and the loop keeps re-checking), VALIDATE (the full gate plus child spawn), RUNNING on success or DEGRADED with the named cause, then the supervise loop forever. Deliberately no `set -e`: every fallible command is handled explicitly.

## Inputs and outputs

- Input: `$VIGIL_FLOW_CONFIG` and the overridable locations.
- Effects: the daemon's entire lifetime behavior.

## Side effects

Writes the pidfile and health file; spawns and supervises children.

## Failure modes and exit codes

Usage-level fatal cases `die` (exit 1); everything else degrades the sensor.

## Tests covering it

"ctl start reaches RUNNING and the stub records the exact spec argv" (drives a full boot to RUNNING through the stub), "ctl start with an invalid config fails and writes DEGRADED health" (boot with an invalid config), "losing the bpf grant degrades with bpf_missing and recovery is automatic".

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the state machine and its health contract
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — explicit error handling in POSIX sh

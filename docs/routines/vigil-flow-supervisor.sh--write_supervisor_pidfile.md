# `write_supervisor_pidfile` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. records the supervisor's own pid.

```sh
write_supervisor_pidfile() {
  mkdir -p "$(dirname "$VIGIL_FLOW_SUPERVISOR_PIDFILE")" 2>/dev/null
  printf '%s\n' "$$" > "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ||
    die "cannot write supervisor pidfile $VIGIL_FLOW_SUPERVISOR_PIDFILE"
}
```

## Purpose

Creates the pidfile directory if needed and writes `$$` to `$VIGIL_FLOW_SUPERVISOR_PIDFILE` (default `/var/run/vigil-flow-supervisor.pid`). The pidfile is the single-instance lock's other half: `run_supervisor` refuses to start when it names a live process.

## Inputs and outputs

- Effects: creates the pidfile.

## Side effects

Writes the pidfile; may create `/var/run`-style directories.

## Failure modes and exit codes

`die`s (exit 1) when the pidfile cannot be written.

## Tests covering it

Exercised via the pidfile assertions in the statemachine suite's start and stop cases ("ctl start reaches RUNNING and the stub records the exact spec argv", "ctl stop leaves STOPPED, no supervisor, and no children").

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — single instance enforced by pidfile, portably

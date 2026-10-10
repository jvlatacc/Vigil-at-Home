# `wait_for_supervisor_exit` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. waits, bounded, for a stopping supervisor to disappear.

```sh
wait_for_supervisor_exit() {
  # $1 = supervisor pid. Waits (bounded) for the process to disappear after
  # a TERM; the supervisor removes its own pidfile in graceful_stop.
  _we_pid=$1
  _we_i=0
  while [ "$_we_i" -lt 100 ]; do
    kill -0 "$_we_pid" 2>/dev/null || return 0
    sleep 0.1
    _we_i=$((_we_i + 1))
  done
  return 1
}
```

## Purpose

Polls `kill -0` up to 100 times at 0.1s (10 seconds) after a SIGTERM. The supervisor removes its own pidfile in `graceful_stop`; a supervisor that ignores SIGTERM for 10 seconds gets the SIGKILL fallback in `cmd_stop`.

## Inputs and outputs

- Input: `$1` — the supervisor pid.
- Return status: 0 exited; 1 still alive after the bound.

## Side effects

None (polls only).

## Failure modes and exit codes

Returns 1 on timeout; the caller decides the escalation.

## Tests covering it

Exercised via the stop path in "ctl stop leaves STOPPED, no supervisor, and no children".

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — bounded waits, portable polling

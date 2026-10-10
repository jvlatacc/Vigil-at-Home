# `stop_child` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. stops one softflowd child gracefully.

```sh
stop_child() {
  # $1 = interface. Best-effort graceful stop of one child: softflowctl
  # shutdown asks softflowd to flush and export remaining flows before
  # exiting; escalate to signals on a bounded schedule. The || true on wait
  # is deliberate: wait fails when the pid is not our child or is already
  # reaped, which is exactly the tolerated case here.
  _st_iface=$1
  child_get "$_st_iface"
  [ -n "$C_PID" ] || return 0
  case $C_PID in '' | *[!0-9]*) return 0 ;; esac
  "$VIGIL_FLOW_SOFTFLOWCTL" -c "$(ctlfile_for "$_st_iface")" shutdown >/dev/null 2>&1 ||
    true
  _st_i=0
  while [ "$_st_i" -lt 20 ]; do
    kill -0 "$C_PID" 2>/dev/null || break
    sleep 0.1
    _st_i=$((_st_i + 1))
  done
  if kill -0 "$C_PID" 2>/dev/null; then
    kill -TERM "$C_PID" 2>/dev/null || true
    _st_i=0
    while [ "$_st_i" -lt 20 ]; do
      kill -0 "$C_PID" 2>/dev/null || break
      sleep 0.1
      _st_i=$((_st_i + 1))
    done
  fi
  kill -KILL "$C_PID" 2>/dev/null || true
  wait "$C_PID" 2>/dev/null || true
  rm -f "$(pidfile_for "$_st_iface")" "$(ctlfile_for "$_st_iface")" 2>/dev/null || true
}
```

## Purpose

Asks softflowd (via `softflowctl shutdown`) to flush and export remaining flows before exiting — the final export attempt — then escalates on a bounded schedule: up to 2 seconds of polling, SIGTERM, 2 more seconds, SIGKILL. The tolerated `wait` failure (pid not ours or already reaped) is deliberate.

## Inputs and outputs

- Input: `$1` — interface name.
- Effects: the child exits; pidfile and control socket removed.

## Side effects

Sends signals; removes the per-interface pidfile and control socket.

## Failure modes and exit codes

Never fails the caller: every escalation step tolerates an already-dead child.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" asserts no supervisor and no children survive a stop.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the final export attempt honors 'a crash never leaves flows unreported'

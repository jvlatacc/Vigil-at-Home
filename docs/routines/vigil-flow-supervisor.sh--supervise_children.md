# `supervise_children` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. restarts dead children with backoff; exhausts the bound into DEGRADED.

```sh
supervise_children() {
  # Liveness pass over the registry: restart dead children with backoff,
  # increment the consecutive-failure counter, and degrade with a named
  # cause when the restart bound is exhausted.
  _sc_restarted=0
  _sc_lines=''
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _sc_iface _sc_pid _sc_attempts _sc_flows; do
    [ -n "$_sc_iface" ] || continue
    if kill -0 "$_sc_pid" 2>/dev/null; then
      _sc_lines="$_sc_lines$_sc_iface|$_sc_pid|0|$_sc_flows
"
      continue
    fi
    # Child died: reap it (tolerated failure if already reaped) and restart.
    wait "$_sc_pid" 2>/dev/null || true
    _sc_attempts=$((_sc_attempts + 1))
    CONSECUTIVE_RESTART_FAILURES=$((CONSECUTIVE_RESTART_FAILURES + 1))
    if [ "$_sc_attempts" -gt "$VIGIL_FLOW_MAX_CONSEC_RESTARTS" ]; then
      degrade "restart_exhausted: softflowd for '$_sc_iface' failed $_sc_attempts consecutive starts (last pid $_sc_pid)"
      return 0
    fi
    set_state RESTARTING
    sleep "$(restart_backoff_seconds "$_sc_attempts")"
    spawn_child "$_sc_iface" "$_sc_attempts" || {
      degrade "$VALIDATE_ERROR"
      return 0
    }
    _sc_restarted=1
    child_get "$_sc_iface"
    _sc_lines="$_sc_lines$_sc_iface|$C_PID|$C_ATTEMPTS|$_sc_flows
"
  done <<EOF
$CHILDREN
EOF
  CHILDREN=$_sc_lines
  if [ "$_sc_restarted" -eq 0 ] && [ "$CONSECUTIVE_RESTART_FAILURES" -ne 0 ]; then
    # Every child confirmed alive: the failure streak is over.
    CONSECUTIVE_RESTART_FAILURES=0
  fi
  return 0
}
```

## Purpose

Liveness pass over the registry: a live child has its attempt count reset; a dead one is reaped, its attempt count and `consecutive_restart_failures` increment, and — while the attempt count stays within `$VIGIL_FLOW_MAX_CONSEC_RESTARTS` (5) — the state moves to RESTARTING and a new child spawns after the backoff. When the bound exhausts, the sensor degrades with a `restart_exhausted:` cause. When a pass restarts nothing and the failure counter is non-zero, the streak is over and the counter resets.

## Inputs and outputs

- Input: `$CHILDREN`.
- Effects: may respawn children; may `degrade`; rewrites `$CHILDREN`.

## Side effects

Starts processes; rewrites the health file through `set_state`/`degrade`.

## Failure modes and exit codes

Never fails the caller: exhaustion degrades the sensor instead of exiting.

## Tests covering it

"a dead child is restarted, counted, and health returns to RUNNING" (restart, count, recovery) and "restart bound exhaustion degrades with a named cause" (bound exhaustion names the cause).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the health file reports every restart honestly
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — bounded retries, explicit handling — no `set -e` surprises

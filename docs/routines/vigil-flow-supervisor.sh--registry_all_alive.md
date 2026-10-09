# `registry_all_alive` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. reports whether every registered child process is alive.

```sh
registry_all_alive() {
  # True when every registered child process is alive.
  [ -n "$CHILDREN" ] || return 1
  while IFS='|' read -r _ra_iface _ra_pid _ra_attempts _ra_flows; do
    [ -n "$_ra_iface" ] || continue
    kill -0 "$_ra_pid" 2>/dev/null || return 1
  done <<EOF
$CHILDREN
EOF
  return 0
}
```

## Purpose

The RESTARTING → RUNNING edge condition: after restarts, the state returns to RUNNING only when every pid in the registry answers `kill -0`. An empty registry is reported as not-all-alive.

## Inputs and outputs

- Input: `$CHILDREN`.
- Return status: 0 all alive; 1 otherwise.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller (a 1 is a state answer, not an error).

## Tests covering it

Exercised via the recovery assertions in "a dead child is restarted, counted, and health returns to RUNNING".

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — liveness via kill -0, no external process helpers

# `stop_all_children` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. stops every registered child.

```sh
stop_all_children() {
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _sa_iface _sa_pid _sa_attempts _sa_flows; do
    [ -n "$_sa_iface" ] || continue
    stop_child "$_sa_iface"
  done <<EOF
$CHILDREN
EOF
  CHILDREN=''
}
```

## Purpose

Iterates the registry and stops each child, then clears the registry. Used by the runtime-prerequisite failures in `supervise_once` and by `graceful_stop`.

## Inputs and outputs

- Input: `$CHILDREN`.
- Effects: all children stopped; `$CHILDREN` emptied.

## Side effects

Signals every child; clears the registry.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

"ctl stop leaves STOPPED, no supervisor, and no children" asserts the registry is empty afterward.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — bounded, portable process cleanup

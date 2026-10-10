# `child_set` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. upserts one interface's registry entry.

```sh
child_set() {
  # $1 = interface, $2 = pid, $3 = attempts, $4 = flows; upserts the
  # registry line for the interface.
  _cs_rest=''
  [ -n "$CHILDREN" ] || CHILDREN=''
  while IFS='|' read -r _cs_iface _cs_pid _cs_attempts _cs_flows; do
    [ -n "$_cs_iface" ] || continue
    if [ "$_cs_iface" = "$1" ]; then
      continue # replaced below
    fi
    _cs_rest="$_cs_rest$_cs_iface|$_cs_pid|$_cs_attempts|$_cs_flows
"
  done <<EOF
$CHILDREN
EOF
  CHILDREN="$_cs_rest$1|$2|$3|$4
"
}
```

## Purpose

Writes the `iface|pid|attempts|flows` line for an interface, replacing any existing line for it and preserving the rest.

## Inputs and outputs

- Input: `$1` interface, `$2` pid, `$3` attempts, `$4` flows.
- Effects: rewrites `$CHILDREN`.

## Side effects

Mutates the registry variable.

## Failure modes and exit codes

Never fails.

## Tests covering it

Exercised through the statemachine suite's restart cases ("a dead child is restarted, counted, and health returns to RUNNING").

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — registry in plain shell variables, no temp files

# `child_get` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. reads one interface's registry entry.

```sh
child_get() {
  # $1 = interface; sets C_PID / C_ATTEMPTS from the registry (empty when
  # the interface has no registry entry).
  C_PID=''
  C_ATTEMPTS=''
  [ -n "$CHILDREN" ] || return 0
  while IFS='|' read -r _cg_iface _cg_pid _cg_attempts _cg_flows; do
    [ -n "$_cg_iface" ] || continue
    if [ "$_cg_iface" = "$1" ]; then
      C_PID=$_cg_pid
      C_ATTEMPTS=$_cg_attempts
      return 0
    fi
  done <<EOF
$CHILDREN
EOF
  return 0
}
```

## Purpose

The child registry (`$CHILDREN`) holds one `iface|pid|attempts|flows` line per capture interface. `child_get` extracts an interface's pid and attempt count into `C_PID` / `C_ATTEMPTS`.

## Inputs and outputs

- Input: `$1` — interface name.
- Outputs: `C_PID`, `C_ATTEMPTS` (empty when absent).

## Side effects

Sets the two output variables.

## Failure modes and exit codes

Never fails; a missing entry yields empty variables.

## Tests covering it

Exercised through the statemachine suite's restart and stop cases.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — registry in plain shell variables, no temp files

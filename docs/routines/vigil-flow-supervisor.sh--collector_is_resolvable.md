# `collector_is_resolvable` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. advisory check that the collector host resolves.

```sh
collector_is_resolvable() {
  # Advisory only (spec): a firewalled or unresolvable collector must never
  # prevent capture from starting. IP literals need no resolution; hostnames
  # are resolved with getent when available. Callers print the advisory and
  # move on; runtime export failures surface through statistics polling.
  case $CFG_COLLECTOR_HOST in
    '' | *[!0-9.]*)
      command -v getent >/dev/null 2>&1 || return 0
      getent hosts "$CFG_COLLECTOR_HOST" >/dev/null 2>&1 || return 1
      ;;
  esac
  return 0
}
```

## Purpose

Deliberately advisory (spec): a firewalled or unresolvable collector must never prevent capture from starting. IP literals need no resolution; hostnames are resolved with `getent hosts` when available. Export problems surface later in the statistics polling, where they belong.

## Inputs and outputs

- Input: `$CFG_COLLECTOR_HOST`.
- Return status: 0 resolvable (or check unavailable); 1 unresolvable.

## Side effects

None.

## Failure modes and exit codes

Returns 1 only as an advisory for hostname configs that do not resolve; callers print a note and continue.

## Tests covering it

Statemachine suite: "an unreachable collector never blocks startup (stats-poll concern)"

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the collector is the export destination; startup must not depend on it

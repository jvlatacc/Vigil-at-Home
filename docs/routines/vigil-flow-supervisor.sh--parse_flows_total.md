# `parse_flows_total` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. extracts the cumulative flow count from softflowctl statistics output.

```sh
parse_flows_total() {
  # $1 = `softflowctl statistics` output. Prints the cumulative flow count
  # (active + expired; every tracked flow eventually expires) and returns 1
  # when the expected counters are missing, so a poll of garbage output is
  # treated as unsuccessful rather than zeroing the total.
  _pf_active=$(printf '%s\n' "$1" | sed -n 's/^Number of active flows: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
  _pf_expired=$(printf '%s\n' "$1" | sed -n 's/^Flows expired: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
  [ -n "$_pf_active" ] && [ -n "$_pf_expired" ] || return 1
  printf '%s\n' $((_pf_active + _pf_expired))
}
```

## Purpose

Sums the `Number of active flows` and `Flows expired` counters (every tracked flow eventually expires, so the sum is the cumulative total). Returns failure when the counters are missing so a poll of garbage output is treated as unsuccessful rather than zeroing the total.

## Inputs and outputs

- Input: `$1` — `softflowctl statistics` output.
- Output: the sum on stdout.
- Return status: 0 counters found; 1 otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 when either counter line is absent.

## Tests covering it

Exercised inside the statemachine suite's stats cases ("an unreachable collector never blocks startup (stats-poll concern)", "a dead child is restarted, counted, and health returns to RUNNING") where the stub emits statistics text.

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — flow counters describe the export pipeline's progress

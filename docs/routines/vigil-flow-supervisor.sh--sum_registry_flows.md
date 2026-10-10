# `sum_registry_flows` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. sums the per-interface flow counters.

```sh
sum_registry_flows() {
  # Prints the sum of the per-interface flow counters.
  _sr_total=0
  [ -n "$CHILDREN" ] || {
    printf '0\n'
    return 0
  }
  while IFS='|' read -r _sr_iface _sr_pid _sr_attempts _sr_flows; do
    [ -n "$_sr_iface" ] || continue
    case $_sr_flows in
      '' | *[!0-9]*) _sr_flows=0 ;;
    esac
    _sr_total=$((_sr_total + _sr_flows))
  done <<EOF
$CHILDREN
EOF
  printf '%s\n' "$_sr_total"
}
```

## Purpose

The health file's `flows_total` is the sum of every registered child's counter; non-numeric entries count as zero.

## Inputs and outputs

- Input: `$CHILDREN`.
- Output: the sum on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

Exercised via the health-file assertions in the statemachine suite ("health output is valid JSON", "a dead child is restarted, counted, and health returns to RUNNING").

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — flows_total describes the export pipeline

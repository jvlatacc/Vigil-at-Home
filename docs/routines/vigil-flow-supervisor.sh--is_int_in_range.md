# `is_int_in_range` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. checks that a value is numeric and within an inclusive range.

```sh
is_int_in_range() {
  # $1 = value, $2 = min, $3 = max. Numeric and within the range.
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}
```

## Purpose

Generic numeric range check used for the `active_timeout`, `inactive_timeout` (1-604800 seconds) and `max_flows` (1-1048576) config keys.

## Inputs and outputs

- Input: `$1` value, `$2` minimum, `$3` maximum.
- Return status: 0 when valid; 1 otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 for empty or non-numeric values and for values outside the range.

## Tests covering it

Validator suite rejections: "validation rejects an out-of-range active timeout" and "validation rejects a max_flows of zero".

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — timeout tunables are passed straight through to softflowd

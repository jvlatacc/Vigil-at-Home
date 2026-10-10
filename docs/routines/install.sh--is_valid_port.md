# `is_valid_port` — install.sh

**Script:** `appliance/opnsense/install.sh`. Port validator for the collector
port.

```sh
is_valid_port() {
  # $1 = candidate port. Numeric and within 1-65535.
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
```

## Purpose

Accept only a numeric TCP/UDP port in the valid range. Used by
`split_collector` for the `HOST[:PORT]` collector spec, so an out-of-range or
non-numeric port is rejected before it can reach the sensor configuration.

## Inputs and outputs

- Input: `$1` — candidate port.
- Output: none. Return status 0 when valid, 1 otherwise.

## Side effects

None — pure predicate.

## Failure modes and exit codes

Returns 1 (and the caller reports the named cause) when the value is empty,
contains a non-digit character, or is outside 1-65535.

## Tests covering it

Covered through `parse_args` in `appliance/opnsense/tests/installer.bats`:

- "parse_args rejects a collector with an out-of-range port" (`:70000`)
- "parse_args rejects a collector port of zero" (`:0`)

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)

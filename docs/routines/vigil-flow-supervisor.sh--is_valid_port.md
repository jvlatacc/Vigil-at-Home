# `is_valid_port` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. checks that a port is numeric and within 1-65535.

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

Shared charset/range check for `collector_port` in the config parser.

## Inputs and outputs

- Input: `$1` — the candidate port.
- Return status: 0 when valid; 1 otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 with no output for empty, non-numeric, zero, or over-65535 values.

## Tests covering it

Validator suite rejections: "validation rejects a collector port above 65535" and "validation rejects a collector port of zero".

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — port 2550 is the product default; the range check protects the export socket
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — shared implementation discipline between installer and supervisor

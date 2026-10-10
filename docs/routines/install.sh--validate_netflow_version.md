# `validate_netflow_version` — install.sh

**Script:** `appliance/opnsense/install.sh`. Accepts only the two export
versions the sensor config surface carries.

```sh
validate_netflow_version() {
  # $1 = netflow_version config value.
  case $1 in
    9 | ipfix) return 0 ;;
    *) err "netflow_version '$1' must be 9 or ipfix"; return 1 ;;
  esac
}
```

## Purpose

Enforce the product decision that v1 exports NetFlow v9, with `ipfix` as the
one carried alternative. Any other value (`5`, `10`, a typo) is rejected before
the configuration is generated.

## Inputs and outputs

- Input: `$1` — candidate `netflow_version` value.
- Output: none. Return status 0 for `9` or `ipfix`, 1 otherwise.

## Side effects

None — pure predicate.

## Failure modes and exit codes

Returns 1 with the cause `netflow_version '$1' must be 9 or ipfix`.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"parse_args rejects an unknown --version" (`--version 5`, asserting the
`must be 9 or ipfix` message).

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)

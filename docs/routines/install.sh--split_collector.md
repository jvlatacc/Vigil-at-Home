# `split_collector` — install.sh

**Script:** `appliance/opnsense/install.sh`. Splits the `--collector` value
into host and port.

```sh
split_collector() {
  # $1 = collector spec HOST[:PORT]; sets COLLECTOR_HOST / COLLECTOR_PORT.
  # A bare host takes the product-default port. IPv6 literals are rejected
  # in v1: the config surface carries exactly one host and one port.
  case $1 in
    '' | :*)
      err "collector '$1': host part is empty (expected HOST[:PORT])"
      return 1
      ;;
    *:*)
      COLLECTOR_HOST=${1%:*}
      COLLECTOR_PORT=${1##*:}
      case $COLLECTOR_HOST in
        *:*)
          err "collector '$1': too many colons; IPv6 literals are not supported in v1"
          return 1
          ;;
      esac
      is_valid_port "$COLLECTOR_PORT" || {
        err "collector '$1': port '$COLLECTOR_PORT' is outside 1-65535"
        return 1
      }
      ;;
    *)
      COLLECTOR_HOST=$1
      COLLECTOR_PORT=$DEFAULT_COLLECTOR_PORT
      ;;
  esac
}
```

## Purpose

Normalize the collector endpoint before anything is written: a bare host takes
the product-default port (2550), an explicit `HOST:PORT` is validated, and IPv6
literal syntax is rejected outright in v1.

## Inputs and outputs

- Input: `$1` — collector spec, `HOST` or `HOST:PORT`.
- Outputs: sets `COLLECTOR_HOST` and `COLLECTOR_PORT`.
- Return status: 0 on success, 1 with a named stderr cause otherwise.

## Side effects

None beyond the two output variables; no files, no network.

## Failure modes and exit codes

Returns 1 with a named cause for: an empty host part (`''` or `:PORT`), more
than one colon ("IPv6 literals are not supported in v1"), or a port outside
1-65535 (via `is_valid_port`).

## Tests covering it

`appliance/opnsense/tests/installer.bats`:

- "parse_args accepts required flags and applies the defaults" — bare host
  `192.0.2.10` yields `COLLECTOR_PORT=2550`
- "parse_args accepts ipfix, an explicit port, and multiple interfaces" —
  `192.0.2.10:9999` splits as given
- "parse_args rejects a collector with an out-of-range port" (`:70000`)
- "parse_args rejects a collector port of zero" (`:0`)
- "parse_args rejects a collector with an empty host" (`:2550`)

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (the default port and the v1 config surface this implements)

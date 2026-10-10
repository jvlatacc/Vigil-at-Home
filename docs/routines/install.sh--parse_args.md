# `parse_args` — install.sh

**Script:** `appliance/opnsense/install.sh`. Parses the installer's CLI flags
into the variables everything downstream reads.

```sh
parse_args() {
  # Parses CLI flags into INTERFACES / COLLECTOR_HOST / COLLECTOR_PORT /
  # JAIL_IP / NF_VERSION. Returns 1 with a named cause on stderr instead of
  # exiting, so tests can assert rejections.
  INTERFACES=''
  COLLECTOR_HOST=''
  COLLECTOR_PORT=$DEFAULT_COLLECTOR_PORT
  JAIL_IP=''
  NF_VERSION=9
  while [ "$#" -gt 0 ]; do
    case $1 in
      --interfaces) ... ;;
      --collector)  split_collector "$2" || return 1 ... ;;
      --ip)         JAIL_IP=$2 ... ;;
      --version)    NF_VERSION=$2 ... ;;
      -h | --help)  usage; exit 0 ;;
      *)            err "unknown option: $1"; return 1 ;;
    esac
  done

  validate_interfaces "$INTERFACES" || return 1
  [ -n "$COLLECTOR_HOST" ] || { err "missing required --collector (HOST[:PORT])"; return 1; }
  [ -n "$JAIL_IP" ] || { err "missing required --ip ADDRESS"; return 1; }
  is_valid_ipv4 "$JAIL_IP" || { err "--ip '$JAIL_IP' is not a valid IPv4 address"; return 1; }
  validate_netflow_version "$NF_VERSION" || return 1
}
```

(The loop elided above is the flag dispatcher; the full text is in
`appliance/opnsense/install.sh`.)

## Purpose

Single entry point for the operator-facing flag surface. Applies the product
defaults (port 2550, version 9), delegates the collector and version checks to
their validators, and requires `--collector` and `--ip`.

## Inputs and outputs

- Input: `"$@"` — the installer's flags: `--interfaces`, `--collector`,
  `--ip`, `--version`, `-h`/`--help`.
- Outputs: sets `INTERFACES`, `COLLECTOR_HOST`, `COLLECTOR_PORT`, `JAIL_IP`,
  `NF_VERSION`.
- Return status: 0 on success; 1 with a named stderr cause on rejection
  (deliberately returns rather than exiting so bats can `run` it). Exits 0
  only on `-h`/`--help` after printing usage.

## Side effects

Sets the five output variables. No files, no host changes.

## Failure modes and exit codes

Returns 1 with a named cause for: a flag missing its value, an unknown option,
an invalid collector spec, a missing `--collector`, a missing `--ip`, a
non-IPv4 `--ip`, an unknown `--version`, or an invalid interface list.

## Tests covering it

Eleven cases in `appliance/opnsense/tests/installer.bats`: the two acceptance
cases ("accepts required flags and applies the defaults", "accepts ipfix, an
explicit port, and multiple interfaces") and nine rejections (out-of-range
port, port zero, empty host, missing `--ip`, non-IPv4 `--ip`, unknown
`--version`, unknown option, flag missing its value, empty interface token).

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (defaults and validation)
- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
  (installer flags are part of the v1 operator surface)

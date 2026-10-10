# `is_valid_ipv4` — install.sh

**Script:** `appliance/opnsense/install.sh`. Dotted-quad IPv4 validator for the
jail address.

```sh
is_valid_ipv4() {
  # $1 = candidate dotted-quad IPv4 address.
  _old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086  # $1 must split on the '.' set above
  set -- $1
  IFS=$_old_ifs
  [ "$#" -eq 4 ] || return 1
  for _octet in "$@"; do
    case $_octet in
      '' | *[!0-9]*) return 1 ;;
    esac
    [ "$_octet" -le 255 ] || return 1
  done
  return 0
}
```

## Purpose

Accept only a four-octet dotted-quad address for `--ip`, the address assigned
to the jail (`ip4.addr` in the generated jail fragment).

## Inputs and outputs

- Input: `$1` — candidate IPv4 address.
- Output: none. Return status 0 when valid, 1 otherwise.
- Temporary use of `$IFS` and `$@`; `$IFS` is saved and restored.

## Side effects

None — pure predicate (the positional parameters are the function's own scope).

## Failure modes and exit codes

Returns 1 when the address does not split into exactly four all-numeric octets,
or any octet is greater than 255. Note for reviewers: octets are compared
numerically, so a zero-padded form such as `192.0.2.025` is accepted; the bats
suite does not cover that edge.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"is_valid_ipv4 accepts only dotted quads with octets up to 255" — accepts
`192.0.2.254`; rejects `192.0.2.256`, `192.0.2`, and `not-an-ip`.

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (the validated flag surface this belongs to)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the jail the address is assigned to)

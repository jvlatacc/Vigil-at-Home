# `is_iface_list` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. syntax-checks a comma-separated capture interface list.

```sh
is_iface_list() {
  # $1 = comma-separated capture interface list; syntax only (existence on
  # the host stack is a runtime check). Mirrors the installer's rules: no
  # empty tokens, names limited to [A-Za-z0-9._-].
  case $1 in
    '' | ,* | *, | *,,*) return 1 ;;
  esac
  _il_list=$1
  while [ -n "$_il_list" ]; do
    _il_tok=${_il_list%%,*}
    case $_il_tok in
      '' | *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    [ "$_il_tok" = "$_il_list" ] && break
    _il_list=${_il_list#*,}
  done
}
```

## Purpose

Mirrors the installer's rules: no empty tokens, names limited to `[A-Za-z0-9._-]`. Existence on the host stack is a separate runtime check (`capture_interfaces_exist`).

## Inputs and outputs

- Input: `$1` — the list.
- Return status: 0 when the syntax is acceptable; 1 otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 for an empty string, leading/trailing/double commas, or a token with characters outside the allowed set.

## Tests covering it

Validator suite rejection: "validation rejects an empty capture interface list".

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the interface names name the host devices the jail will tap

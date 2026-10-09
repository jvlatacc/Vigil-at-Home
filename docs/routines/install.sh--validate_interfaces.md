# `validate_interfaces` — install.sh

**Script:** `appliance/opnsense/install.sh`. Syntax-only validator for the
comma-separated capture interface list.

```sh
validate_interfaces() {
  # $1 = comma-separated capture interface list. Syntax only; existence on
  # the host stack is checked at runtime by assert_interfaces_exist.
  case $1 in
    '' | ,* | *, | *,,*)
      err "capture_interfaces '$1': every entry must be a non-empty interface name"
      return 1
      ;;
  esac
  # The comma is the list separator, so validate each token's characters
  # individually rather than the raw joined string.
  _vf_list=$1
  while [ -n "$_vf_list" ]; do
    _vf_tok=${_vf_list%%,*}
    case $_vf_tok in
      '' | *[!A-Za-z0-9._-]*)
        err "capture_interfaces '$_vf_tok': only [A-Za-z0-9._-] are allowed in interface names"
        return 1
        ;;
    esac
    [ "$_vf_tok" = "$_vf_list" ] && break
    _vf_list=${_vf_list#*,}
  done
}
```

## Purpose

Reject malformed `--interfaces` lists before any file is written: no empty
list, no leading/trailing/double commas, and every token restricted to
`[A-Za-z0-9._-]` (covering names like `lan0`, `igb0`, `vmx1`).

## Inputs and outputs

- Input: `$1` — comma-separated interface list.
- Output: none. Return status 0 when every token passes, 1 otherwise.

## Side effects

None — pure predicate.

## Failure modes and exit codes

Returns 1 with a named cause for an empty entry or a token with characters
outside the allowed set. Existence on the host is deliberately not checked
here; `assert_interfaces_exist` does that at install time on the appliance.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"parse_args rejects an empty interface token" (`lan0,,wan0`).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the `capture_interfaces` this validates)

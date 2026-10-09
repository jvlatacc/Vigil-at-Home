# `json_iface_array` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. renders a comma-separated interface list as a JSON array.

```sh
json_iface_array() {
  # $1 = comma-separated interface list -> a JSON array of strings.
  _ja_out=''
  _ja_list=$1
  while [ -n "$_ja_list" ]; do
    _ja_tok=${_ja_list%%,*}
    _ja_sep=''
    [ -n "$_ja_out" ] && _ja_sep=', '
    _ja_out="$_ja_out$_ja_sep$(json_string "$_ja_tok")"
    [ "$_ja_tok" = "$_ja_list" ] && break
    _ja_list=${_ja_list#*,}
  done
  printf '[%s]' "$_ja_out"
}
```

## Purpose

Turns `capture_interfaces = "lan0,wlan0"` into `["lan0", "wlan0"]` for the health file's `capture_interfaces` field.

## Inputs and outputs

- Input: `$1` — comma-separated interface names.
- Output: a JSON array of strings on stdout.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Covered by "health output is valid JSON" and the multi-interface argv case in the statemachine suite.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — JSON produced without jq or Node

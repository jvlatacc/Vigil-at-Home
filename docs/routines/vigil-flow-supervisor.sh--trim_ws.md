# `trim_ws` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. strips leading and trailing spaces and tabs from a string.

```sh
trim_ws() {
  # $1 = string; prints it without leading/trailing spaces and tabs.
  _tw_v=$1
  while :; do
    case $_tw_v in
      ' '* | '	'*) _tw_v=${_tw_v#?} ;;
      *) break ;;
    esac
  done
  while :; do
    case $_tw_v in
      *' ' | *'	') _tw_v=${_tw_v%?} ;;
      *) break ;;
    esac
  done
  printf '%s' "$_tw_v"
}
```

## Purpose

Portable character-trim used by the config parser on keys and values, so a sloppy config file still parses to exact tokens.

## Inputs and outputs

- Input: `$1` — the string.
- Output: the trimmed string on stdout.

## Side effects

None.

## Failure modes and exit codes

Never fails the caller.

## Tests covering it

Exercised through the validator suite's parsing cases ("comments and blank lines are ignored" and the grammar rejections).

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — hand-rolled loops instead of external text tools

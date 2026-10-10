# `main` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. the ctl's argument dispatcher.

```sh
main() {
  set -eu
  _m_cmd=''
  while [ "$#" -gt 0 ]; do
    case $1 in
      --config-file)
        [ "$#" -ge 2 ] || die "--config-file requires a value"
        VIGIL_FLOW_CONFIG=$2
        shift 2
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      start | stop | status | validate | reconfigure)
        [ -z "$_m_cmd" ] || die "exactly one command is allowed (got '$_m_cmd' and '$1')"
        _m_cmd=$1
        shift
        ;;
      *)
        die "unknown option or command: $1 (run with --help)"
        ;;
    esac
  done
  [ -n "$_m_cmd" ] || {
    usage >&2
    exit 2
  }
  load_supervisor_functions
  case $_m_cmd in
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    validate) cmd_validate ;;
    reconfigure) cmd_reconfigure ;;
  esac
}
```

## Purpose

Parses `--config-file PATH`, `--help`/`-h`, and exactly one command (`start`, `stop`, `status`, `validate`, `reconfigure`); more than one command, an unknown word, or no command at all is a usage error — usage on stderr with exit 2 for a missing command, `die` for the rest. Loads the supervisor functions, then dispatches. When `$VIGIL_FLOW_SKIP_MAIN` is 1 (the test hook), sourcing the file only defines functions.

## Inputs and outputs

- Input: the command line.
- Return status: the dispatched command's status; 2 for usage errors.

## Side effects

Dispatches to the `cmd_*` routines.

## Failure modes and exit codes

Exit 2 (usage, to stderr) when no command is given; exit 1 via `die` for unknown options, a missing flag value, or more than one command.

## Tests covering it

No direct bats case for the dispatcher itself; every ctl case in the statemachine suite enters through it.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the five commands are the v1 operator surface
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — the test hook keeps the bats suite hermetic

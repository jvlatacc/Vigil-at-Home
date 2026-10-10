# `main` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. the supervisor's argument dispatcher.

```sh
main() {
  set -u
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
      run)
        run_supervisor
        exit $?
        ;;
      *)
        die "unknown option or command: $1 (run with --help)"
        ;;
    esac
  done
  die "missing required command: run (run with --help)"
}
```

## Purpose

Parses `--config-file PATH` (overriding `$VIGIL_FLOW_CONFIG`), `--help`/`-h` (usage, exit 0), and the required `run` command; anything else — including no command at all — dies with a named cause. When `$VIGIL_FLOW_SKIP_MAIN` is 1 (the test hook), sourcing the file only defines functions.

## Inputs and outputs

- Input: the command line.
- Return status: 0 from a clean stop; 1 on usage errors.

## Side effects

Dispatches to `run_supervisor`, which owns the process behavior.

## Failure modes and exit codes

Exit 1 with a named cause for a missing value, an unknown option or command, or a missing command.

## Tests covering it

No direct bats case (the suite sources the file with the skip-main hook and drives the functions); on device the jail's `exec.start` exercises it.

## Linked decisions

- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — the test hook keeps the bats suite hermetic
- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — `run` is for the ctl and jail wiring, not for operators

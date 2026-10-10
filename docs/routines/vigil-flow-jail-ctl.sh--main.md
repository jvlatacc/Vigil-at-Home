# `main` — vigil-flow-jail-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-jail-ctl.sh`. The script's
whole-body flow (it defines no functions) — the thin jexec bridge the configd
actions call.

```sh
#!/bin/sh
# vigil-flow host wrapper — thin jexec bridge used by the configd actions so
# operators get `configctl vigil-flow status|reconfigure` without touching
# jail mechanics. Installed to /usr/local/bin by appliance/opnsense/install.sh.
set -eu
JAIL_NAME=vigil-flow

case ${1:-} in
  status | reconfigure) ;;
  *)
    printf 'usage: %s status|reconfigure\n' "${0##*/}" >&2
    exit 2
    ;;
esac

exec jexec "$JAIL_NAME" /usr/local/bin/vigil-flow-ctl.sh "$1"
```

## Purpose

Expose `configctl vigil-flow status` and `configctl vigil-flow reconfigure`
on the host, forwarding exactly those two action words into the jail without
the caller needing to know anything about `jexec`. OPNsense's configd invokes
this file (see the generated `actions_vigil-flow.conf`), per the platform
convention that back-ends go through configd.

## Inputs and outputs

- Input: `$1` — `status` or `reconfigure`.
- Output: whatever the in-jail `/usr/local/bin/vigil-flow-ctl.sh` prints for
  that action (forwarded unchanged), or the usage line on stderr for anything
  else.
- Return status: the exit status of the in-jail script (via `exec`), or 2 for
  an unrecognized action.

## Side effects

`exec` replaces the wrapper process with `jexec`, which runs the in-jail
control script. No files are touched by the wrapper itself.

## Failure modes and exit codes

- Unknown or missing action → usage line on stderr, exit 2.
- `jexec` failure (jail not running, in-jail script absent) → jexec's own
  non-zero status under `set -eu`.

Note on state: the in-jail target (`/usr/local/bin/vigil-flow-ctl.sh`) is
wired by the generated jail fragment but lands with the sensor-daemon change;
until then a configd `status` call fails inside the jail.

## Tests covering it

`appliance/opnsense/tests/fragments.bats`:
"host wrapper only forwards status and reconfigure" — asserts the
`status | reconfigure` case pattern and the `exec jexec` call in the repo
file. The installed copy's behavior (a real configctl round-trip) is
on-device verification.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
  (this wrapper is the entire host-side control surface)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the wrapper reaches into the jail the capture runs in)

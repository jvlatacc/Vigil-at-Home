# `stop_jail` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Stops the vigil-flow jail
before the files go away.

```sh
stop_jail() {
  # A jail that is not running is the normal idempotent case here, not an
  # error — the deliberate || true only swallows that expected state.
  jail -r "$JAIL_NAME" >/dev/null 2>&1 || true
}
```

## Purpose

Make sure the jail is not running (`jail -r` removes a running jail from the
system) so its userland tree can be deleted underneath it. This is the first
step of `main`, before the manifest is processed.

## Inputs and outputs

- Input: `JAIL_NAME` (`vigil-flow`).
- Output: none (jail output suppressed).
- Return status: always 0 — see the code comment quoted above.

## Side effects

Stops and removes the running jail (if one is running): processes inside it
are terminated by jail(8)'s normal stop path, which runs the jail's
`exec.stop` hook (`/usr/local/bin/vigil-flow-ctl.sh stop`) if the daemon is
installed. This is the only routine in the appliance scaffold that touches a
running service.

## Failure modes and exit codes

Deliberately none: a jail that is not running makes `jail -r` fail, and that
expected state is swallowed by the `|| true`. The comment marks the swallow as
scoped to that case — an actual removal problem surfaces later, when
`process_manifest` or the final `rm -rf` hit a busy file.

## Tests covering it

No direct bats case (needs a host running jails); exercised on device by the
runbook's uninstall pass.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the jail this stops)

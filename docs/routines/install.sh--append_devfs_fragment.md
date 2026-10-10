# `append_devfs_fragment` — install.sh

**Script:** `appliance/opnsense/install.sh`. Appends the vigil-flow devfs
ruleset to the host's devfs.rules, idempotently.

```sh
append_devfs_fragment() {
  # $1 = target rules file. Appends the marked vigil-flow ruleset once; the
  # markers make the block auditable and let uninstall.sh strip it exactly.
  if [ -f "$1" ] && grep -q '^# >>> vigil-flow >>>' "$1"; then
    printf '%s: devfs fragment already present, skipping\n' "${0##*/}"
    return 0
  fi
  cat >> "$1" <<'EOF'

# >>> vigil-flow >>> (added by appliance/opnsense/install.sh)
[devfsrules_vigil_flow=5]
add include $devfsrules_jail
add path 'bpf*' unhide
# <<< vigil-flow <<<
EOF
}
```

## Purpose

Create the sensor's one privileged grant: ruleset
`[devfsrules_vigil_flow=5]`, which extends the default jail ruleset
(`add include $devfsrules_jail`) with visibility of `/dev/bpf*`
(`add path 'bpf*' unhide`). That grant is what lets softflowd capture inside
the non-VNET jail. The `# >>> vigil-flow >>>` markers make the block
auditable and strippable.

## Inputs and outputs

- Input: `$1` — target rules file (default `/etc/devfs.rules`, repointed by
  tests).
- Output: none.
- Return status: 0 both when appended and when already present (idempotent);
  non-zero on write failure, which `main` turns into
  `die "cannot append the devfs fragment to $DEVFS_RULES_FILE"`.

## Side effects

Appends the marked block to the rules file. Re-runs never duplicate it (the
marker check prints "devfs fragment already present, skipping").

## Failure modes and exit codes

Write failure → exit 1 via `main`'s `die`. A lost fragment (for example after
an OPNsense firmware upgrade rewrites `/etc/devfs.rules`) is not an error
here — a re-run re-appends it; the runtime symptom of a lost grant is
documented in the [state machine](../design/data.md) (DEGRADED names the
missing-bpf cause).

## Tests covering it

`appliance/opnsense/tests/installer.bats`:
"append_devfs_fragment is idempotent and grants bpf" — appends twice, asserts
exactly one `[devfsrules_vigil_flow=5]`, plus both rule lines.
`appliance/opnsense/tests/fragments.bats`:
"devfs fragment pins ruleset 5 with the bpf grant" — the shipped reference
file matches the same contract.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)

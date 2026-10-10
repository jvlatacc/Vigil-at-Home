# `ensure_jail_conf_include` — install.sh

**Script:** `appliance/opnsense/install.sh`. Makes `/etc/jail.conf` read the
`jail.conf.d` directory, exactly once.

```sh
ensure_jail_conf_include() {
  # $1 = /etc/jail.conf. jail(8) only reads /etc/jail.conf.d/*.conf through
  # an explicit .include directive, so make sure one is present exactly once
  # — whoever added it.
  if [ -f "$1" ] && grep -Fq '.include "/etc/jail.conf.d/*.conf";' "$1"; then
    return 0
  fi
  cat >> "$1" <<'EOF'

# >>> vigil-flow-jailconf >>> (added by appliance/opnsense/install.sh)
.include "/etc/jail.conf.d/*.conf";
# <<< vigil-flow-jailconf <<<
EOF
}
```

## Purpose

`jail(8)` reads `/etc/jail.conf.d/*.conf` only through an explicit `.include`
directive, so without this the generated jail fragment would be dead text. The
function adds the directive only when it is missing — if the operator (or
another package) already added one, it leaves the file alone.

## Inputs and outputs

- Input: `$1` — the jail.conf file (default `/etc/jail.conf`, repointed by
  tests).
- Output: none.
- Return status: 0 both when appended and when the directive already exists;
  non-zero on write failure, which `main` turns into
  `die "cannot ensure the jail.conf include in $JAIL_CONF_INCLUDE_FILE"`.

## Side effects

Appends the marked include block when missing. Never duplicates it and never
touches a file that already carries the directive.

## Failure modes and exit codes

Write failure → exit 1 via `main`'s `die`.

## Tests covering it

`appliance/opnsense/tests/installer.bats`:

- "ensure_jail_conf_include adds exactly one include directive" — two runs,
  one directive
- "ensure_jail_conf_include skips when the include already exists" — a file
  with a pre-existing directive stays untouched (no vigil-flow markers added)

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (this is part of wiring the jail that does the capture)

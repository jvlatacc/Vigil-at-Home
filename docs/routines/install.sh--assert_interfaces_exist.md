# `assert_interfaces_exist` — install.sh

**Script:** `appliance/opnsense/install.sh`. Runtime check that every
configured capture interface exists on the host.

```sh
assert_interfaces_exist() {
  # Runtime check — the non-VNET jail shares the host network stack, so host
  # ifconfig is authoritative. Needs a real host, so CI never calls it.
  _host_ifaces=$(ifconfig -l) ||
    die "ifconfig -l failed: cannot verify the capture interfaces"
  for _iface in $(printf '%s' "$INTERFACES" | tr ',' ' '); do
    case " $_host_ifaces " in
      *" $_iface "*) ;;
      *) die "capture interface '$_iface' does not exist on this host" ;;
    esac
  done
}
```

## Purpose

Catch a mistyped or renamed interface at install time, before a jail is
provisioned around an interface it would never see traffic on. This is the
host-side half of interface validation; `validate_interfaces` did the syntax
half.

## Inputs and outputs

- Input: `$INTERFACES` (comma-separated list, set by `parse_args`).
- Output: none.
- Return status: 0 when every interface exists; fatal (`die`, exit 1)
  otherwise.

## Side effects

None (reads `ifconfig -l` output only).

## Failure modes and exit codes

Dies with a named cause when `ifconfig -l` itself fails, or when any listed
interface is missing from the host's interface list. The non-VNET rationale is
the code comment quoted above: the jail shares the host network stack, so host
`ifconfig` is authoritative for what the jail's softflowd can open.

## Tests covering it

No direct bats case — the code comment says it: "Needs a real host, so CI
never calls it." On-device verification (`docs/opnsense-sensor.md` runbook,
landing with the daemon change) installs with a real interface name; a missing
one aborts the install before provisioning.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the non-VNET jail whose traffic this tap must exist for)

# `capture_interfaces_exist` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. checks every configured interface exists on the host stack.

```sh
capture_interfaces_exist() {
  # Non-VNET jail shares the host network stack, so the host's ifconfig -l
  # is authoritative for interface existence.
  VALIDATE_ERROR=''
  _ci_host_ifaces=$("$VIGIL_FLOW_IFCONFIG" -l 2>/dev/null) || {
    VALIDATE_ERROR="interface_check_failed: cannot list host interfaces with $VIGIL_FLOW_IFCONFIG"
    return 1
  }
  for _ci_iface in $(printf '%s' "$CFG_CAPTURE_INTERFACES" | tr ',' ' '); do
    case " $_ci_host_ifaces " in
      *" $_ci_iface "*) ;;
      *)
        VALIDATE_ERROR="interface_missing: capture interface '$_ci_iface' does not exist on the host stack"
        return 1
        ;;
    esac
  done
}
```

## Purpose

Non-VNET jail shares the host network stack, so the host's `ifconfig -l` is authoritative. A vanished interface (renamed NIC, driver change after a firmware upgrade) must be named, not guessed at.

## Inputs and outputs

- Input: `$CFG_CAPTURE_INTERFACES`; `$VIGIL_FLOW_IFCONFIG` (default `/sbin/ifconfig`).
- Return status: 0 all present; 1 with a named cause otherwise.

## Side effects

None.

## Failure modes and exit codes

Returns 1 with `interface_check_failed: ...` when `ifconfig -l` itself fails, or `interface_missing: ...` naming the first absent interface.

## Tests covering it

Validator suite rejection: "validation rejects a configured interface that does not exist"

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — non-VNET: the jail sees the host's interfaces

# `validate_loaded_config` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. checks that every required config key is present.

```sh
validate_loaded_config() {
  # Cross-field checks the parser cannot express: every required key present.
  # Per-key range/charset validation already happened in load_config. The
  # case dispatch reads the CFG_ variables without eval, so even our own
  # fixed key names are never dynamically executed.
  VALIDATE_ERROR=''
  _vl_missing=''
  for _vl_key in capture_interfaces collector_host collector_port netflow_version \
    active_timeout inactive_timeout max_flows status_file; do
    case $_vl_key in
      capture_interfaces) _vl_val=$CFG_CAPTURE_INTERFACES ;;
      collector_host) _vl_val=$CFG_COLLECTOR_HOST ;;
      collector_port) _vl_val=$CFG_COLLECTOR_PORT ;;
      netflow_version) _vl_val=$CFG_NF_VERSION ;;
      active_timeout) _vl_val=$CFG_ACTIVE_TIMEOUT ;;
      inactive_timeout) _vl_val=$CFG_INACTIVE_TIMEOUT ;;
      max_flows) _vl_val=$CFG_MAX_FLOWS ;;
      status_file) _vl_val=$CFG_STATUS_FILE ;;
    esac
    [ -n "$_vl_val" ] || _vl_missing="$_vl_missing '$_vl_key'"
  done
  if [ -n "$_vl_missing" ]; then
    VALIDATE_ERROR="config_invalid: missing required key(s):$_vl_missing"
    return 1
  fi
  return 0
}
```

## Purpose

Cross-field presence check the per-key parser cannot express: all eight keys must be non-empty after parsing. Range and charset validation already happened in `load_config`.

## Inputs and outputs

- Input: the `CFG_*` variables set by `load_config`.
- Return status: 0 complete; 1 with the missing keys named in `VALIDATE_ERROR`.

## Side effects

None.

## Failure modes and exit codes

Returns 1 with `config_invalid: missing required key(s): ...` when anything is absent.

## Tests covering it

Validator suite rejection: "validation rejects a config missing a required key"

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the required export keys

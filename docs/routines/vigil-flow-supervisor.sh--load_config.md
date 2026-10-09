# `load_config` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. parses the sensor configuration file into CFG_* variables.

```sh
load_config() {
  # Parses the POSIX key = "value" sensor configuration into CFG_* variables.
  # Never evals: the grammar is strict (bare identifier keys, single quoted
  # value), and every value must pass a per-key charset before it is kept,
  # so a hostile config file cannot inject code or forge JSON structure.
  # On failure returns 1 with a named cause in VALIDATE_ERROR.
  VALIDATE_ERROR=''
  [ -f "$VIGIL_FLOW_CONFIG" ] || {
    VALIDATE_ERROR="config_missing: no configuration file at $VIGIL_FLOW_CONFIG"
    return 1
  }
  [ -r "$VIGIL_FLOW_CONFIG" ] || {
    VALIDATE_ERROR="config_unreadable: $VIGIL_FLOW_CONFIG is not readable by this user"
    return 1
  }

  CFG_CAPTURE_INTERFACES=''
  CFG_COLLECTOR_HOST=''
  CFG_COLLECTOR_PORT=''
  CFG_NF_VERSION=''
  CFG_ACTIVE_TIMEOUT=''
  CFG_INACTIVE_TIMEOUT=''
  CFG_MAX_FLOWS=''
  CFG_STATUS_FILE=''
  _lc_seen=' '
  _lc_lineno=0
  while IFS= read -r _lc_line || [ -n "$_lc_line" ]; do
    _lc_lineno=$((_lc_lineno + 1))
    case $_lc_line in
      '' | \#*) continue ;;
    esac
    case $_lc_line in
      *=*) ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno has no '=' separator"
        return 1
        ;;
    esac
    _lc_key=$(trim_ws "${_lc_line%%=*}")
    _lc_value=$(trim_ws "${_lc_line#*=}")
    case $_lc_value in
      '"'*'"') ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: '$_lc_key' must be a double-quoted value"
        return 1
        ;;
    esac
    _lc_value=${_lc_value#\"}
    _lc_value=${_lc_value%\"}
    case $_lc_key in
      *[!A-Za-z0-9_]*)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: key '$_lc_key' is not a bare identifier"
        return 1
        ;;
    esac
    case $_lc_seen in
      *" $_lc_key "*)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: duplicate key '$_lc_key'"
        return 1
        ;;
    esac
    _lc_seen="$_lc_seen$_lc_key "

    case $_lc_key in
      capture_interfaces)
        is_iface_list "$_lc_value" || {
          VALIDATE_ERROR="config_invalid: capture_interfaces '$_lc_value': every entry must be a non-empty name of [A-Za-z0-9._-]"
          return 1
        }
        CFG_CAPTURE_INTERFACES=$_lc_value
        ;;
      collector_host)
        case $_lc_value in
          '' | *[!A-Za-z0-9.-]*)
            VALIDATE_ERROR="config_invalid: collector_host '$_lc_value' is not a hostname or IPv4 address"
            return 1
            ;;
        esac
        CFG_COLLECTOR_HOST=$_lc_value
        ;;
      collector_port)
        is_valid_port "$_lc_value" || {
          VALIDATE_ERROR="config_invalid: collector_port '$_lc_value' is outside 1-65535"
          return 1
        }
        CFG_COLLECTOR_PORT=$_lc_value
        ;;
      netflow_version)
        case $_lc_value in
          9 | ipfix) ;;
          *)
            VALIDATE_ERROR="config_invalid: netflow_version '$_lc_value' must be 9 or ipfix"
            return 1
            ;;
        esac
        CFG_NF_VERSION=$_lc_value
        ;;
      active_timeout | inactive_timeout)
        is_int_in_range "$_lc_value" 1 604800 || {
          VALIDATE_ERROR="config_invalid: $_lc_key '$_lc_value' must be an integer of 1-604800 seconds"
          return 1
        }
        case $_lc_key in
          active_timeout) CFG_ACTIVE_TIMEOUT=$_lc_value ;;
          inactive_timeout) CFG_INACTIVE_TIMEOUT=$_lc_value ;;
        esac
        ;;
      max_flows)
        is_int_in_range "$_lc_value" 1 1048576 || {
          VALIDATE_ERROR="config_invalid: max_flows '$_lc_value' must be an integer of 1-1048576"
          return 1
        }
        CFG_MAX_FLOWS=$_lc_value
        ;;
      status_file)
        case $_lc_value in
          /*) ;;
          *)
            VALIDATE_ERROR="config_invalid: status_file '$_lc_value' must be an absolute path"
            return 1
            ;;
        esac
        case $_lc_value in
          *[!A-Za-z0-9/._-]*)
            VALIDATE_ERROR="config_invalid: status_file '$_lc_value' contains characters outside [A-Za-z0-9/._-]"
            return 1
            ;;
        esac
        CFG_STATUS_FILE=$_lc_value
        ;;
      *)
        VALIDATE_ERROR="config_invalid: line $_lc_lineno: unknown key '$_lc_key'"
        return 1
        ;;
    esac
  done < "$VIGIL_FLOW_CONFIG"

  [ -n "$CFG_STATUS_FILE" ] && STATUS_FILE=$CFG_STATUS_FILE
  return 0
}
```

## Purpose

The config-file grammar is strict POSIX `key = "value"`: bare-identifier keys, one double-quoted value, no duplicate keys, every value charset-checked per key before it is kept. The parser never evals, so a hostile config file cannot inject code or forge JSON structure. Keys: `capture_interfaces`, `collector_host`, `collector_port`, `netflow_version`, `active_timeout`, `inactive_timeout`, `max_flows`, `status_file`.

## Inputs and outputs

- Input: `$VIGIL_FLOW_CONFIG` (default `/etc/vigil-flow.conf` inside the jail).
- Outputs: sets the `CFG_*` variables; moves `STATUS_FILE` when the config sets `status_file`.
- Return status: 0 parsed; 1 with a named cause in `VALIDATE_ERROR`.

## Side effects

Sets process state only; no files are written.

## Failure modes and exit codes

Returns 1 with a named cause for: missing file (`config_missing:`), unreadable file (`config_unreadable:`), a line without `=`, an unquoted value, a non-identifier key, a duplicate key, an unknown key, or a per-key charset/range rejection.

## Tests covering it

The validator suite's parsing cases: "comments and blank lines are ignored", "validation rejects an unknown configuration key", "validation rejects a duplicate configuration key", "validation rejects a line outside the key = value grammar", "validation rejects a key that is not a bare identifier", "validation rejects an unquoted value (the grammar requires quotes)", "validation reports a missing config file with a named cause", plus the per-key rejections (port, version, timeouts, max_flows, status_file, interface list).

## Linked decisions

- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the export keys and their accepted values
- [0004 — POSIX sh runtime, with the shellcheck + bats CI job](../decisions/0004-posix-sh-runtime-shell-ci.md) — no eval: values are data, never code

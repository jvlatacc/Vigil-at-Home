# `spawn_all_children` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. launches one softflowd child per configured interface.

```sh
spawn_all_children() {
  _sa_iface=''
  for _sa_iface in $(printf '%s' "$CFG_CAPTURE_INTERFACES" | tr ',' ' '); do
    spawn_child "$_sa_iface" || return 1
  done
  return 0
}
```

## Purpose

Iterates `$CFG_CAPTURE_INTERFACES` and spawns a child for each; the first failure fails the whole pass so the gate reports one clean cause.

## Inputs and outputs

- Input: `$CFG_CAPTURE_INTERFACES`.
- Return status: 0 all launched; 1 on the first failure.

## Side effects

Starts the softflowd children.

## Failure modes and exit codes

Returns 1 with the failing interface's cause.

## Tests covering it

Exercised in "ctl start reaches RUNNING and the stub records the exact spec argv" (multi-interface stub) and the degrade cases.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — one child per capture interface

# `find_openable_bpf` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. prints the first openable /dev/bpf* device, or fails when there is none.

```sh
find_openable_bpf() {
  # Prints the first openable bpf device under $VIGIL_FLOW_BPF_DIR, or
  # returns 1 when there is none. An unmatched glob stays literal and fails
  # the -e test, so an empty directory is simply "no devices".
  for _bpf in "$VIGIL_FLOW_BPF_DIR"/bpf*; do
    [ -e "$_bpf" ] || continue
    if : < "$_bpf" 2>/dev/null; then
      printf '%s\n' "$_bpf"
      return 0
    fi
  done
  return 1
}
```

## Purpose

The sensor's proof that the devfs grant is intact: walks `$VIGIL_FLOW_BPF_DIR` (default `/dev`) for `bpf*` devices and opens one read-only. An unmatched glob stays literal and fails the `-e` test, so an empty directory is simply "no devices".

## Inputs and outputs

- Output: the device path on stdout when one opens.
- Return status: 0 found; 1 none openable.

## Side effects

None beyond the open file descriptor (closed immediately).

## Failure modes and exit codes

Returns 1 when no bpf device exists or none can be opened.

## Tests covering it

Validator suite: "validation names the lost bpf grant when no bpf device is openable" (the suite stubs `$VIGIL_FLOW_BPF_DIR`).

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md) — the bpf devfs grant is the design's load-bearing privilege

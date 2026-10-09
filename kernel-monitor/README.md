# kernel-monitor

Kernel-boundary operations index and deterministic alerting for Vigil on
Debian 12/13 x64 — a privileged userspace daemon that loads one CO-RE eBPF
object (libbpf 1.x). No kernel module, no DKMS, no Secure Boot signing.

```
kernel hooks (tracepoints, LSM) ──► shared ring buffer ──► daemon:
                                                              feature probe ──► monitor.health
                                                              100 ms reorder window (monotonic stamp)
                                                              wall-clock anchoring
                                                              JSONL index ──► /var/lib/vigil/kernel-monitor/operations.jsonl (64 MiB × 5)
                                                              RFC 5424 VIGOP ──► /dev/log ──► rsyslog
```

## Layout

| Path              | Contents                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bpf/vigil.bpf.c` | the single CO-RE object: sched + module tracepoints, LSM file/network/privilege hooks with kprobe twins, 8 MiB ring buffer, drop counter                             |
| `src/`            | the daemon (`daemon.c`) and its libraries: event contract, payload contract, attach planner, reorder pipeline, index writer, RFC 5424 emitter, feature probe, health |
| `rules/`          | alert rules as data (land with the rules PR; evaluator is fixed)                                                                                                     |
| `systemd/`        | hardened unit (CAP_BPF + CAP_PERFMON, no CAP_SYS_ADMIN)                                                                                                              |
| `rsyslog/`        | local-retention drop-in; optional queued TLS forwarding is admin-configured                                                                                          |
| `tests/`          | host-runnable ctest suites + record/replay and hook-path fixtures (no kernel needed)                                                                                 |
| `scripts/`        | `gen_vmlinux.sh` (BTF → vmlinux.h), `run_verifier_check.sh` (verifier pre-check)                                                                                     |

## Build and test (host)

```sh
make            # vmlinux.h from the running kernel's BTF, BPF object, daemon
make test       # ctest: ordering, window behavior, RFC 5424 grammar, index rotation, replay fixtures
```

Dual-kernel CO-RE compile (CI): set `BTF_SOURCE` to a Debian 12 (6.1) or
Debian 13 (6.12) BTF blob and rebuild `bpf/vigil.bpf.o` — `gen_vmlinux.sh`
dumps either into `vmlinux.h`. Both stock kernels ship `CONFIG_DEBUG_INFO_BTF=y`.

## Runtime states

Probing → Running (all hooks attached) / Degraded (probe gaps, kprobe
fallbacks, `degraded: true` in `monitor.health`) / Dropping (ring-buffer
bursts; the drop counter is itself an index record). Without kernel BTF the
daemon refuses to run rather than half-observe.

## Scope

The core PR landed build scaffolding, the exec/fork-lineage BPF object, and
the daemon pipeline through index + VIGOP emission. This PR completes the
hook surface: file-mutation, network, privilege, and module-load programs
(LSM hooks with kprobe twins chosen by the runtime probe), their index
rendering as the spec's event kinds (`file`, `network.connection`,
`network.listen`, plus new `privilege.change` and `kernel.module`), and
fixture-driven host tests for every hook path. Landing in later PRs: the
rule evaluator + VIGALERT, packaging (install/uninstall), and app
ingestion. Kernel-attached runtime behavior requires a Debian VM — hosted
CI compiles, runs the section/BTF pre-check, and unit-tests only.

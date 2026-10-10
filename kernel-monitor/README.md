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
| `rules/`          | alert rules as data — the evaluator is fixed; rules never change behavior by themselves                                                                             |
| `systemd/`        | hardened unit (CAP_BPF + CAP_PERFMON, no CAP_SYS_ADMIN), starting the daemon with `--index-dir` and `--rules-dir`                                                    |
| `rsyslog/`        | local-retention drop-in plus the queued-TLS forward template (`vigil-forward.conf.in`, installed only when a collector is configured)                                |
| `tests/`          | host-runnable ctest suites + record/replay and hook-path fixtures (no kernel needed)                                                                                 |
| `scripts/`        | `gen_vmlinux.sh` (BTF → vmlinux.h), verifier/CI compile checks, `install.sh` / `uninstall.sh`, `check_packaging.sh` (host checks), `vm-lifecycle-check.sh` (VM lifecycle proof), `paths.sh` (the installed-path single source) |

## Build and test (host)

```sh
make            # vmlinux.h from the running kernel's BTF, BPF object, daemon
make test       # ctest: ordering, window behavior, RFC 5424 grammar, index rotation, replay fixtures
```

Dual-kernel CO-RE compile (CI): set `BTF_SOURCE` to a Debian 12 (6.1) or
Debian 13 (6.12) BTF blob and rebuild `bpf/vigil.bpf.o` — `gen_vmlinux.sh`
dumps either into `vmlinux.h`. Both stock kernels ship `CONFIG_DEBUG_INFO_BTF=y`.

## Install and uninstall

```sh
make -C kernel-monitor                                  # daemon + BPF object
sudo sh kernel-monitor/scripts/install.sh               # install + start
sudo sh kernel-monitor/scripts/install.sh \
  --collector collector.example --collector-port 6514   # + queued TLS forwarding
sudo sh kernel-monitor/scripts/uninstall.sh             # remove
```

What lands where: the daemon at `/usr/libexec/vigil-kernel-monitor/`, the
unit at `/etc/systemd/system/vigil-kernel-monitor.service` (enabled for
boot), the rules at `/etc/vigil/kernel-monitor/rules/`, and the rsyslog
drop-in at `/etc/rsyslog.d/vigil-kernel-monitor.conf`. Every pre-existing
file the installer touches is kept as `*.before-vigil` and put back on
uninstall. The forward drop-in is written only while a collector is
configured; reinstalling without `--collector` removes it. Uninstall keeps
the data you own — the operations index and the log — and says where.

The operations index lives at
`/var/lib/vigil/kernel-monitor/operations.jsonl` (rotated at 64 MiB,
5 files kept). The Vigil app ingests by tailing it through the sensor hub;
rsyslog's file output is for the admin and external collectors — nothing
tails both.

## Runtime states

Probing → Running (all hooks attached) / Degraded (probe gaps, kprobe
fallbacks, `degraded: true` in `monitor.health`) / Dropping (ring-buffer
bursts; the drop counter is itself an index record). Without kernel BTF the
daemon refuses to run rather than half-observe.

The full set, and where each is visible:

| State    | Meaning                                                                     | Seen in                                                                       |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Running  | all hooks attached, indexing and alerting                                    | `monitor.health` line with `"degraded":false`; index and VIGOP/VIGALERT flow  |
| Degraded | some hook class unavailable (e.g. BPF LSM unattachable); kprobe fallbacks    | `monitor.health` line with `"degraded":true` naming the attached hook set     |
| Dropping | ring buffer saturated under burst; accepted events stay ordered and complete | growing `droppedTotal`; a monitor-health alert at the drop threshold          |
| Failed   | fatal error (e.g. no kernel BTF — the probe refuses to guess)                 | unit exits; `Restart=on-failure` retries every 5s; `journalctl -u vigil-kernel-monitor` |

The unit is enabled for boot: a reboot brings the monitor back on its own,
and `install.sh` waits for the first `monitor.health` line so an operator
sees Running or Degraded (never silence) before it reports success.

## Alert path

The daemon decides — deterministically, from `rules/*.json` — and emits at
the moment of match: every operation leaves as RFC 5424 `VIGOP` through
`/dev/log`, and a match adds a `VIGALERT` (critical or warning priority)
carrying the same JSON as the index line. rsyslog routes both to
`/var/log/vigil/kernel-monitor.log` (0600, root-owned) and, when a collector
is configured, forwards them over queued TLS — alerts reach the collector
even with the desktop app stopped. The app's only source remains the JSONL
index; alerts never take a second ingestion path.

## Scope

The monitor is complete: the daemon core and index (PR #18), app ingestion
of the operations JSONL (PR #33), the file/network/privilege/module hook
surface with fallback attach (PR #34), the rule evaluator + VIGALERT
emission (PR #41), and packaging — the hardened unit, the rsyslog drop-ins,
and the install/uninstall lifecycle (this PR). Kernel-attached runtime
behavior still requires a Debian VM: hosted CI compiles, runs the
section/BTF pre-check, unit-tests, and validates the packaging, while the
live install → reboot → uninstall proof is `scripts/vm-lifecycle-check.sh`.

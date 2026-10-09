# Design: Linux validation routines and the dnf CI job (D2)

Deliverable D2 of the spec "Vigil at Home on Linux — validate, harden,
document" ([Spec](../docs) art_OrIt2PK3). The gap analysis
(art_wATE4boG, cited below as GA §) is the source for the matrix this design
implements; the security review (art_6JWj4Ijl, SR §) and implementation map
(art_IkQSYZL6, IM §) back the specific mechanics.

## Purpose

"Validated on Linux" was one runner deep: the six root integration tests all
ran on Ubuntu, the dnf-family branch of setup's commands had never executed
anywhere (GA G1), and nothing told a user how to prove their own install
works. This design adds two instruments:

1. **`scripts/validate-linux.sh`** — a per-machine routine that proves an
   installed Vigil works on the machine it runs on, auto-detecting the distro
   family from `/etc/os-release`. CI-usable and human-usable.
2. **CI container jobs** — the same root integration suite on Rocky Linux 9
   (dnf family), next to the Ubuntu anchor. A Debian 12 container job was
   tried and removed; see ["Why there is no Debian 12 container
   job"](#why-there-is-no-debian-12-container-job).

The routine is also the instrument that would surface a failure of the spec's
load-bearing assumption — that CI on GitHub runners can stand in for
"validated on Linux". Where it cannot (SELinux-enforcing RHEL, desktop flows,
Arch), the routine documents the manual tier instead of pretending.

## The seven checks

Every check prints `PASS`, or `FAIL` plus a one-line remedy; any FAIL exits
nonzero, so the routine works as a CI step and as a user triage tool.

| Check                                | Proves                                                                                                                                                                                                                                                         | Why it exists                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| package install                      | The app arrived by one of its shipped channels: the `.deb` is installed per dpkg (Debian family), or the AppImage is runnable and `pkexec` exists (RHEL family — there is no rpm target).                                                                      | The AppImage is built and uploaded every release but never exercised in CI (GA G5); RHEL-family users have no package at all (GA §3.7).                                                                                                                 |
| helper service active                | `vigil-helper.service` is active **and enabled** — protection survives a reboot.                                                                                                                                                                               | The root helper is the privileged core (SR F1/F2); an active-but-disabled helper is how a machine silently loses containment at next boot.                                                                                                              |
| helper socket answers                | `/run/vigil-helper.sock` speaks the protocol: one `helper.status` line in, a matching JSON line with `ok: true` out (packages/helper/src/{protocol,client}.ts).                                                                                                | The socket is the app's only channel to containment (SR F1); "service running" without "answers" is how a wedged helper hides.                                                                                                                          |
| fapolicyd enforcing                  | Binary present, `trust = file` set (the wizard's sed), the `06-vigil-allow.rules` allow-all exists, service active, `fapolicyd-cli --check-status` says enforcing.                                                                                             | Blocking on Linux **is** fapolicyd (IM §4.2). Missing any piece means blocking silently degrades to advisory. `fapolicyd-cli --check-status` is the wizard's own readiness check (onboarding/checks.ts).                                                |
| deny-by-hash roundtrip               | A deny rule naming a fresh hash refuses the next exec; removing it lets the program run again.                                                                                                                                                                 | Replays what `flow.integration.test.ts` proves once per CI run (GA §5.2 #5) on any machine — the one check that proves enforcement, not configuration.                                                                                                  |
| osquery live with an eBPF launch row | osqueryd active, config schedules `vigil_process_events`, `enable_bpf_events=true`, and a launch the check itself made appears in `/var/log/osquery/osqueryd.results.log` within `--osquery-wait` seconds (default 60).                                        | The whole Linux sensor model rides on `bpf_process_events` (GA §3.3), which is silently absent on exotic kernels (GA §4.2 #5) — only an observed row proves the pipeline is live.                                                                       |
| uninstall cleanliness                | Nothing Vigil installs is left behind when the helper is gone (`/usr/libexec/vigil-helper{,.d}`, unit, polkit policy, socket, Vigil's fapolicyd rules, Vigil's osquery config); with `--uninstall-roundtrip`, it uninstalls, asserts, and reinstalls for real. | `apt remove` does **not** remove the root helper (GA G7) — install.sh's files live outside dpkg's manifest. Quarantined files in `/var/lib/vigil` and lingering nftables blocks are documented stayers (uninstall.sh), so they are NOTEs, not failures. |

### Safety properties

- **Read-only by default.** The only mutation in the default run is the deny
  roundtrip: it writes its own rules file (`05-vigil-validate.rules`, which
  sorts ahead of Vigil's `05-vigil.rules` and the `06-` allow-all, so the
  allow-all cannot mask it), restarts fapolicyd twice, and restores both
  through an EXIT trap. It never writes Vigil's own rules.
- **Restart, not SIGHUP**, for the roundtrip: on fapolicyd 1.3 a reloaded
  rule never matches a sha256hash (packages/helper/src/commands/fapolicyd.ts).
- **`--uninstall-roundtrip` is opt-in** because it is destructive; it ends
  with the helper reinstalled and answering, or with an explicit NOTE if no
  `install.sh` sits next to the uninstall script.
- **Root required**, because the checks read systemd, fapolicyd, and `/run`
  state only root sees. Exit codes: `0` all pass, `1` any check failed,
  `2` could not run here (not root, not Linux, unknown family).

## Family modules

`family_from_osrelease` mirrors `plan.ts`'s `linuxDistro()` — the same read of
`ID` and `ID_LIKE` into the same buckets — except the routine names the dnf
bucket `rhel` (a Rocky user is never "fedora"). What actually differs per
family is small and honest about it:

- `debian.sh` — `check_package_install` reads dpkg's status record and
  requires the helper install script inside `/opt/Vigil at Home`.
- `rhel.sh` — `check_package_install` is the AppImage path; there is no rpm
  target to read a record from (Spec: non-goals).

Everything else — helper, socket, fapolicyd, osquery, uninstall — is identical
across families because the product's own scripts are (install.sh is
rpm-agnostic; fagenrules + restart is the fapolicyd reload path on both).

## Self-test and sabotage

`--self-test` (no root, no mutation, runs in the check job via its vitest
wrapper) verifies: family detection against the `/etc/os-release` fixtures
that decide apt vs dnf; the remedy registry covers all seven check names; and
the pass/fail wiring twice — every check stubbed to pass exits 0 with seven
PASS lines, one check stubbed to fail exits nonzero with exactly one FAIL
line. That last assertion is the sabotage-and-expect-fail property the spec
requires, replayed on every `pnpm test` instead of only on a sabotaged
machine. `scripts/validate-linux.test.mjs` additionally pins the contract
that survives outside the machine: unknown family refuses (exit 2) before the
root check, known family demands root.

## CI tiers: what CI proves and what stays manual

From the validation matrix (GA §5.1):

| Tier | What runs                                                                                                         | Where                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A    | Full root integration suite on Ubuntu 24.04 (nftables, fapolicyd 1.3.x enforcement, osquery eBPF, helper install) | `ci.yml` `linux` job — unchanged, the anchor                            |
| B    | Same suite on Rocky Linux 9 (dnf, fapolicyd 1.4.x) — one scenario skipped (the Rocky kill-path finding, below)    | `ci.yml` `linux-dnf` container job (privileged, systemd as PID 1)       |
| C/D  | SELinux-enforcing RHEL, real-desktop flows (tray, popups, pkexec dialogs), Arch/Omarchy, Debian 12                | manual — the routine is the documented way to run them on real hardware |

The container jobs run the same six integration files via
`scripts/ci/container-integration-tests.sh`; no test changes were expected
here, but two were needed (below): the setup test's distro gate, and the
conditional skip of the scenario the Rocky job caught.

### The setup-test distro gate

The spec and GA both claimed the container's `os-release` flips the setup
test's skip automatically, with no test changes. Reading the test showed
otherwise: it hard-coded `distro: 'debian'` in **both** its gate
(`linuxDistro(release) === 'debian'`) and its `setupPlan` call, so a
dnf-family container would have skipped it and the job would have been green
while testing nothing. The fix detects the family and passes it through, so
Ubuntu keeps running the apt branch and Rocky runs the dnf branch
(`debian:bookworm` the apt branch again). The other five integration files
have no distro gate.

### Why there is no Debian 12 container job

A Debian 12 (`debian:bookworm`) container job was part of the first push, and
its failure is the useful kind — the kind the container tier exists to catch.
fapolicyd 1.1.7 never reached enforcing in the container, first with the
original 30 s wait and again with a 2 min wait: the daemon's own journal
(dumped by `scripts/ci/container-integration-tests.sh` on failure) shows

```
fapolicyd[5633]: Loading trust data from file backend
fapolicyd[5633]: Permission denied
fapolicyd[5633]: open_dbi:Permission denied
fapolicyd[5633]: The size obtained by get_pages_in_use() was 0.
```

fapolicyd 1.1.7 cannot open its trust database inside this container tier, so
`fapolicyd-cli --check-status` never reports enforcing no matter how long the
test waits (observed across ~28 min of daemon uptime). The container-level
why (what denies root a db open that works on the Debian 13 sandbox and
Ubuntu 24.04's 1.3.x) is undetermined — the job was removed rather than
carried as permanently red. The spec allowed exactly this: the Debian 12 job
was to be added "only if it costs little", and a never-green check costs
more than it validates. Debian 12 moves to the manual tier: on real hardware
the routine's fapolicyd check decides, and the version floor for the
enforcing check is fapolicyd 1.3+ (Ubuntu 24.04, Debian 13) — content D3's
getting-started document carries.

### Container boot hardening — mirror variance is the residual failure mode

The digest pin freezes image _content_; it cannot freeze Rocky's _mirror
infrastructure_. Boot failed twice on the identical pinned digest with two
different stall signatures — once with the BaseOS download still in flight
when the 180 s wait expired, once with dnf producing no output at all (a
silent mirrorlist/metadata stall) — sandwiching two clean boots. The
hardening: the cold install now reads `dnf install -y --disablerepo="*"
--enablerepo=baseos --setopt=timeout=30 --setopt=retries=10 systemd` and the
wait budget is 240×2 s. BaseOS-only is the load-bearing change: run 3's log
showed systemd coming from BaseOS, so the appstream/extras metadata fetches
were non-load-bearing stall surface, now removed. The explicit timeout/retry
bounds document the failure mode and guard against base-image dnf.conf
overrides (dnf's stock defaults are reportedly the same 30 s/10 values —
training knowledge, not verified this session — so expect the flags to be
insurance, not a behavior change). If boot still fails on more than 1 of the
next 4 runs, the next move is baking the systemd install into an image layer
built in the job, not another parameter tweak.

### Registry move — Docker Hub throttling, and the shadow-perms catch

The mirror-variance hardening proved out (boots clean), and the next failure
landed one layer up: the registry itself. Two consecutive runs died before
boot at exit 125 — the runner's Docker daemon timed out fetching the Docker
Hub auth token for the pinned digest (21:46:06Z and 21:48:26Z on the same
head), while the same endpoint answered from outside in 0.17 s. That is
Docker Hub's chronic anonymous-pull throttling of GitHub-runner egress IPs,
so a retry loop would only add latency and still fail while the pool is
throttled. The pin moved to Rocky's own registry mirror,
`quay.io/rockylinux/rockylinux:9` (digest verified against the registry API
when choosing it), with the freeze-by-hand contract unchanged.

The new digest is a different build, and it surfaced a second environmental
failure: the wizard's exact commands died at sudo with `PAM account
management error: Authentication service cannot retrieve authentication
info`. The image ships `/etc/shadow` as mode 000 (no read for anyone — the
old hub build was rescued incidentally by a shadow-utils upgrade whose
post-install reset the mode), and on the Ubuntu runner's AppArmor the kernel
denies `unix_chkpwd` the `cap_dac_override` that reading a 000 file needs,
so the PAM account check fails even for root. The fix is the community-
confirmed one from rocky-linux/sig-cloud-instance-images#56 and
geerlingguy/docker-rockylinux9-ansible#6: `chmod 0400 /etc/shadow` after the
dnf installs — owner-read needs no dac_override. Both upstream reports note
the failure is not reproducible off Ubuntu hosts, which matches this
investigation: the identical sequence ran clean under podman on a Debian 13
sandbox.

### The Rocky kill-path finding — the container tier's first catch

This is the finding the spec's load-bearing assumption said these jobs would
surface: a genuine distro difference no amount of Ubuntu CI could show. With
the container booting deterministically (digest-pinned image, systemd-aware
wait — the workflow step's comment records why the pin is bumped by hand),
the full suite ran on Rocky 9:

- helper-install passed, and **linux-setup passed both tests on the dnf
  branch** — the osquery rpm-repo and `dnf install fapolicyd` commands the
  gap analysis flagged as never-executed (GA G1) finally ran and were proven.
- The same job caught an rpm query-format incompatibility that left the
  package-trust index empty on el9 (every binary read "unsigned"); fixed on
  this branch by reading rpm's trust listing across rpm versions.
- The `nftables` scenario of `flow.integration.test.ts` passed — osquery
  events reach the helper and response actions work on Rocky.
- The malware-kill scenario failed, and the instrumentation added for this
  effort narrowed it: the helper client saw 77 launches and the stand-in's
  row reached the results log exactly once, but no kill was recorded and the
  process survived the 60 s wait. The defect sits between launch ingestion
  and the hash/kill decision, and it is Rocky-specific; the rpm fix was
  verified in the setup tests but did not resolve it.
- Once flow stopped blocking the run, `linux.integration.test.ts` surfaced
  the next file's Debian-layout assumption: it asserted the helper reports
  `/usr/bin/sleep` for a spawned sleep, but Rocky 9's default coreutils-single
  makes `/usr/bin/sleep` a symlink to `/usr/bin/coreutils`, and
  `/proc/<pid>/exe` resolves symlinks. The helper's kernel-verified identity
  is correct behavior; the test now asserts kernel-consistency (identity
  equals `readlink /proc/<pid>/exe`) and drives suspend/kill with that
  resolved path, keeping the scenario fully exercised on both families.

Per the maintainer's decision, the scenario is conditionally skipped on the
dnf family (`it.skipIf(dnfFamily)` with a loud reason naming the task) so
the job stays green and the other five scenarios keep exercising the
previously-never-run dnf branch on every push. The skip is tracked as
**todo_Jlc0VwxN — "Fix Rocky (dnf-family) kill-path bug surfaced by the dnf
CI job"**; that fix's PR branches off main and uses this very job as its
verification instrument, which is why D2 lands first. Do not re-enable the
scenario silently; removing the skip is that task's last step.

## Acceptance criteria (Spec D2)

| Criterion                                                              | Verified by                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate-linux.sh` exits 0 on a healthy Debian-family system, as root | Run on the repo sandbox (Debian 13) with the .deb, helper, fapolicyd and osquery installed. **Evidence caveat:** 6 of 7 checks PASSED; the seventh (osquery eBPF row) could not verify locally — the sandbox kernel denies osquery's BPF publisher its syscall tracepoint, and the routine rightly failed that check. The check's pass path is exercised in CI (`linux`, and the osquery setup `linux-dnf` proves), so full eBPF evidence comes from CI, not the sandbox run |
| …and exits nonzero when a step is sabotaged                            | Sabotage run (fapolicyd stopped) recorded in the PR; the sabotage path is additionally exercised on every `pnpm test` by the self-test                                                                                                                                                                                                                                                                                                                                       |
| dnf-family job green in CI                                             | `linux-dnf` job on this PR, with the one Rocky-blocked scenario conditionally skipped (finding above, tracked as todo_Jlc0VwxN); the other five scenarios and both setup tests run on every push                                                                                                                                                                                                                                                                             |
| Ubuntu integration suite unaffected                                    | `linux` job on this PR                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Routine is CI-usable and human-usable                                  | Exit codes 0/1/2, PASS/FAIL plus remedy per check, documented in `--help` and here                                                                                                                                                                                                                                                                                                                                                                                           |

## Out of scope, documented as follow-ups

AppImage runtime CI (GA G5), Linux GUI e2e (GA G6), an SELinux-enforcing VM
tier, an rpm package target, the Arch manual routine's content (D4's
document), and the integration-test ordering fragility (GA G9 — test-hygiene
work deliberately left out of the hardening effort).

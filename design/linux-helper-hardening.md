# Design: hardening the Linux root helper

The design rationale for the D1 hardening set. Companion documents: the security
review this work came from (SR = _Vigil Linux security review_, Obvious artifact
`art_6JWj4Ijl`, repo at `67ba6fc`) and the effort's spec (SPEC = _Vigil at Home
on Linux — validate, harden, document_, `art_OrIt2PK3`). The implementation map
is IM (`art_IkQSYZL6`).

## The problem

The Linux helper is the privileged core of the product: a root daemon, started
by systemd at boot, that kills processes, writes nftables rules, quarantines
files, and edits fapolicyd rules. It takes input from every process running as
the console user — the 0600 socket file at `/run/vigil-helper.sock` is the only
thing between a random Electron renderer or script and the root command surface
[SR F1]. That trust boundary is deliberate and stays. What was not deliberate:

- **Any helper defect was root code execution.** The systemd unit was four
  lines long — `Type=simple`, `ExecStart`, `Restart`, `RestartSec` — with no
  sandboxing directive of any kind, while the daemon parses attacker-shaped
  JSON from the socket and sync payloads measured in the tens of megabytes
  [SR F2].
- **The socket's abuse value was higher than the design comments claim.** Any
  unprivileged process in the session could wield full containment as root —
  including quarantining root-owned files under `/root`, which was protected
  only as an exact path, not as a prefix [SR F5], and stopping system units
  [SR F4, deliberately out of scope here — see "Follow-ups"].
- **The install dialog was socially engineerable.** The install ran
  `pkexec /bin/sh -c <staged script>` with no dialog metadata: the password
  prompt named neither Vigil nor the operation. A user conditioned by Vigil's
  own frequent password dialogs would type their password into an identical
  anonymous prompt [SR F3].
- **The polkit policy overstated its own guarantee**: its comment claimed pkexec
  "runs only `/usr/libexec/vigil-helper approve <nonce>…`", while `exec.path`
  constrains the program only, not its arguments [SR F9].

## What changed, and what it buys

| Finding              | Fix                                                              | Blast radius after                                                                                                                           |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F2 (unit)            | systemd sandboxing, see below                                    | A helper bug is bounded to a filtered syscall set, a reduced capability set, and read-only access to everything except an explicit path list |
| F2/F1 (socket)       | 8 MiB sync-line cap, per-connection request budget, idle timeout | A same-user process cannot pin the root parser with oversized lines or starve containment with pipelined requests                            |
| F5 (`/root`)         | `/root/` in `LINUX_PROTECTED_PREFIXES`                           | Quarantine of root's files can no longer be requested by an unprivileged caller                                                              |
| F3-minimal (install) | Root-owned launcher + Vigil-named polkit action                  | The password dialog names Vigil; pkexec constrains the program to the launcher instead of `/bin/sh`                                          |
| F9 (policy comment)  | Comment rewritten                                                | Future root subcommands cannot silently inherit "only reachable via approve" reasoning                                                       |

## The systemd unit, before and after

Before — the whole `[Service]` section [SR F2]:

```ini
Type=simple
ExecStart=/usr/libexec/vigil-helper daemon
Restart=on-failure
RestartSec=5
```

After (complete unit in `apps/desktop/helper/linux/vigil-helper.service`):

```ini
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/vigil /run /tmp /var/tmp
  -/home -/root -/opt -/usr/local -/srv -/mnt -/media
  -/etc/fapolicyd -/etc/osquery -/var/log/osquery
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6
CapabilityBoundingSet=CAP_KILL CAP_NET_ADMIN CAP_DAC_OVERRIDE CAP_CHOWN
  CAP_FOWNER CAP_LINUX_IMMUTABLE CAP_SYS_PTRACE
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
SystemCallArchitectures=native
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
UMask=0077
```

(The `ReadWritePaths` entries are one line in the file; wrapped here for print.)

**Exposure score.** `systemd-analyze security vigil-helper.service` (offline
mode, systemd 257, no dynamic instance): **9.4 UNSAFE** before, **3.3 OK**
after. On a booting system the score depends on the runtime state of the
distro; the offline score is the reproducible number. Both numbers are in the
PR body.

**The capability set encodes what the helper demonstrably does** — kill
(CAP_KILL), firewall via netlink (CAP_NET_ADMIN), move and restore files across
owners (CAP_DAC_OVERRIDE, CAP_CHOWN, CAP_FOWNER), pin with chattr
(CAP_LINUX_IMMUTABLE), and verify process identity through /proc
(CAP_SYS_PTRACE). Nothing was argued for beyond the tests.

### Two directives dropped from the SPEC's sketch, on purpose

The SPEC's illustrative unit [SPEC, D1] carried `PrivateTmp=yes` and
`ProtectHome=yes`. Both are **reversed** here, and the reason is the feature
itself: quarantine moves files out of user-writable places — `/tmp`, `/home`
and `/root` above all — into the quarantine store. `PrivateTmp` would hide the
real `/tmp`; `ProtectHome` would make `/home` and `/root` invisible or
read-only, breaking the exact moves the helper exists to make. Instead:

- `ProtectSystem=strict` still makes the whole filesystem hierarchy read-only
  except the explicit `ReadWritePaths` list, so the mount-level protection the
  sketch wanted is intact for everything the helper does not have to touch.
- Quarantining files _from_ `/tmp` needs write access to `/tmp` itself, which
  is what `ReadWritePaths=/tmp /var/tmp` grants; the staged-install temp dirs
  are created by the install script, outside the daemon.

This is the SPEC's own test applied: "anything the integration tests prove
unnecessary is removed, not argued for" — here, anything the tests prove
_harmful_ is dropped, not argued for.

### The syscall filter is not the reversible piece — it ships

The SPEC flagged `SystemCallFilter` as the one consciously reversible piece: if
the bundled Node runtime could not survive the filter, the unit would ship
without it. It survives: the filter ships with `SystemCallErrorNumber=EPERM`,
so unknown syscalls fail with a permission error instead of killing the process
— libuv's io_uring probe degrades rather than dies, and the root integration
suite is the behavioral proof on the runner. The reversal condition is
unchanged: a red integration test on the runner because of the filter removes
it and documents the gap.

## Socket limits, measured not guessed

`packages/helper/src/server.ts` gains three limits:

- **Sync line cap — 8 MiB.** The old 64 MiB single-line allowance was
  unnecessary: the app already ships a chunked path (`detection.list.set`)
  for list contents. Measured this effort: the largest real rule-set sync
  observed (3,200 rules, 64 copies of the builtin catalog) was 4.3 MB; a
  pathological valid sync with no inline list entries measures ~50 MB of raw
  wire bytes but is _sent as chunks plus one small final sync_, so it never
  approaches the cap as a single line. 8 MiB is above the measured maximum
  with headroom and far below 64 MiB. The app's `HelperLink.syncRules` now
  uploads changed lists through chunked `detection.list.set` requests _before_
  the sync, and omits inline `entries` from the sync payload.
- **Per-connection request budget** — 240 burst requests, refilling at 20 per
  second. A budget-exhausted connection is closed after draining responses for
  requests already accepted (a refusal must not swallow their responses);
  other connections are unaffected.
- **Idle timeout** — 5 minutes of silence closes a connection. Event
  subscribers are exempt: they hold the socket deliberately.

Tests cover the clean rejection of an oversized sync line (with a separate
smaller cap for non-sync requests), budget exhaustion without taking down the
server, and normal traffic flowing — including that a pipelined request's
response arrives even when the budget refusals land around it.

A helper that predates `detection.list.set` rejects that request and leaves
rules unapplied until it is updated. That is deliberate: fail-closed, and the
app installs its matching helper version anyway.

## `/root` protection

`LINUX_PROTECTED_PREFIXES` in `packages/helper/src/config.ts` gains `/root/`
alongside the other protected prefixes, so a quarantine or transfer request
targeting anything under root's home is refused at the protocol level rather
than executed as root [SR F5]. The refusal tests cover `/root/.ssh/authorized_keys`
and `/root/.bashrc`. The list is path-scoped, not regex — over-matching a
legitimate user path would look like `/home/…` refusing, which the existing
tests still guard.

## The polkit install dialog

Before [SR F3]: `pkexec /bin/sh -c <rootStageScript> …` — no dialog metadata.

After: the install routes through a dedicated root-owned launcher
(`/usr/libexec/vigil-helper-launcher`, installed by `install.sh`, digest-covered
as a staged file) and a dedicated polkit action
(`com.vigilathome.helper.install`), whose `<message>` names Vigil and states
the operation: "Vigil at Home wants to install, update or remove its helper,
which watches what runs on this computer and blocks threats." The
`com.vigilathome.helper.policy` comment now states what `exec.path` actually
constrains — the program, not its arguments — for both actions [SR F9].

The staged digest-verification contract is untouched: the launcher embeds the
same copy-and-verify logic as `rootStageScript('linux')`, re-verifying every
staged file's digest as root before anything runs. A tampered or drifted stage
is refused with nothing changed, asserted by the extended
`helper-install.integration.test.ts` (a valid stage installs; a stage with a
modified file after the digest is computed is refused).

**Honest boundary.** This is F3-minimal, as the SPEC settled: the caller still
stages the files and computes the digest, so the launcher does not solve
provenance (that is F7, signed artifacts, a documented follow-up), and the
dialog text is static — it cannot name the specific operation being approved
(that is F3-full, also a follow-up). What it fixes is the _identity_ of the
asking party: the dialog now names Vigil, and pkexec constrains the program to
the launcher rather than `/bin/sh`.

## Decisions kept, not "fixed"

These are design choices the SPEC says the build must preserve, restated here
because each hardening change sits next to one:

- **The 0600 socket is the trust boundary** [SR F1]. D1 shrinks its abuse
  value (budget, line cap) — it does not redesign it. No token, no
  SO_PEERCRED.
- **Staged, digest-verified installs.** Root never executes bytes a user could
  have swapped mid-flight [IM §1.2]; the launcher is a new caller of the same
  contract, not a new contract.
- **fapolicyd runs `trust = file` behind an allow-all rule**; Vigil's own
  index is the single allow-list substrate [IM §4.2]. Linux blocking stays
  hash-only; no allow rules.
- **Containment runs without a password.** The budget and caps bound what an
  abusive same-user caller can _do to the helper_; they do not gate the
  containment actions themselves, which are the product.

## Acceptance criteria

| Criterion                                                                                      | How verified                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Hardened unit; integration suite green under it; exposure score drops                          | `systemd-analyze security` before/after in the PR (9.4 → 3.3, offline); all six root `*.integration.test.ts` as root on the runner |
| Oversized sync line rejected cleanly; budget-exhausted connection closed; normal traffic flows | New unit tests against `server.ts` limits; existing protocol and fastpath tests green                                              |
| `file.quarantine /root/…` refused                                                              | New refusal cases in the Linux quarantine tests                                                                                    |
| Install runs through the Vigil-named action; policy comment states what `exec.path` constrains | `helper-install.integration.test.ts` asserts the launcher, the policy content, and the digest roundtrip through the launcher       |
| All CI gates green                                                                             | Naming lint, eslint+prettier, typecheck, vitest, root integration job                                                              |

## Follow-ups, documented not silent

- **F7 — signed artifacts**: the staged digest protects the race, not
  provenance. Publish signed checksums and verify them in the wizard.
- **F3-full — dialog UX**: a human summary of the specific operation in every
  dialog, not just the static Vigil-named install message.
- **F4 — `persistence.disable` ordering**: the stop-before-vet ordering issue
  [SR F4] is real but touches the persistence command surface, not the helper's
  sandbox; the SPEC scoped it out of this PR and it stays a listed follow-up.
- **AppImage runtime verification** under FUSE-less execution [SR §3.7] and the
  other dynamic security assumptions in SR §3 stay on the manual checklist
  (D2's routines fold in what they can reach).
- **G9 — CI ordering fragility** in the integration-test dependency chain
  [GA G9]: test hygiene, no user-visible effect, deliberately not bundled here.

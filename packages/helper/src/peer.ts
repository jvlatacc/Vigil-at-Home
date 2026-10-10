// Who may drive the helper over its command socket (finding HELPER-01).
//
// The socket file's 0600 mode and owner keep other accounts off, but any
// program running as the user could connect — and malware running as the
// user is this product's threat model. So commands that change state
// (everything but the read-only queries) are refused unless the connecting
// process is the app the helper serves: the pinned app (appPin.ts
// runsPinnedApp, the same check that protects a kill target), a program
// inside the installer's root-owned folder, or — for AppImage builds, which
// never sit in that folder — a program running from a self image a
// password-approved grant named (fastpath.self()). Those are the sets the
// helper's own rules already treat as Vigil's own, so nothing new is
// trusted here. Read-only queries (status, journal, Santa's profile,
// detection status, event subscriptions) stay open to every same-user peer,
// so the dashboard, the CLI and socketProbe keep working.
//
// How the peer is found, on Linux: Node exposes no getsockopt, so the
// kernel's socket pairing is read with ss(8) (iproute2, over netlink
// unix_diag — the same kernel data SO_PEERCRED would come from). The
// accepted socket's descriptor gives its inode (procFds of the helper's own
// pid), and the one ss line whose peer is that inode names the client pid
// in its users field. When the pairing can't be read (no ss, a sandboxed
// /proc), the peer is unidentified and state-changing commands are refused:
// the helper fails closed. macOS: Node can neither call getsockopt
// (LOCAL_PEERPID, getpeereid) nor read a peer pid dependably any other way,
// so peer verification is not available there; the guard logs once and
// allows, which keeps macOS behavior as it was until the gap is closed
// natively.
//
// Refusals are audited (journal kind peer-refused) and rate-limited per
// peer pid, so a peer that hammers the socket can't bloat the journal.

import type { Socket } from 'node:net';
import { insideInstalledRoot } from '@vigil/core/self';
import { identifyProcess, type ProcessIdentity } from './commands/process.js';
import { runsFromSelfImage } from './commands/selfImage.js';
import { Journal } from './journal.js';
import type { HelperCommand } from './protocol.js';
import type { System } from './system.js';

/** The read-only kinds any same-user peer may ask; everything else changes state. */
const READ_ONLY: ReadonlySet<HelperCommand['kind']> = new Set([
  'helper.status',
  'helper.journal',
  'santa.profile',
  'detection.status',
  'events.subscribe',
]);

/** Whether `cmd` changes the helper's state and so needs a verified peer. */
export function isStateChanging(cmd: HelperCommand): boolean {
  return !READ_ONLY.has(cmd.kind);
}

/** Why a state-changing command was refused. */
type PeerRefusalCode = 'peer-not-pinned' | 'peer-unidentified';

/** The gate's answer for one command: allowed, or why it was refused. */
export type PeerVerdict = { allow: true } | { allow: false; code: PeerRefusalCode; detail: string };

export interface PeerGuard {
  /** Whether the process on the far end of `sock` may run `cmd`. */
  check(sock: Socket, cmd: HelperCommand): Promise<PeerVerdict>;
}

export interface PeerGuardOptions {
  sys: System;
  /** The installer's own root-owned folders (config installedSelf). */
  installed: readonly string[];
  /**
   * Whether the identified process is the app pinned at install
   * (executor.ts pinCheck); 'changed' means it was replaced mid-check.
   * Absent when no pin is configured.
   */
  isPinnedApp?: (id: ProcessIdentity) => Promise<boolean | 'changed'>;
  /** The approved AppImages (fastpath.self().images), by file id. */
  selfImages: () => readonly string[];
  /** The audit trail; refusals land here as peer-refused entries when given. */
  journal?: Journal;
  log?: (msg: string) => void;
  /**
   * How to find the peer pid for a descriptor (peer.ts's ss pairing).
   * Tests inject one; production wiring uses the default.
   */
  peerPid?: (fd: number) => Promise<number | undefined>;
}

/** Refusals one peer may have audited in a window; past it, log only. */
const REFUSAL_WINDOW_MS = 60_000;
const REFUSAL_MAX = 8;

/** Builds the guard the daemon wires into its HelperServer. */
export function createPeerGuard(opts: PeerGuardOptions): PeerGuard {
  if (opts.sys.platform !== 'linux') {
    opts.log?.(
      'peer verification is not available on macOS; state-changing commands stay open to ' +
        'same-user peers as before (HELPER-01)',
    );
    return { check: async () => ({ allow: true }) };
  }

  // Refusal timestamps by peer pid; an unidentified peer shares bucket 0.
  const refusals = new Map<number, number[]>();

  const allow: PeerVerdict = { allow: true };

  /** Audit and rate-limit a refusal, then answer it. */
  function refuse(
    cmd: HelperCommand,
    code: PeerRefusalCode,
    detail: string,
    pid?: number,
  ): PeerVerdict {
    const now = opts.sys.now();
    const bucket = pid ?? 0;
    const times = (refusals.get(bucket) ?? []).filter((t) => now - t < REFUSAL_WINDOW_MS);
    times.push(now);
    refusals.set(bucket, times);
    const count = times.length;
    opts.log?.(`refused ${cmd.kind} from ${detail}${count > REFUSAL_MAX ? ' (rate-limited)' : ''}`);
    if (count <= REFUSAL_MAX) {
      opts.journal?.add({
        id: Journal.newId(),
        kind: 'peer-refused',
        state: 'final',
        summary: `refused ${cmd.kind}: ${detail}`,
        attempted: cmd.kind,
        ...(pid !== undefined ? { peerPid: pid } : {}),
      });
    }
    return { allow: false, code, detail };
  }

  return {
    async check(sock, cmd) {
      if (!isStateChanging(cmd)) return allow;
      const fd = fdOf(sock);
      const pid =
        fd === undefined ? undefined : await (opts.peerPid?.(fd) ?? peerPid(opts.sys, fd));
      if (pid === undefined)
        return refuse(cmd, 'peer-unidentified', 'could not identify the connecting process');
      const id = await identifyProcess(opts.sys, pid);
      if (id === undefined)
        return refuse(cmd, 'peer-unidentified', `peer pid ${pid} is not running`);

      const pinned = opts.isPinnedApp ? await opts.isPinnedApp(id) : false;
      if (pinned === 'changed')
        return refuse(
          cmd,
          'peer-not-pinned',
          `${id.path} (pid ${pid}) changed while it was being checked`,
          pid,
        );
      if (pinned) return allow;

      // Without a pin, the same sets the helper's own rules call Vigil:
      // the installer's folder, or an approved AppImage's mount.
      const viaImage = runsFromSelfImage(opts.sys, pid, opts.selfImages());
      if (insideInstalledRoot(id.path, 'linux', { roots: opts.installed }) || viaImage)
        return allow;

      return refuse(cmd, 'peer-not-pinned', `${id.path} (pid ${pid}) is not Vigil`, pid);
    },
  };
}

/**
 * The pid on the far end of the accepted socket with descriptor `fd`:
 * the socket's inode from the helper's own open files, then the one ss
 * line paired to it. Undefined when either step can't be read — the
 * caller refuses, rather than trust an unidentified peer.
 */
async function peerPid(sys: System, fd: number): Promise<number | undefined> {
  const link = sys.procFds?.(sys.selfPid()).find(([f]) => f === fd)?.[1];
  const inode = /^socket:\[(\d+)\]$/.exec(link ?? '')?.[1];
  if (!inode) return undefined;
  for (const bin of ['ss', 'ssUsrBin'] as const) {
    const out = await sys.run(bin, ['-x', '-p'], { timeoutMs: 5_000 });
    if (out.code !== 0) continue;
    return clientPidFromSs(out.stdout, inode);
  }
  return undefined;
}

/**
 * From `ss -x -p` output: the pid holding the socket whose peer is
 * `acceptedInode` (the helper's accepted socket). Lines look like
 *
 *   u_str ESTAB 0 0 /run/vigil-helper.sock 123 * 456 users:(("vigil-helper",pid=99,fd=7))
 *
 * Local is "<path|*> <inode>", peer "* <inode>", and the users field may
 * name several processes sharing the descriptor — the last pid is the
 * one ss attributes it to. Undefined when no line pairs to the inode.
 */
export function clientPidFromSs(text: string, acceptedInode: string): number | undefined {
  for (const line of text.split('\n')) {
    const m = /^(.*)\s+users:\((.*)\)\s*$/.exec(line);
    if (!m) continue;
    const cols = m[1]!.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const peer = cols[cols.length - 1]!;
    const local = cols[cols.length - 3]!;
    if (peer !== acceptedInode || local === acceptedInode) continue;
    const pids = [...m[2]!.matchAll(/pid=(\d+)/g)];
    const pid = pids.at(-1)?.[1];
    if (pid) return Number(pid);
  }
  return undefined;
}

/**
 * The descriptor of an accepted socket. Node exposes no public fd for a
 * stream socket; the stream's internal handle holds the one the kernel
 * assigned, stable while the connection is open.
 */
function fdOf(sock: Socket): number | undefined {
  const handle = (sock as unknown as { _handle?: { fd?: number } | undefined })._handle;
  return typeof handle?.fd === 'number' && handle.fd >= 0 ? handle.fd : undefined;
}

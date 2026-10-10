// peer.ts against fakes: the ss pairing parser, what counts as state-
// changing, and the guard's admit/refuse decisions with an injected peer
// pid. The end-to-end behavior over a real socket is peer.integration.test.ts.
import { describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { clientPidFromSs, createPeerGuard, isStateChanging } from './peer.js';
import type { ProcessIdentity } from './commands/process.js';
import type { HelperCommand } from './protocol.js';
import type { PeerGuardOptions } from './peer.js';
import { FakeLinuxSystem } from './testing/fakeLinuxSystem.js';
import { FakeSystem } from './testing/fakeSystem.js';

// Only the kind matters to the guard, so commands are minimal but valid.
const kill = (pid = 4242): HelperCommand => ({ kind: 'process.kill', pid, path: '/usr/bin/yes' });
const status = (): HelperCommand => ({ kind: 'helper.status' });

const EVIL = '/tmp/evil/evil.bin';
const INSIDE = '/opt/Vigil at Home/vigil';
const IMAGE = '/home/alice/Apps/Vigil.AppImage';
const PEER_PID = 4321;

/** The accepted socket as far as the guard sees it (the internal handle's fd). */
const sock = (fd = 7): Socket => ({ _handle: { fd } }) as unknown as Socket;

function peerSys(path = EVIL): { sys: FakeLinuxSystem; peerPid: number } {
  const sys = new FakeLinuxSystem();
  sys.processes.set(PEER_PID, { path, started: '100' });
  // The helper's own open files: the accepted socket on fd 7.
  sys.fds.set(sys.pid, [[7, 'socket:[123]']]);
  return { sys, peerPid: PEER_PID };
}

function guard(
  sys: FakeLinuxSystem,
  o: {
    journal?: Journal;
    selfImages?: () => readonly string[];
    isPinnedApp?: (id: ProcessIdentity) => Promise<boolean | 'changed'>;
    peerPid?: (fd: number) => Promise<number | undefined>;
    /** Use peer.ts's real resolver (procFds + ss) instead of an injected pid. */
    realResolver?: boolean;
  } = {},
) {
  const opts: PeerGuardOptions = {
    sys,
    installed: ['/opt/Vigil at Home'],
    // The ss pairing is the real system's job; tests say who connects.
    peerPid: o.peerPid ?? (async () => PEER_PID),
    selfImages: o.selfImages ?? (() => []),
    ...(o.isPinnedApp ? { isPinnedApp: o.isPinnedApp } : {}),
    ...(o.journal ? { journal: o.journal } : {}),
  };
  if (o.realResolver) delete opts.peerPid;
  return createPeerGuard(opts);
}

describe('isStateChanging', () => {
  it('lets any peer ask the read-only queries', () => {
    for (const kind of [
      'helper.status',
      'helper.journal',
      'santa.profile',
      'detection.status',
      'events.subscribe',
    ] as const) {
      expect(isStateChanging({ kind } as HelperCommand)).toBe(false);
    }
  });

  it('requires a verified peer for everything else', () => {
    expect(isStateChanging(kill())).toBe(true);
    expect(isStateChanging({ kind: 'process.suspend', pid: 1 })).toBe(true);
    expect(isStateChanging({ kind: 'file.quarantine', path: '/tmp/a' })).toBe(true);
    expect(isStateChanging({ kind: 'persistence.disable', path: '/tmp/a' })).toBe(true);
    expect(isStateChanging({ kind: 'network.block', address: '203.0.113.9' })).toBe(true);
    expect(
      isStateChanging({
        kind: 'detection.sync',
        rules: [],
        exceptions: [],
        selfPaths: [],
        lists: {},
        entries: {},
      }),
    ).toBe(true);
  });
});

describe('clientPidFromSs', () => {
  it('pairs the one line whose peer is the accepted socket', () => {
    const text = [
      'State Recv-Q Send-Q Inode Port PID Program',
      'u_str ESTAB 0 0 * 999 0 0 * 0 users:(("vigil-helper",pid=999,fd=3))',
      'u_str ESTAB 0 0 /run/vigil-helper.sock 123 * 456 users:(("vigil-helper",pid=999,fd=12))',
      'u_str ESTAB 0 0 * 456 * 123 users:(("vigil",pid=4242,fd=9))',
      'u_str ESTAB 0 0 /tmp/other.sock 777 * 888 users:(("other",pid=555,fd=4))',
      '',
    ].join('\n');
    expect(clientPidFromSs(text, '123')).toBe(4242);
  });

  it('takes the last pid when several share the descriptor', () => {
    const text = 'u_str ESTAB 0 0 * 456 * 123 users:(("a",pid=10,fd=3),("b",pid=11,fd=4))\n';
    expect(clientPidFromSs(text, '123')).toBe(11);
  });

  it('finds nothing on sandboxed /proc (peer "0") or unrelated sockets', () => {
    const text =
      'u_str ESTAB 0 0 /run/vigil-helper.sock 123 * 0 users:(("x",pid=999,fd=7))\n' +
      'u_str ESTAB 0 0 * 0 * 0 \n';
    expect(clientPidFromSs(text, '123')).toBeUndefined();
    expect(clientPidFromSs('', '123')).toBeUndefined();
  });
});

describe('peer guard on Linux', () => {
  it('refuses an unidentified peer before running anything', async () => {
    const { sys } = peerSys();
    sys.fds.delete(sys.pid); // no /proc/<self>/fd: the pairing can't start
    const journal = new Journal(
      join(mkdtempSync(join(tmpdir(), 'peer-unidentified-')), 'journal.json'),
    );
    const g = guard(sys, { journal, realResolver: true });
    await expect(g.check(sock(), kill())).resolves.toMatchObject({
      allow: false,
      code: 'peer-unidentified',
    });
    expect(journal.recent().filter((e) => e.kind === 'peer-refused')).toHaveLength(1);
  });

  it('refuses when the peer pid is not running', async () => {
    const { sys } = peerSys();
    const g = guard(sys, { peerPid: async () => 4711 }); // 4711 is not in the fake
    await expect(g.check(sock(), kill())).resolves.toMatchObject({
      allow: false,
      code: 'peer-unidentified',
    });
  });

  it('admits the pinned app', async () => {
    const { sys } = peerSys();
    const g = guard(sys, { isPinnedApp: async () => true });
    await expect(g.check(sock(), kill())).resolves.toEqual({ allow: true });
  });

  it('refuses a peer that changed while it was being checked', async () => {
    const { sys } = peerSys();
    const g = guard(sys, { isPinnedApp: async () => 'changed' });
    await expect(g.check(sock(), kill())).resolves.toMatchObject({
      allow: false,
      code: 'peer-not-pinned',
      detail: expect.stringContaining('changed'),
    });
  });

  it('admits a program inside the installer folder without a pin', async () => {
    const { sys } = peerSys(INSIDE);
    const g = guard(sys);
    await expect(g.check(sock(), kill())).resolves.toEqual({ allow: true });
  });

  it('admits a program running an approved self image', async () => {
    const { sys } = peerSys(IMAGE);
    sys.files.set(IMAGE, '8:42');
    const g = guard(sys, { selfImages: () => ['8:42'] });
    await expect(g.check(sock(), kill())).resolves.toEqual({ allow: true });
  });

  it('refuses everything else, audited and rate-limited per peer', async () => {
    const { sys } = peerSys();
    const journal = new Journal(join(mkdtempSync(join(tmpdir(), 'peer-refused-')), 'journal.json'));
    const g = guard(sys, { journal });
    for (let i = 0; i < 12; i++) {
      await expect(g.check(sock(), kill())).resolves.toMatchObject({
        allow: false,
        code: 'peer-not-pinned',
      });
    }
    const rows = journal.recent().filter((e) => e.kind === 'peer-refused');
    expect(rows).toHaveLength(8); // REFUSAL_MAX: past it, log only
    expect(rows[0]).toMatchObject({
      attempted: 'process.kill',
      peerPid: PEER_PID,
      state: 'final',
    });
  });

  it('always answers read-only queries, even from an unidentified peer', async () => {
    const { sys } = peerSys();
    sys.fds.delete(sys.pid);
    const g = guard(sys, { realResolver: true });
    await expect(g.check(sock(), status())).resolves.toEqual({ allow: true });
  });
});

describe('peer guard on macOS', () => {
  it('keeps the pre-gate behavior and says so once', async () => {
    const sys = new FakeSystem();
    const logs: string[] = [];
    const g = createPeerGuard({
      sys,
      installed: ['/Applications/Vigil at Home.app'],
      selfImages: () => [],
      log: (m) => logs.push(m),
    });
    await expect(g.check({} as Socket, kill())).resolves.toEqual({ allow: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('not available on macOS');
  });
});

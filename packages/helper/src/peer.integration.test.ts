// The gate over a real socket (finding HELPER-01): a raw client the helper
// cannot pin is refused every state-changing command and audited, a stubbed
// pinned peer passes through to the executor, and read-only queries answer
// for any same-user peer. The client here is this test process; its pid
// comes from the kernel's socket pairing, which real Linux reports and
// sandboxed /proc (peer "0") does not — so the raw run accepts either
// refusal code, and the pinned pass-through injects the pid (peer.test.ts
// covers both codes deterministically).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Socket as NetSocket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleStore } from '@vigil/sensors';
import { Approvals } from './approval.js';
import { Executor } from './executor.js';
import { Journal } from './journal.js';
import { createPeerGuard, type PeerGuard } from './peer.js';
import { HelperServer } from './server.js';
import { FakeLinuxSystem } from './testing/fakeLinuxSystem.js';

const PEER_PID = 4321;
const TARGET_PID = 6000;

let root: string;
let sys: FakeLinuxSystem;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in tests
function rawCall(sockPath: string, line: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s: NetSocket = connect(sockPath);
    let out = '';
    s.on('data', (d) => {
      out += d.toString();
      if (out.includes('\n')) {
        resolve(JSON.parse(out));
        s.destroy();
      }
    });
    s.on('error', reject);
    s.write(line + '\n');
  });
}

// One of each executor branch a state-changing command touches; all of them
// must be refused before the executor sees them.
const STATE_CHANGING: unknown[] = [
  { kind: 'process.kill', pid: TARGET_PID, path: '/tmp/target' },
  { kind: 'process.suspend', pid: TARGET_PID, path: '/tmp/target' },
  { kind: 'file.quarantine', path: '/tmp/target.sh' },
  { kind: 'persistence.disable', path: '/tmp/com.vigil.test.plist' },
  { kind: 'network.block', address: '203.0.113.9' },
  { kind: 'detection.sync', rules: [], exceptions: [], selfPaths: [], lists: {}, entries: {} },
];

/** A helper on its own socket, journal and executor, with `guard` at the door. */
async function serverWith(makeGuard: (journal: Journal) => PeerGuard): Promise<{
  sock: string;
  server: HelperServer;
  journal: Journal;
}> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vigil-peer-')));
  const journal = new Journal(join(dir, 'journal.json'));
  const executor = new Executor({
    sys,
    journal,
    approvals: new Approvals({ dir: join(dir, 'approvals'), requiredOwnerUid: process.getuid!() }),
    rules: new RuleStore(join(dir, 'rules.json')),
    quarantine: { quarantineDir: join(dir, 'Quarantine') },
    launchDirs: new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    syncPort: 47821,
    triggerSantaSync: async () => {},
  });
  const server = new HelperServer({
    socketPath: join(dir, 'helper.sock'),
    executor,
    peer: makeGuard(journal),
  });
  await server.listen();
  return { sock: join(dir, 'helper.sock'), server, journal };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vigil-peer-root-')));
  sys = new FakeLinuxSystem();
  // The peer the pinned run pretends to be, and the kill target it may act on.
  sys.processes.set(PEER_PID, { path: '/tmp/evil/evil.bin', started: '100' });
  sys.processes.set(TARGET_PID, { path: '/tmp/target', started: '200' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the helper gate over a real socket', () => {
  it('refuses every state-changing command from an unpinned client and audits it', async () => {
    const { sock, server, journal } = await serverWith((j) =>
      createPeerGuard({ sys, installed: ['/opt/Vigil at Home'], selfImages: () => [], journal: j }),
    );
    for (const command of STATE_CHANGING) {
      const resp = await rawCall(sock, JSON.stringify({ id: 'r1', command }));
      expect(resp.ok).toBe(false);
      expect(['peer-not-pinned', 'peer-unidentified']).toContain(resp.code);
      expect(resp.error).toBeTruthy();
    }
    expect(journal.recent().filter((e) => e.kind === 'peer-refused')).toHaveLength(
      STATE_CHANGING.length,
    );
    await server.close();
  });

  it('still answers read-only queries from the same unpinned client', async () => {
    const { sock, server } = await serverWith((j) =>
      createPeerGuard({ sys, installed: ['/opt/Vigil at Home'], selfImages: () => [], journal: j }),
    );
    const status = await rawCall(
      sock,
      JSON.stringify({ id: 'r2', command: { kind: 'helper.status' } }),
    );
    expect(status.ok).toBe(true);
    const entries = await rawCall(
      sock,
      JSON.stringify({ id: 'r3', command: { kind: 'helper.journal' } }),
    );
    expect(entries.ok).toBe(true);
    await server.close();
  });

  it('passes a stubbed pinned peer through to the executor unchanged', async () => {
    const { sock, server } = await serverWith(() =>
      createPeerGuard({
        sys,
        installed: ['/opt/Vigil at Home'],
        selfImages: () => [],
        peerPid: async () => PEER_PID,
        isPinnedApp: async () => true,
      }),
    );
    const resp = await rawCall(
      sock,
      JSON.stringify({
        id: 'r4',
        command: { kind: 'process.kill', pid: TARGET_PID, path: '/tmp/target' },
      }),
    );
    expect(resp.ok).toBe(true);
    expect(sys.signals).toContainEqual({ pid: TARGET_PID, signal: 'SIGKILL' });
    await server.close();
  });
});

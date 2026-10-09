import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleStore } from '@vigil/sensors';
import { Approvals } from './approval.js';
import { PidReused } from './commands/errors.js';
import { identifyProcess, killProcess, suspendProcess } from './commands/process.js';
import { Executor } from './executor.js';
import { Journal } from './journal.js';
import { FakeSystem, type FakeProcess } from './testing/fakeSystem.js';
import { FakeLinuxSystem } from './testing/fakeLinuxSystem.js';

const STARTED = 'Mon Oct  5 16:20:13 2026';
const LATER = 'Mon Oct  5 16:20:14 2026';
const EVIL = '/home/alex/Downloads/evil';
const INNOCENT = '/usr/bin/yes';

/**
 * The instant the signal goes out, the target's pid is handed to another
 * program: the reuse the post-signal check exists to catch. The fake swaps
 * the identity in where the kernel would have recycled it.
 */
class RecycledMac extends FakeSystem {
  constructor(private readonly recycled: FakeProcess) {
    super();
  }
  override signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL'): void {
    this.signals.push({ pid, signal });
    this.processes.set(pid, this.recycled);
  }
}

class RecycledLinux extends FakeLinuxSystem {
  constructor(private readonly recycled: FakeProcess) {
    super();
  }
  override signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT' | 'SIGKILL'): void {
    this.signals.push({ pid, signal });
    this.processes.set(pid, this.recycled);
  }
}

describe('kill and suspend, re-checked after the signal', () => {
  it('kills a checked target on macOS and finds the pid gone afterwards', async () => {
    const sys = new FakeSystem();
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const id = await killProcess(sys, 4242, { path: EVIL });
    expect(id).toEqual({ pid: 4242, path: EVIL, started: STARTED });
    expect(sys.signals).toEqual([{ pid: 4242, signal: 'SIGKILL' }]);
    expect(await identifyProcess(sys, 4242)).toBeUndefined();
  });

  it('kills a checked target on Linux and finds the pid gone afterwards', async () => {
    const sys = new FakeLinuxSystem();
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const id = await killProcess(sys, 4242, { path: EVIL });
    expect(id.path).toBe(EVIL);
    expect(sys.signals).toEqual([{ pid: 4242, signal: 'SIGKILL' }]);
    expect(await identifyProcess(sys, 4242)).toBeUndefined();
  });

  it('pauses a checked target that still answers as itself afterwards', async () => {
    const sys = new FakeSystem();
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const id = await suspendProcess(sys, 4242, { path: EVIL });
    expect(id.pid).toBe(4242);
    expect(sys.signals).toEqual([{ pid: 4242, signal: 'SIGSTOP' }]);
    expect(await identifyProcess(sys, 4242)).toEqual(id);
  });

  it('raises when a killed pid was reused for another program (macOS)', async () => {
    const sys = new RecycledMac({ path: INNOCENT, started: LATER });
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const kill = killProcess(sys, 4242, { path: EVIL });
    await expect(kill).rejects.toBeInstanceOf(PidReused);
    await expect(kill).rejects.toMatchObject({ code: 'refused' });
    expect(sys.signals).toEqual([{ pid: 4242, signal: 'SIGKILL' }]);
  });

  it('raises when a suspended pid was reused for another program (Linux)', async () => {
    const sys = new RecycledLinux({ path: INNOCENT, started: LATER });
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    await expect(suspendProcess(sys, 4242, { path: EVIL })).rejects.toBeInstanceOf(PidReused);
    expect(sys.signals).toEqual([{ pid: 4242, signal: 'SIGSTOP' }]);
  });

  it('raises on reuse even when the new process runs the same program', async () => {
    // Same path, later start: the comparison is of the whole identity.
    const sys = new RecycledMac({ path: EVIL, started: LATER });
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    await expect(killProcess(sys, 4242, { path: EVIL })).rejects.toBeInstanceOf(PidReused);
  });
});

describe('the executor records a reused pid in the journal', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vigil-kill-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('journals the mismatch as final and refuses the command', async () => {
    const sys = new RecycledMac({ path: INNOCENT, started: LATER });
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const journal = new Journal(join(root, 'journal.json'));
    const ex = new Executor({
      sys,
      journal,
      approvals: new Approvals({
        dir: join(root, 'approvals'),
        requiredOwnerUid: process.getuid!(),
      }),
      rules: new RuleStore(join(root, 'rules.json')),
      quarantine: { quarantineDir: join(root, 'Quarantine') },
      syncPort: 47821,
    });
    await expect(ex.execute({ kind: 'process.kill', pid: 4242, path: EVIL })).rejects.toMatchObject(
      { code: 'refused' },
    );
    const entries = journal.recent();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'process.kill', state: 'final' });
    expect(entries[0]?.summary).toContain('reused');
    expect(entries[0]?.summary).toContain(INNOCENT);
  });

  it('journals a clean kill as before, with no mismatch entry', async () => {
    const sys = new FakeSystem();
    sys.processes.set(4242, { path: EVIL, started: STARTED });
    const journal = new Journal(join(root, 'journal.json'));
    const ex = new Executor({
      sys,
      journal,
      approvals: new Approvals({
        dir: join(root, 'approvals'),
        requiredOwnerUid: process.getuid!(),
      }),
      rules: new RuleStore(join(root, 'rules.json')),
      quarantine: { quarantineDir: join(root, 'Quarantine') },
      syncPort: 47821,
    });
    await ex.execute({ kind: 'process.kill', pid: 4242, path: EVIL });
    const entries = journal.recent();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'process.kill',
      state: 'final',
      summary: `stopped ${EVIL} (pid 4242)`,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseOperationLine, KERNEL_MONITOR_INDEX } from './parser.js';
import { SensorEvent } from '@vigil/core';

// The valid lines are what the daemon's own index writer renders — the shapes
// its ctest suite asserts (kernel-monitor/tests/index_test.c, PR #18) — so the
// parser is tested against the shipped format, not an invented one.

// mk_exec(1000, "sh") at wall {1728482651, 500000000}, as index_test.c builds it.
const EXEC_LINE =
  '{"kind":"process.exec","source":"kernel-monitor","at":"2024-10-09T14:04:11.500Z","monoNs":1000,"tgid":4242,"ppid":400,"uid":1000,"euid":1000,"comm":"sh","exe":"/tmp/x"}';

const HEALTH_LINE =
  '{"kind":"monitor.health","source":"kernel-monitor","at":"2026-10-09T18:04:12.000Z","monoNs":9001000000,"tgid":1421,"uid":0,"comm":"vigil-kernel-mo","droppedTotal":0,"hooks":["tracepoint/sched/sched_process_exec","tracepoint/sched/sched_process_fork"],"degraded":false}';

const DEGRADED_HEALTH_LINE =
  '{"kind":"monitor.health","source":"kernel-monitor","at":"2026-10-09T18:05:12.000Z","monoNs":9061000000,"tgid":1421,"uid":0,"comm":"vigil-kernel-mo","droppedTotal":1042,"hooks":["tracepoint/sched/sched_process_exec"],"degraded":true}';

// The hook PRs have not shipped writers for these kinds yet; the shapes are
// the spec's until they do.
const PRIVILEGE_LINE =
  '{"kind":"privilege.change","source":"kernel-monitor","at":"2026-10-09T18:04:11.512Z","monoNs":2000000000,"tgid":20544,"uid":1000,"comm":"sudo","fromUid":1000,"toUid":0,"caps":["cap_setuid","cap_sys_admin"]}';

const MODULE_LINE =
  '{"kind":"kernel.module","source":"kernel-monitor","at":"2026-10-09T18:04:13.000Z","monoNs":7000000000,"tgid":20700,"uid":0,"comm":"modprobe","module":"v4l2loopback","op":"load"}';

const at = (line: string): string => JSON.parse(line).at;

describe('parseOperationLine', () => {
  it('parses the daemon’s exec line into a process.exec event', () => {
    const parsed = parseOperationLine(EXEC_LINE);
    if (!parsed.ok) throw new Error(`fixture line did not parse: ${parsed.reason}`);
    const { event } = parsed;
    expect(event.kind).toBe('process.exec');
    expect(event.source).toBe('kernel-monitor');
    if (event.kind !== 'process.exec') return;
    expect(event.process).toEqual({ pid: 4242, ppid: 400, path: '/tmp/x', uid: 1000 });
    expect(event.ts).toBe(Date.parse(at(EXEC_LINE)));
    // The raw line keeps both uids: the event's process.uid is the euid.
    expect(event.raw).toMatchObject({ uid: 1000, euid: 1000, monoNs: 1000 });
    // Round-trips through the closed union.
    expect(SensorEvent.parse(event).kind).toBe('process.exec');
  });

  it('derives the same id from the same line, so a reread line dedupes', () => {
    const first = parseOperationLine(EXEC_LINE);
    const second = parseOperationLine(EXEC_LINE);
    if (!first.ok || !second.ok) throw new Error('fixture line did not parse');
    expect(first.event.id).toBe(second.event.id);
    expect(first.event.id.startsWith('kernel-monitor:')).toBe(true);
  });

  it('parses the health line, including the degraded shape', () => {
    for (const line of [HEALTH_LINE, DEGRADED_HEALTH_LINE]) {
      const parsed = parseOperationLine(line);
      if (!parsed.ok) throw new Error(`fixture line did not parse: ${parsed.reason}`);
      const { event } = parsed;
      // Health lines carry no ppid or euid — the daemon's writer omits them.
      expect(event).toMatchObject({
        kind: 'monitor.health',
        tgid: 1421,
        uid: 0,
        comm: 'vigil-kernel-mo',
        degraded: line === DEGRADED_HEALTH_LINE,
      });
      expect(event.kind === 'monitor.health' && event.droppedTotal).toBe(
        line === DEGRADED_HEALTH_LINE ? 1042 : 0,
      );
    }
  });

  it('parses the privilege-change and module lines the spec defines', () => {
    const priv = parseOperationLine(PRIVILEGE_LINE);
    if (!priv.ok) throw new Error(`fixture line did not parse: ${priv.reason}`);
    expect(priv.event).toMatchObject({
      kind: 'privilege.change',
      fromUid: 1000,
      toUid: 0,
      caps: ['cap_setuid', 'cap_sys_admin'],
    });
    const mod = parseOperationLine(MODULE_LINE);
    if (!mod.ok) throw new Error(`fixture line did not parse: ${mod.reason}`);
    expect(mod.event).toMatchObject({ kind: 'kernel.module', module: 'v4l2loopback', op: 'load' });
  });

  it('drops and explains every line the daemon cannot have written', () => {
    const bad: [string, string][] = [
      // The daemon's own malformed fixture: a truncated write.
      ['{"monoNs": 1000000, "tgid": 20510, "ppid": 1, "uid": 1000,', 'not JSON'],
      ['42', 'not an object'],
      ['null', 'not an object'],
      [
        '{"source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":1,"tgid":1,"uid":0,"comm":"x"}',
        'no kind',
      ],
      // Wrong type where the schema is fixed.
      [
        '{"kind":"process.exec","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":"not-a-number","tgid":20510,"ppid":1,"uid":1000,"euid":1000,"comm":"bash","exe":"/usr/bin/bash"}',
        'monoNs',
      ],
      // A field the writer never emits: an index from a newer build.
      [
        '{"unknownField":"x","kind":"process.exec","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":5,"tgid":1,"ppid":1,"uid":0,"euid":0,"comm":"x","exe":"/x"}',
        'unknownField',
      ],
      // Kinds this build has no line schema for: `file` and the network kinds
      // land with their hook PRs, and process.fork is reserved, never emitted.
      [
        '{"kind":"file","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":1,"tgid":1,"uid":0,"comm":"x"}',
        'unknown kind: file',
      ],
      [
        '{"kind":"process.fork","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":1,"tgid":1,"uid":0,"comm":"x"}',
        'unknown kind: process.fork',
      ],
    ];
    for (const [line, reason] of bad) {
      const parsed = parseOperationLine(line);
      expect(parsed.ok, line).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toContain(reason);
    }
  });

  it('anchors ts to the line’s clock, falling back to now when at is unusable', () => {
    const parsed = parseOperationLine(EXEC_LINE.replace(at(EXEC_LINE), 'not-a-date'));
    if (!parsed.ok) throw new Error('fixture line did not parse');
    expect(parsed.event.ts).toBeGreaterThan(0);
  });

  it('names the default index the daemon writes', () => {
    expect(KERNEL_MONITOR_INDEX).toBe('/var/lib/vigil/kernel-monitor/operations.jsonl');
  });
});

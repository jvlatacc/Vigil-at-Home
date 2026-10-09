// Turns lines of the kernel-monitor daemon's operations index into
// SensorEvents. The index is the daemon's own JSONL (kernel-monitor/src/index.c,
// PR #18): one flat JSON object per operation, written by the daemon, and read
// only here — the rsyslog file output is a separate copy for admins and
// collectors, and nothing tails both sources.
//
// Parsing is strict on purpose: the line schemas mirror the daemon's index
// writer field for field, and a line that does not match exactly (a truncated
// write, an index from a newer daemon) is dropped and counted by the hub
// rather than guessed into an event. The one permissive field is `exe`: the
// daemon derives it from comm today, and a hook PR will make it fully
// qualified, so any string is accepted.

import { z } from 'zod';
import type { EventOfKind, SensorEvent } from '@vigil/core';
import { lineEventId } from '../eventId.js';

/** Where the daemon writes its index (VIG_INDEX_DIR_DEFAULT / VIG_INDEX_BASE_NAME). */
export const KERNEL_MONITOR_DIR = '/var/lib/vigil/kernel-monitor';
export const KERNEL_MONITOR_INDEX = `${KERNEL_MONITOR_DIR}/operations.jsonl`;

/** The fields every index line carries, whatever the operation (the daemon's vig_event header). */
const lineBase = {
  source: z.literal('kernel-monitor'),
  /** ISO 8601 with milliseconds — the daemon's wall-clock anchor. */
  at: z.string(),
  /** The monotonic stamp the daemon orders by (bpf_ktime_get_ns). */
  monoNs: z.number().int(),
  tgid: z.number().int(),
  uid: z.number().int(),
  comm: z.string().max(16),
};

const execLine = z.strictObject({
  ...lineBase,
  kind: z.literal('process.exec'),
  ppid: z.number().int(),
  euid: z.number().int(),
  exe: z.string(),
});

const healthLine = z.strictObject({
  ...lineBase,
  kind: z.literal('monitor.health'),
  droppedTotal: z.number().int(),
  hooks: z.array(z.string()),
  degraded: z.boolean(),
});

// The daemon's hook PRs have not shipped writers for these two kinds yet;
// until they do, these shapes are the spec's (art_o5KMVz48), not observed.
const privilegeLine = z.strictObject({
  ...lineBase,
  kind: z.literal('privilege.change'),
  fromUid: z.number().int(),
  toUid: z.number().int(),
  caps: z.array(z.string()).optional(),
});

const moduleLine = z.strictObject({
  ...lineBase,
  kind: z.literal('kernel.module'),
  module: z.string(),
  op: z.enum(['load', 'unload']),
});

/** A parsed index line and the event it becomes, or why the line was dropped. */
export type OperationParse = { ok: true; event: SensorEvent } | { ok: false; reason: string };

function tsOf(at: string): number | undefined {
  const ts = Date.parse(at);
  return Number.isFinite(ts) ? ts : undefined;
}

/** The event id: the line's own time where it has one, then the line's hash — a reread line dedupes. */
function idOf(line: string, ts: number | undefined): string {
  return lineEventId('kernel-monitor:', line, ts);
}

function parseError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
}

export function parseOperationLine(line: string): OperationParse {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'not an object' };
  if (!('kind' in json) || typeof json.kind !== 'string') return { ok: false, reason: 'no kind' };

  switch (json.kind) {
    case 'process.exec': {
      const parsed = execLine.safeParse(json);
      if (!parsed.success) return { ok: false, reason: parseError(parsed.error) };
      const ts = tsOf(parsed.data.at);
      const event: EventOfKind<'process.exec'> = {
        id: idOf(line, ts),
        ts: ts ?? Date.now(),
        source: 'kernel-monitor',
        kind: 'process.exec',
        raw: parsed.data,
        process: {
          pid: parsed.data.tgid,
          ppid: parsed.data.ppid,
          path: parsed.data.exe,
          // What the task runs as (euid) is what rules ask about; the raw
          // line keeps the real uid beside it.
          uid: parsed.data.euid,
        },
      };
      return { ok: true, event };
    }
    case 'monitor.health': {
      const parsed = healthLine.safeParse(json);
      if (!parsed.success) return { ok: false, reason: parseError(parsed.error) };
      const ts = tsOf(parsed.data.at);
      const event: EventOfKind<'monitor.health'> = {
        ...parsed.data,
        id: idOf(line, ts),
        ts: ts ?? Date.now(),
        raw: parsed.data,
      };
      return { ok: true, event };
    }
    case 'privilege.change': {
      const parsed = privilegeLine.safeParse(json);
      if (!parsed.success) return { ok: false, reason: parseError(parsed.error) };
      const ts = tsOf(parsed.data.at);
      const event: EventOfKind<'privilege.change'> = {
        ...parsed.data,
        id: idOf(line, ts),
        ts: ts ?? Date.now(),
        raw: parsed.data,
      };
      return { ok: true, event };
    }
    case 'kernel.module': {
      const parsed = moduleLine.safeParse(json);
      if (!parsed.success) return { ok: false, reason: parseError(parsed.error) };
      const ts = tsOf(parsed.data.at);
      const event: EventOfKind<'kernel.module'> = {
        ...parsed.data,
        id: idOf(line, ts),
        ts: ts ?? Date.now(),
        raw: parsed.data,
      };
      return { ok: true, event };
    }
    default:
      // A kind this build has no line schema for: a daemon newer than this
      // build, or one of the hook PRs' kinds. Dropped and counted upstream.
      return { ok: false, reason: `unknown kind: ${json.kind}` };
  }
}

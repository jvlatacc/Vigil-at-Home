// The per-connection limits on the helper's socket: line caps, the request
// budget, and the idle timeout. These tests run against a minimal executor
// stand-in — the limits live in the server, and the real Executor is covered
// by the other suites.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from './executor.js';
import { HelperServer, type ServerLimits } from './server.js';

let root: string;

// The server only ever hands commands to the executor; the limits below act
// before it runs, so a stub is all these tests need.
const stubExecutor = { execute: async () => ({ kind: 'ok' as const, result: {} }) };
const executor = stubExecutor as unknown as Executor;

function limits(): ServerLimits {
  return {
    maxLine: 1024 * 1024,
    maxSyncLine: 8 * 1024 * 1024,
    requestBurst: 240,
    requestRefillPerSecond: 20,
    idleTimeoutMs: 5 * 60 * 1000,
  };
}

async function start(name: string, over: Partial<ServerLimits>): Promise<HelperServer> {
  const server = new HelperServer({
    socketPath: join(root, `${name}.sock`),
    executor,
    limits: { ...limits(), ...over },
  });
  await server.listen();
  return server;
}

function dial(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    sock.setEncoding('utf8');
    sock.on('connect', () => resolve(sock));
    sock.on('error', reject);
  });
}

/** Collects the connection's reply lines, one JSON response each. */
function reader(sock: Socket) {
  let buf = '';
  const waiting: (() => void)[] = [];
  const lines: string[] = [];
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.shift()?.();
    }
  });
  return {
    lines,
    next(): Promise<string> {
      if (lines.length) return Promise.resolve(lines.shift()!);
      return new Promise((resolve) => waiting.push(() => resolve(lines.shift()!)));
    },
  };
}

function closed(sock: Socket): Promise<void> {
  return new Promise((resolve) => sock.on('close', () => resolve()));
}

/** One helper.status request line with the given id. */
const status = (id: string) => `{"id":"${id}","command":{"kind":"helper.status"}}\n`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vigil-server-limits-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the helper socket limits', () => {
  it('answers normal traffic while the limits are in force', async () => {
    const server = await start('normal', { requestBurst: 3, requestRefillPerSecond: 0 });
    const sock = await dial(join(root, 'normal.sock'));
    const replies = reader(sock);
    sock.write(status('a') + status('b') + status('c'));
    for (const id of ['a', 'b', 'c']) {
      expect(JSON.parse(await replies.next())).toMatchObject({ id, ok: true });
    }
    sock.destroy();
    await server.close();
  });

  it('answers a sync-sized line above the usual line limit', async () => {
    const server = await start('sync-tier', { maxLine: 4096, maxSyncLine: 4 * 1024 * 1024 });
    const sock = await dial(join(root, 'sync-tier.sock'));
    const replies = reader(sock);
    // A sync-prefixed line may use its own cap, not the regular one.
    const big = {
      id: 'big',
      command: {
        kind: 'detection.sync',
        rules: [],
        appRules: [],
        exceptions: [],
        lists: {},
        // Valid entries (≤255 chars each) that pad the line past maxLine.
        entries: { pad: Array.from({ length: 40 }, () => 'x'.repeat(200)) },
      },
    };
    sock.write(JSON.stringify(big) + '\n');
    expect(JSON.parse(await replies.next())).toMatchObject({ id: 'big', ok: true });
    sock.destroy();
    await server.close();
  });

  it('rejects an oversized line cleanly and closes the connection', async () => {
    const server = await start('oversize', { maxSyncLine: 4096 });
    const sock = await dial(join(root, 'oversize.sock'));
    const replies = reader(sock);
    const end = closed(sock);
    // Starts as a sync, so the sync cap is the one that refuses it.
    const big = {
      id: 'too-big',
      command: {
        kind: 'detection.sync',
        rules: [],
        appRules: [],
        exceptions: [],
        lists: {},
        // Valid entries (≤255 chars each) that pad the line past the sync cap.
        entries: { pad: Array.from({ length: 40 }, () => 'x'.repeat(200)) },
      },
    };
    sock.write(JSON.stringify(big) + '\n');
    // The answer says why, with the line's own id, before the connection ends.
    expect(JSON.parse(await replies.next())).toEqual({
      id: 'too-big',
      ok: false,
      error: 'request too long',
      code: 'invalid',
    });
    await end;
    // A fresh connection still works: only the offending one is cut.
    const next = await dial(join(root, 'oversize.sock'));
    const again = reader(next);
    next.write(status('after'));
    expect(JSON.parse(await again.next())).toMatchObject({ id: 'after', ok: true });
    next.destroy();
    await server.close();
  });

  it('closes a connection that spends its request budget, and keeps serving', async () => {
    const server = await start('budget', {
      requestBurst: 3,
      requestRefillPerSecond: 0,
    });
    const sock = await dial(join(root, 'budget.sock'));
    const replies = reader(sock);
    const end = closed(sock);
    // Three requests are answered; the fourth spends the budget and is refused.
    // A pipelined batch's answers arrive in completion order, so assert by id.
    sock.write(status('1') + status('2') + status('3') + status('4'));
    const seen: { id: string; ok: boolean }[] = [];
    for (let i = 0; i < 4; i++) seen.push(JSON.parse(await replies.next()));
    expect(seen.filter((r) => r.ok)).toHaveLength(3);
    expect(seen.find((r) => r.id === '4')).toMatchObject({
      id: '4',
      ok: false,
      error: 'too many requests',
      code: 'refused',
    });
    await end;
    // The server itself is unharmed: a new connection gets its full budget.
    const next = await dial(join(root, 'budget.sock'));
    const again = reader(next);
    next.write(status('fresh'));
    expect(JSON.parse(await again.next())).toMatchObject({ id: 'fresh', ok: true });
    next.destroy();
    await server.close();
  });

  it('cuts off an idle connection but never a subscriber', async () => {
    const server = await start('idle', { idleTimeoutMs: 150 });
    const quiet = await dial(join(root, 'idle.sock'));
    const quietEnd = closed(quiet);
    await quietEnd;
    expect(quiet.destroyed).toBe(true);

    // A subscriber is exempt: the helper writes to it unasked, so it is not idle.
    const listener = await dial(join(root, 'idle.sock'));
    const replies = reader(listener);
    listener.write('{"id":"s","command":{"kind":"events.subscribe"}}\n');
    expect(JSON.parse(await replies.next())).toMatchObject({ id: 's', ok: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(listener.destroyed).toBe(false);
    // It still receives what it subscribed to.
    server.publish({
      id: 'e1',
      at: Date.now(),
      kind: 'process.exec',
      path: '/bin/true',
    } as never);
    expect(JSON.parse(await replies.next())).toMatchObject({ type: 'event' });
    listener.destroy();
    await server.close();
  });
});

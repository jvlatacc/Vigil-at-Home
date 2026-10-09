// The helper's local socket. Newline-delimited JSON: one HelperRequest per
// line in, one HelperResponse per line out, plus {"type":"event"} lines on
// connections that subscribed to sensor events.
//
// The socket file is owned by the logged-in user with mode 0600, so other
// accounts cannot talk to the helper. Anything running as that user can,
// which is why releasing actions need the admin password — and why the
// limits below bound what any single connection can make the root process
// parse or hold: line sizes are capped, requests are budgeted per
// connection, and idle connections are cut.

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, rmSync } from 'node:fs';
import type { SensorEvent } from '@vigil/sensors';
import { parseRequest, type ErrorCode, type HelperResponse } from './protocol.js';
import type { Executor } from './executor.js';
import type { HelperRan } from './fastpath.js';
import { ActionError } from './commands/errors.js';

// Large enough for any command but detection.sync; still bounded.
const MAX_LINE = 1024 * 1024;
// detection.sync carries the app's rules, exceptions and app rules — not
// list contents: the app puts lists on the helper in 1,000-entry parts
// first (each part measures at most about 258 KB, well under MAX_LINE).
// A rule set built from the whole builtin catalog measured 4,312,723 bytes
// serialized for 64 copies of it, so 8 MiB leaves room while keeping a
// hostile oversized sync from ever reaching JSON.parse.
const MAX_SYNC_LINE = 8 * 1024 * 1024;
// Requests a connection may make before it is cut off. A feed refresh
// sends up to 200 list parts plus the sync on one connection, so the
// burst clears 240; the refill keeps normal use flowing while stopping a
// same-user process from pinning the root parser with a stream of lines.
const REQUEST_BURST = 240;
const REQUEST_REFILL_PER_SECOND = 20;
// A connection that asks nothing for five minutes is cut; event
// subscribers are exempt, since the helper writes to them unasked.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SYNC_PREFIX = /^\{"id":"[^"\\]{1,200}","command":\{"kind":"detection\.sync"/;
const ID_PREFIX = /^\{"id":"([^"\\]{1,200})"/;
const RECENT_EVENTS = 2000;

/** Per-connection limits; every field has a default, so tests pass only what they exercise. */
export interface ServerLimits {
  /** Cap for a non-sync request line. */
  maxLine: number;
  /** Cap for a line that starts as a detection.sync. */
  maxSyncLine: number;
  /** Requests a connection may burst before it is cut off. */
  requestBurst: number;
  /** How fast the burst budget refills, per second. */
  requestRefillPerSecond: number;
  /** How long a connection may sit silent before it is cut. */
  idleTimeoutMs: number;
}

export interface HelperServerOptions {
  socketPath: string;
  executor: Executor;
  /** Owner for the socket file (the console user). Skipped when undefined. */
  ownerUid?: number | undefined;
  log?: ((msg: string) => void) | undefined;
  /** Overrides for the per-connection limits above. */
  limits?: Partial<ServerLimits>;
}

export class HelperServer {
  private server: Server | undefined;
  private readonly subscribers = new Set<Socket>();
  private readonly connections = new Set<Socket>();
  private readonly recent: string[] = [];
  private readonly recentIds: string[] = [];
  private readonly limits: ServerLimits;

  constructor(private readonly opts: HelperServerOptions) {
    this.limits = {
      maxLine: MAX_LINE,
      maxSyncLine: MAX_SYNC_LINE,
      requestBurst: REQUEST_BURST,
      requestRefillPerSecond: REQUEST_REFILL_PER_SECOND,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      ...opts.limits,
    };
  }

  async listen(): Promise<void> {
    rmSync(this.opts.socketPath, { force: true });
    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.socketPath, () => resolve());
    });
    chmodSync(this.opts.socketPath, 0o600);
    if (this.opts.ownerUid !== undefined) chownSync(this.opts.socketPath, this.opts.ownerUid, 0);
  }

  async close(): Promise<void> {
    for (const s of this.connections) s.destroy();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    rmSync(this.opts.socketPath, { force: true });
  }

  /**
   * Fan a sensor event out to subscribed connections and keep it for late
   * subscribers, with whatever the helper's own rules already did about it.
   */
  publish(event: SensorEvent, ran: HelperRan[] = []): void {
    const line =
      JSON.stringify(ran.length ? { type: 'event', event, ran } : { type: 'event', event }) + '\n';
    this.recent.push(line);
    this.recentIds.push(event.id);
    if (this.recent.length > RECENT_EVENTS) {
      this.recent.shift();
      this.recentIds.shift();
    }
    for (const s of this.subscribers) {
      // A subscriber that stops reading must not make the helper buffer forever.
      if (s.writableLength > 8 * 1024 * 1024) s.destroy();
      else s.write(line);
    }
  }

  private onConnection(sock: Socket): void {
    let buf = '';
    let budget = this.limits.requestBurst;
    let chargedAt = Date.now();
    // Requests the executor is still running. A connection the server is
    // cutting closes only after every answer it owes has flushed, so a
    // refusal cannot swallow the answers to lines accepted in the same batch.
    let inFlight = 0;
    let closing = false;
    let closeWhenIdle: (() => void) | undefined;
    this.connections.add(sock);
    const idle = setTimeout(() => {
      if (this.subscribers.has(sock)) return;
      this.opts.log?.('idle connection cut off');
      sock.destroy();
    }, this.limits.idleTimeoutMs);
    // Counts one request; false when the connection's budget is spent.
    const charge = (): boolean => {
      const now = Date.now();
      budget = Math.min(
        this.limits.requestBurst,
        budget + ((now - chargedAt) / 1000) * this.limits.requestRefillPerSecond,
      );
      chargedAt = now;
      if (budget < 1) return false;
      budget -= 1;
      return true;
    };
    const run = (line: string): void => {
      inFlight++;
      void this.onLine(sock, line).finally(() => {
        inFlight--;
        if (inFlight === 0 && closeWhenIdle) {
          const cut = closeWhenIdle;
          closeWhenIdle = undefined;
          cut();
        }
      });
    };
    const cut = (): void => {
      closing = true;
      // end() flushes the reply; destroying in its callback also stops the
      // read side, so the connection can't keep feeding the buffer after.
      sock.end(() => sock.destroy());
    };
    const refuseAndCut = (line: string, error: string, code: ErrorCode): void => {
      if (closing) return;
      this.refuse(sock, line, error, code);
      if (inFlight > 0) closeWhenIdle = cut;
      else cut();
    };
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      if (closing) return;
      idle.refresh();
      buf += chunk;
      // Only the new chunk can end the line, so a long sync isn't rescanned per chunk.
      if (!chunk.includes('\n')) {
        if (this.lineOverLimit(buf)) refuseAndCut(buf, 'request too long', 'invalid');
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (this.lineOverLimit(line)) {
          refuseAndCut(line, 'request too long', 'invalid');
          return;
        }
        if (!charge()) {
          this.opts.log?.('request budget exhausted');
          refuseAndCut(line, 'too many requests', 'refused');
          return;
        }
        run(line);
      }
    });
    const forget = () => {
      clearTimeout(idle);
      this.subscribers.delete(sock);
      this.connections.delete(sock);
    };
    sock.on('close', forget);
    sock.on('error', forget);
  }

  /**
   * The limit a line exceeds, if any. The prefix test reads only the line's
   * start; JSON lets a later duplicate "kind" win, so the parsed kind is
   * checked again once the line parses (onLine).
   */
  private lineOverLimit(line: string): boolean {
    const max = SYNC_PREFIX.test(line.slice(0, 400))
      ? this.limits.maxSyncLine
      : this.limits.maxLine;
    return line.length > max;
  }

  /** Answer a bad line — a real client learns why; a hostile one gains one short response. */
  private refuse(sock: Socket, line: string, error: string, code: ErrorCode = 'invalid'): void {
    const id = ID_PREFIX.exec(line.slice(0, 400))?.[1] ?? '';
    this.send(sock, { id, ok: false, error, code });
  }

  private send(sock: Socket, resp: HelperResponse): void {
    if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(resp) + '\n');
  }

  private async onLine(sock: Socket, line: string): Promise<void> {
    const req = parseRequest(line);
    if ('error' in req) {
      this.send(sock, { id: req.id ?? '', ok: false, error: req.error, code: 'invalid' });
      return;
    }
    // The size check above reads only the line's start; JSON lets a later
    // duplicate "kind" win, so check the parsed kind too.
    if (line.length > this.limits.maxLine && req.command.kind !== 'detection.sync') {
      this.send(sock, { id: req.id, ok: false, error: 'request too long', code: 'invalid' });
      return;
    }
    if (req.command.kind === 'events.subscribe') {
      const since = req.command.since;
      const start = since ? this.recentIds.indexOf(since) + 1 : this.recent.length;
      this.send(sock, { id: req.id, ok: true, result: { subscribed: true } });
      for (const line of this.recent.slice(start)) sock.write(line);
      this.subscribers.add(sock);
      return;
    }
    try {
      const out = await this.opts.executor.execute(req.command, req.approval);
      if (out.kind === 'needs_approval') {
        this.send(sock, {
          id: req.id,
          ok: false,
          needsApproval: true,
          nonce: out.nonce,
          prompt: out.prompt,
        });
      } else {
        this.send(sock, { id: req.id, ok: true, result: out.result });
      }
    } catch (err) {
      const code = err instanceof ActionError ? err.code : 'failed';
      if (!(err instanceof ActionError))
        this.opts.log?.(`${req.command.kind} failed: ${(err as Error).stack}`);
      this.send(sock, { id: req.id, ok: false, error: (err as Error).message, code });
    }
  }
}

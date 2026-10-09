import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { RelayStore } from './store.js';
import { IngestRequest, type IngestAck } from './wire.js';

/** POST /v1/ingest is the only write face. */
export const INGEST_PATH = '/v1/ingest';

/**
 * 500 records can't legitimately exceed this even at the local caps (64 KB
 * bodies), so a batch that decompresses larger is being smuggled in.
 */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface IngestContext {
  store: RelayStore;
  maxBodyBytes: number;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Handles one ingest POST: read, validate, store, ack. */
export async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: IngestContext,
): Promise<void> {
  const body = await readBody(req, ctx.maxBodyBytes);
  if (body === 'too_large') {
    rejectBodyTooLarge(req, res);
    return;
  }
  if (body === 'aborted') {
    req.socket.destroy();
    return;
  }
  let text: string;
  try {
    text = decodeBody(body, req.headers['content-encoding']);
  } catch {
    sendJson(res, 400, { error: 'invalid_encoding' });
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  const parsed = IngestRequest.safeParse(parsedJson);
  if (!parsed.success) {
    // The zod path goes back so a misconfigured shipper can point at the field.
    sendJson(res, 400, {
      error: 'invalid_ingest',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
    return;
  }

  const outcome = ctx.store.applyBatch(parsed.data.deviceId, parsed.data.records, Date.now());
  const ack: IngestAck = {
    v: 1,
    accepted: outcome.accepted,
    duplicates: outcome.duplicates,
    ackedCursor: outcome.cursor,
  };
  // A pure replay (nothing new stored) answers 202: the batch is accepted,
  // and the duplicates count tells the shipper it can move on.
  sendJson(res, outcome.accepted > 0 ? 200 : 202, ack);
}

function decodeBody(body: Buffer, encoding: string | undefined): string {
  if (encoding === undefined || encoding === 'identity') return body.toString('utf8');
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
  }
  throw new Error(`unsupported content-encoding: ${encoding}`);
}

type BodyRead = Buffer | 'too_large' | 'aborted';

/**
 * Refuses an oversized body: the reply is flushed before the socket is
 * closed, so a client that is still uploading reads the 413 instead of a
 * connection reset. End (not destroy): a reset can eat the response bytes.
 */
function rejectBodyTooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: 'body_too_large' }), () => {
    req.socket.end();
  });
}

/**
 * Reads the whole body, refusing anything over `maxBytes` and any client
 * that stalls: a slow body is destroyed, never buffered.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      req.destroy();
      done('aborted');
    }, 5_000);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Stop reading: TCP backpressure holds the client while the 413 goes out.
        req.pause();
        done('too_large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', () => done('aborted'));
  });
}

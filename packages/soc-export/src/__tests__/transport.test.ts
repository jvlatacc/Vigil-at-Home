import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { alertToFinding } from '../mapping.js';
import { TransportError, VStrikeClient } from '../transport.js';
import type { VStrikePushRequest } from '../types.js';
import { makeAlert, makeContext } from './fixtures.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface CapturedRequest {
  method: string;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

type Respond = (request: CapturedRequest, response: ServerResponse) => void;

function startReceiver(respond: Respond): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      respond(captured, response);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function pushResponse(batchId: string): unknown {
  return {
    batch_id: batchId,
    received: 2,
    created: 2,
    updated: 0,
    failed: 0,
    results: [
      { finding_id: 'vah-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', status: 'created' },
      { finding_id: 'vah-bb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', status: 'created' },
    ],
    case_ids: ['case-77'],
  };
}

const receivers: Array<() => Promise<void>> = [];
function trackClose(close: () => Promise<void>): void {
  receivers.push(close);
}
afterEach(async () => {
  for (const close of receivers.splice(0)) await close();
});

describe('VStrikeClient push', () => {
  it('posts the VS-4 contract and reads the batch response', async () => {
    const receiver = await startReceiver((request, response) => {
      const parsed = JSON.parse(request.body) as VStrikePushRequest;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(pushResponse(parsed.batch_id)));
    });
    trackClose(receiver.close);

    const client = new VStrikeClient({
      baseUrl: receiver.url,
      apiKey: 'secret-key-1',
      batchId: () => 'batch-1',
    });
    const response = await client.pushFindings([
      alertToFinding(makeAlert(), makeContext()),
      alertToFinding(
        makeAlert({ id: 'bb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', severity: 'critical' }),
        makeContext(),
      ),
    ]);

    const push = receiver.requests[0];
    expect(push?.method).toBe('POST');
    expect(push?.url).toBe('/api/integrations/vstrike/findings');
    expect(push?.headers.authorization).toBe('Bearer secret-key-1');
    expect(push?.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(push?.body ?? '') as VStrikePushRequest;
    expect(sent.batch_id).toBe('batch-1');
    expect(sent.source).toBe('vigil-at-home');
    expect(sent.auto_cluster_cases).toBe(true);
    expect(sent.findings).toHaveLength(2);
    for (const finding of sent.findings) {
      expect(typeof finding.finding_id === 'string' && finding.finding_id.startsWith('vah-')).toBe(
        true,
      );
      expect(typeof finding.timestamp).toBe('string');
      expect(Number.isFinite(finding.anomaly_score)).toBe(true);
      expect(finding.vstrike_enrichment?.asset_id).toBe('vah-host-0123456789abcdef');
    }

    expect(response.batch_id).toBe('batch-1');
    expect(response.created).toBe(2);
    expect(response.failed).toBe(0);
    expect(response.case_ids).toEqual(['case-77']);
    expect(response.results[0]).toMatchObject({
      finding_id: 'vah-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      status: 'created',
    });
  });

  it('treats a 5xx as retryable', async () => {
    const receiver = await startReceiver((request, response) => {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('down');
    });
    trackClose(receiver.close);
    const client = new VStrikeClient({ baseUrl: receiver.url, apiKey: 'k' });
    await expect(
      client.pushFindings([alertToFinding(makeAlert(), makeContext())]),
    ).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
  });

  it('treats a 4xx as final', async () => {
    const receiver = await startReceiver((request, response) => {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('unauthorized');
    });
    trackClose(receiver.close);
    const client = new VStrikeClient({ baseUrl: receiver.url, apiKey: 'k' });
    await expect(
      client.pushFindings([alertToFinding(makeAlert(), makeContext())]),
    ).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
  });

  it('refuses a malformed response body', async () => {
    const receiver = await startReceiver((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('nope');
    });
    trackClose(receiver.close);
    const client = new VStrikeClient({ baseUrl: receiver.url, apiKey: 'k' });
    await expect(
      client.pushFindings([alertToFinding(makeAlert(), makeContext())]),
    ).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('refuses a well-formed JSON body with the wrong shape', async () => {
    const receiver = await startReceiver((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    trackClose(receiver.close);
    const client = new VStrikeClient({ baseUrl: receiver.url, apiKey: 'k' });
    await expect(
      client.pushFindings([alertToFinding(makeAlert(), makeContext())]),
    ).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('sends resolutions as PATCH on the frozen v1 endpoint', async () => {
    const receiver = await startReceiver((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, finding: {}, updated_fields: ['status'] }));
    });
    trackClose(receiver.close);
    const client = new VStrikeClient({ baseUrl: receiver.url, apiKey: 'k' });
    const response = await client.patchFinding('vah-a1b2c3d4', { status: 'resolved' });

    const patch = receiver.requests[0];
    expect(patch?.method).toBe('PATCH');
    expect(patch?.url).toBe('/api/v1/findings/vah-a1b2c3d4');
    expect(JSON.parse(patch?.body ?? '')).toEqual({ status: 'resolved' });
    expect(response).toEqual({ success: true, finding: {}, updated_fields: ['status'] });
  });

  it('refuses a plaintext remote endpoint before any request is built', async () => {
    await tick();
    expect(() => new VStrikeClient({ baseUrl: 'http://soc.example.com', apiKey: 'k' })).toThrow(
      TransportError,
    );
    expect(() => new VStrikeClient({ baseUrl: 'ftp://soc.example.com', apiKey: 'k' })).toThrow(
      TransportError,
    );
    expect(
      () => new VStrikeClient({ baseUrl: 'https://soc.example.com', apiKey: 'k' }),
    ).not.toThrow();
    expect(
      () => new VStrikeClient({ baseUrl: 'http://localhost:6987', apiKey: 'k' }),
    ).not.toThrow();
  });
});

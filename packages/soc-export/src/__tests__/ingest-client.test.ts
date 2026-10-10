import { describe, expect, it } from 'vitest';
import { IngestClient, parseJobSnapshot } from '../ingest-client.js';
import { TransportError } from '../transport.js';
import { FakeFetch, jsonResponse, textResponse } from './fake-fetch.js';

const BASE = 'http://127.0.0.1:6987';

const JOB_ID = 'ing-abc123def456';

function jobStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    filename: 'vigil-alerts.jsonl',
    format: 'jsonl',
    data_type: 'finding',
    status: 'running',
    determinate: false,
    processed: 0,
    total: 0,
    created_at: '2026-10-09T12:00:00Z',
    finished_at: null,
    message: '',
    error: null,
    stats: {},
    ...overrides,
  };
}

const SUCCESS_STATS = {
  findings_total: 2,
  findings_imported: 2,
  findings_skipped: 0,
  findings_errors: 0,
  cases_total: 0,
  cases_imported: 0,
  cases_skipped: 0,
  cases_errors: 0,
};

function client(fake: FakeFetch, overrides: Record<string, unknown> = {}): IngestClient {
  return new IngestClient({
    baseUrl: BASE,
    apiKey: 'test-key',
    fetch: fake.fetch,
    pollIntervalMs: 1,
    pollTimeoutMs: 5_000,
    ...overrides,
  });
}

describe('IngestClient.uploadFindings', () => {
  it('posts the multipart contract and polls the job to the stats', async () => {
    const fake = new FakeFetch(
      () => jsonResponse(202, jobStatus()),
      () => jsonResponse(200, jobStatus({ status: 'running' })),
      () =>
        jsonResponse(
          200,
          jobStatus({ status: 'succeeded', message: 'Imported 2 findings', stats: SUCCESS_STATS }),
        ),
    );
    const jsonl = '{"finding_id":"vah-a1"}\n{"finding_id":"vah-a2"}\n';
    const job = await client(fake).uploadFindings(jsonl);

    expect(job.job_id).toBe(JOB_ID);
    expect(job.status).toBe('succeeded');
    expect(job.message).toBe('Imported 2 findings');
    expect(job.stats).toEqual(SUCCESS_STATS);

    // The upload: bearer key, multipart fields, the JSONL as a named file.
    expect(fake.calls[0]?.url).toBe(`${BASE}/api/ingest/upload`);
    expect(fake.calls[0]?.init?.method).toBe('POST');
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(fake.formField('data_type')).toBe('finding');
    expect(fake.formField('format')).toBe('jsonl');
    const file = fake.formField('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('vigil-alerts.jsonl');
    expect(await (file as File).text()).toBe(jsonl);

    // The polls: same bearer key, the documented jobs path.
    expect(fake.calls[1]?.url).toBe(`${BASE}/api/ingest/jobs/${JOB_ID}`);
    expect(fake.calls[1]?.init?.method).toBe('GET');
  });

  it('surfaces a failed job as a non-retryable error', async () => {
    const fake = new FakeFetch(
      () => jsonResponse(202, jobStatus()),
      () => jsonResponse(200, jobStatus({ status: 'failed', error: 'No data imported' })),
    );
    const promise = client(fake).uploadFindings('{}\n');
    await expect(promise).rejects.toThrow(TransportError);
    await expect(promise).rejects.toThrow(/failed: No data imported/);
    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).retryable).toBe(false);
  });

  it('names a 409 conflict — another ingest is already running', async () => {
    const fake = new FakeFetch(() =>
      jsonResponse(409, { detail: "Already ingesting 'other.jsonl'. Wait for it to finish." }),
    );
    const promise = client(fake).uploadFindings('{}\n');
    await expect(promise).rejects.toThrow(/409/);
    const error = await promise.catch((cause: unknown) => cause);
    expect((error as TransportError).retryable).toBe(true);
  });

  it('gives up when the job never reaches a terminal state', async () => {
    const running = Array.from({ length: 60 }, () => () => jsonResponse(200, jobStatus()));
    const fake = new FakeFetch(() => jsonResponse(202, jobStatus()), ...running);
    const promise = client(fake, { pollTimeoutMs: 20 }).uploadFindings('{}\n');
    await expect(promise).rejects.toThrow(/did not finish within 20ms/);
    const error = await promise.catch((cause: unknown) => cause);
    expect((error as TransportError).retryable).toBe(true);
  });

  it('refuses a plaintext remote endpoint before any request is built', () => {
    const fake = new FakeFetch();
    expect(
      () =>
        new IngestClient({
          baseUrl: 'http://soc.example.com',
          apiKey: 'k',
          fetch: fake.fetch,
        }),
    ).toThrow(TransportError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('IngestClient.uploadCase', () => {
  it('uploads the case as data_type=case in JSON format', async () => {
    const fake = new FakeFetch(
      () => jsonResponse(202, jobStatus()),
      () =>
        jsonResponse(
          200,
          jobStatus({
            status: 'succeeded',
            message: 'Imported 1 cases',
            stats: { ...SUCCESS_STATS, cases_total: 1, cases_imported: 1 },
          }),
        ),
    );
    const job = await client(fake).uploadCase('{"case_id":"case-demo-1"}');
    expect(job.stats['cases_imported']).toBe(1);
    expect(fake.formField('data_type')).toBe('case');
    expect(fake.formField('format')).toBe('json');
    const file = fake.formField('file');
    expect((file as File).name).toBe('vigil-case.json');
  });
});

describe('parseJobSnapshot', () => {
  it('rejects a snapshot without a job id', () => {
    expect(() => parseJobSnapshot({ status: 'running' })).toThrow(TransportError);
  });

  it('keeps numeric stats and drops the rest', () => {
    const job = parseJobSnapshot(
      jobStatus({ stats: { findings_imported: 3, bogus: 'x' }, message: 'hi' }),
    );
    expect(job.stats).toEqual({ findings_imported: 3 });
    expect(job.message).toBe('hi');
  });

  it('rejects a non-JSON body outright', async () => {
    const fake = new FakeFetch(() => textResponse(202, '<html>not json</html>'));
    await expect(client(fake).uploadFindings('{}\n')).rejects.toThrow(/Unreadable JSON/);
  });
});

import { isSafeBaseUrl } from './safe-url.js';
import { isRecord, readJson, TransportError } from './transport.js';

/**
 * The ingest router's background-job snapshot (`IngestionJobStatus`, fetched
 * 2026-10-09): an upload returns 202 with one of these, and the same shape
 * polls at GET /api/ingest/jobs/{id} until the job reaches a terminal state.
 * `status` is `running`, `succeeded`, or `failed`; JSONL uploads are not
 * `determinate`, so `total` stays 0 while the job runs — progress is the
 * terminal status, not the counters.
 */
export interface IngestJobSnapshot {
  readonly job_id: string;
  readonly filename: string;
  readonly format: string;
  readonly data_type: string;
  readonly status: string;
  readonly determinate: boolean;
  readonly processed: number;
  readonly total: number;
  readonly message: string;
  readonly error?: string;
  readonly stats: Readonly<Record<string, number>>;
}

export interface IngestClientOptions {
  /** Vigil SOC base URL — https, or http for localhost only. */
  baseUrl: string;
  /** Bearer key for the SOC API. */
  apiKey: string;
  /** Injectable for tests; the platform fetch otherwise. */
  fetch?: typeof fetch;
  /** Per-request HTTP timeout. */
  timeoutMs?: number;
  /** How long to wait between job polls. */
  pollIntervalMs?: number;
  /** How long a background job may run before the client gives up. */
  pollTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;
const UPLOAD_PATH = '/api/ingest/upload';
const JOB_PATH = '/api/ingest/jobs';

function malformedJob(): TransportError {
  return new TransportError('Malformed ingestion-job response from Vigil SOC.', {
    retryable: false,
  });
}

export function parseJobSnapshot(body: unknown): IngestJobSnapshot {
  if (!isRecord(body) || typeof body['job_id'] !== 'string') throw malformedJob();
  const stats: Record<string, number> = {};
  const rawStats = body['stats'];
  if (isRecord(rawStats)) {
    for (const [key, value] of Object.entries(rawStats)) {
      if (typeof value === 'number') stats[key] = value;
    }
  }
  return {
    job_id: body['job_id'],
    status: typeof body['status'] === 'string' ? body['status'] : 'unknown',
    filename: typeof body['filename'] === 'string' ? body['filename'] : '',
    format: typeof body['format'] === 'string' ? body['format'] : '',
    data_type: typeof body['data_type'] === 'string' ? body['data_type'] : '',
    determinate: body['determinate'] === true,
    processed: typeof body['processed'] === 'number' ? body['processed'] : 0,
    total: typeof body['total'] === 'number' ? body['total'] : 0,
    message: typeof body['message'] === 'string' ? body['message'] : '',
    ...(typeof body['error'] === 'string' ? { error: body['error'] } : {}),
    stats,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The bulk path's transport: multipart uploads to /api/ingest, which queue a
 * background job (one at a time on the SOC — a second concurrent upload is a
 * 409), then poll that job for the IngestionStats-style counters. A zero-row
 * file makes the job fail with "No data imported" upstream, so callers that
 * might have nothing should check first and skip the request entirely.
 */
export class IngestClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(options: IngestClientOptions) {
    // Same rule as every AI provider: the key goes only to https, or localhost.
    if (!isSafeBaseUrl(options.baseUrl)) {
      throw new TransportError('The Vigil SOC address must use https, or http only for localhost.', {
        retryable: false,
      });
    }
    this.base = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  /** Upload a findings JSONL window and wait for the ingest job to finish. */
  async uploadFindings(jsonl: string): Promise<IngestJobSnapshot> {
    return this.upload(jsonl, 'vigil-alerts.jsonl', 'finding', 'jsonl');
  }

  /** Upload a single case document with its finding links and wait it out. */
  async uploadCase(caseJson: string): Promise<IngestJobSnapshot> {
    return this.upload(caseJson, 'vigil-case.json', 'case', 'json');
  }

  private async upload(
    data: string,
    filename: string,
    dataType: 'finding' | 'case',
    format: string,
  ): Promise<IngestJobSnapshot> {
    // `format` is sent explicitly even though the suffix would also match:
    // an explicit parameter beats extension detection.
    const form = new FormData();
    form.append('file', new Blob([data]), filename);
    form.append('data_type', dataType);
    form.append('format', format);
    const started = await this.sendForm('POST', UPLOAD_PATH, form);
    const job = parseJobSnapshot(await readJson(started));
    return this.pollJob(job.job_id);
  }

  /**
   * Poll GET /api/ingest/jobs/{id} until the job reaches `succeeded` or
   * `failed`. Unknown status values keep polling — the SOC may add states
   * without this client knowing them.
   */
  async pollJob(jobId: string): Promise<IngestJobSnapshot> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const path = `${JOB_PATH}/${encodeURIComponent(jobId)}`;
      const response = await this.send('GET', path);
      const job = parseJobSnapshot(await readJson(response));
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed') {
        throw new TransportError(`Ingestion job ${jobId} failed: ${job.error || job.message}`, {
          retryable: false,
        });
      }
      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new TransportError(
          `Ingestion job ${jobId} did not finish within ${this.pollTimeoutMs}ms (last status: ${job.status}).`,
          { retryable: true },
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async send(method: 'GET', path: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new TransportError(`Vigil SOC request failed: ${method} ${path}`, {
        retryable: true,
        cause,
      });
    }
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 200);
    throw new TransportError(
      `Vigil SOC returned HTTP ${response.status} for ${method} ${path}${detail ? `: ${detail}` : ''}`,
      { status: response.status, retryable: response.status >= 500 },
    );
  }

  private async sendForm(method: 'POST', path: string, form: FormData): Promise<Response> {
    let response: Response;
    try {
      // No content-type header here: fetch builds the multipart boundary.
      response = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new TransportError(`Vigil SOC request failed: ${method} ${path}`, {
        retryable: true,
        cause,
      });
    }
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 200);
    throw new TransportError(
      `Vigil SOC returned HTTP ${response.status} for ${method} ${path}${detail ? `: ${detail}` : ''}`,
      // 409: another ingest is already running on the SOC — waiting helps.
      { status: response.status, retryable: response.status === 409 || response.status >= 500 },
    );
  }
}

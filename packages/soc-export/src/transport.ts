import { randomUUID } from 'node:crypto';
import { isSafeBaseUrl } from './safe-url.js';
import type {
  FindingUpdate,
  FindingUpdateResponse,
  VStrikeFinding,
  VStrikeFindingResultStatus,
  VStrikePushRequest,
  VStrikePushResponse,
} from './types.js';

/** A push or update that did not land. `retryable` says whether trying again could help. */
export class TransportError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; cause?: unknown } = { retryable: false },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransportError';
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export interface VStrikeClientOptions {
  /** Vigil SOC base URL — https, or http for localhost only. */
  baseUrl: string;
  /** Bearer key for the SOC API. */
  apiKey: string;
  /** Injectable for tests; the platform fetch otherwise. */
  fetch?: typeof fetch;
  /** Identifies this pusher to the SOC. */
  source?: string;
  /** Ask the SOC to cluster pushed findings into cases. */
  autoClusterCases?: boolean;
  timeoutMs?: number;
  /** Injectable batch id, for tests. */
  batchId?: () => string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PUSH_PATH = '/api/integrations/vstrike/findings';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFindingStatus(value: unknown): value is VStrikeFindingResultStatus {
  return value === 'created' || value === 'updated' || value === 'failed';
}

function malformedPush(): TransportError {
  return new TransportError('Malformed push response from Vigil SOC.', { retryable: false });
}

function parsePushResponse(body: unknown): VStrikePushResponse {
  if (!isRecord(body)) throw malformedPush();
  const counts: Record<'received' | 'created' | 'updated' | 'failed', unknown> = {
    received: body['received'],
    created: body['created'],
    updated: body['updated'],
    failed: body['failed'],
  };
  for (const value of Object.values(counts)) {
    if (typeof value !== 'number') throw malformedPush();
  }
  if (!Array.isArray(body['results'])) throw malformedPush();
  const results = body['results'].map((item) => {
    if (!isRecord(item) || typeof item['finding_id'] !== 'string') throw malformedPush();
    if (!isFindingStatus(item['status'])) throw malformedPush();
    return {
      finding_id: item['finding_id'],
      status: item['status'],
      ...(typeof item['error'] === 'string' ? { error: item['error'] } : {}),
    };
  });
  if (!Array.isArray(body['case_ids'])) throw malformedPush();
  const caseIds = body['case_ids'].filter((id): id is string => typeof id === 'string');
  return {
    batch_id: typeof body['batch_id'] === 'string' ? body['batch_id'] : '',
    received: counts.received as number,
    created: counts.created as number,
    updated: counts.updated as number,
    failed: counts.failed as number,
    results,
    case_ids: caseIds,
  };
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch (cause) {
    throw new TransportError(`Unreadable JSON from Vigil SOC (HTTP ${response.status}).`, {
      status: response.status,
      retryable: false,
      cause,
    });
  }
}

export class VStrikeClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly doFetch: typeof fetch;
  private readonly source: string;
  private readonly autoClusterCases: boolean;
  private readonly timeoutMs: number;
  private readonly nextBatchId: () => string;

  constructor(options: VStrikeClientOptions) {
    // Same rule as every AI provider: the key goes only to https, or localhost.
    if (!isSafeBaseUrl(options.baseUrl)) {
      throw new TransportError(
        'The Vigil SOC address must use https, or http only for localhost.',
        { retryable: false },
      );
    }
    this.base = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch ?? fetch;
    this.source = options.source ?? 'vigil-at-home';
    this.autoClusterCases = options.autoClusterCases ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextBatchId = options.batchId ?? (() => randomUUID());
  }

  /**
   * Push a batch. A finding_id the SOC has not seen, with timestamp and
   * anomaly_score, creates a finding — and with autoClusterCases the response
   * names the case each landed in; a known id updates it, so the mapping's
   * stable ids make a re-push safe.
   */
  async pushFindings(findings: VStrikeFinding[]): Promise<VStrikePushResponse> {
    if (!findings.length) {
      return {
        batch_id: '',
        received: 0,
        created: 0,
        updated: 0,
        failed: 0,
        results: [],
        case_ids: [],
      };
    }
    const request: VStrikePushRequest = {
      batch_id: this.nextBatchId(),
      source: this.source,
      findings,
      auto_cluster_cases: this.autoClusterCases,
    };
    const response = await this.send('POST', PUSH_PATH, JSON.stringify(request));
    return parsePushResponse(await readJson(response));
  }

  /**
   * The frozen /api/v1 update: an alert resolved at home closes its finding
   * in the SOC. Idempotent, so a retried resolution cannot double-apply.
   *
   * A 404 here is retried: the push and resolution queues flush
   * independently, so a resolution can outrun the creation POST still in
   * flight — "finding not found" is then transient, not permanent. If the
   * finding truly does not exist, the retries exhaust and the resolution
   * queue's drop path reports it.
   */
  async patchFinding(findingId: string, update: FindingUpdate): Promise<FindingUpdateResponse> {
    const path = `/api/v1/findings/${encodeURIComponent(findingId)}`;
    let response: Response;
    try {
      response = await this.send('PATCH', path, JSON.stringify(update));
    } catch (cause) {
      if (cause instanceof TransportError && cause.status === 404) {
        throw new TransportError(
          `Finding ${findingId} not found yet (the push may still be in flight).`,
          {
            status: 404,
            retryable: true,
            cause,
          },
        );
      }
      throw cause;
    }
    const body = await readJson(response);
    if (!isRecord(body) || typeof body['success'] !== 'boolean') {
      throw new TransportError(`Malformed update response from Vigil SOC.`, {
        status: response.status,
        retryable: false,
      });
    }
    const fields = body['updated_fields'];
    return {
      success: body['success'],
      finding: isRecord(body['finding']) ? body['finding'] : {},
      updated_fields: Array.isArray(fields)
        ? fields.filter((field): field is string => typeof field === 'string')
        : [],
    };
  }

  private async send(method: 'POST' | 'PATCH', path: string, body: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Unreachable, refused, or timed out: trying again can help.
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
}

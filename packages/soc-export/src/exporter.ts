import { localNames } from '@vigil/ai/redact';
import type { Alert } from '@vigil/core';
import { BatchQueue, retryableTransportError } from './batch-queue.js';
import { enablementErrors, type SocSettings } from './config.js';
import { alertToFinding, findingIdFor } from './mapping.js';
import { deriveMachineId } from './machine.js';
import { TransportError, VStrikeClient } from './transport.js';
import { DEFAULT_MAX_ENTITY_BYTES } from './types.js';
import type { ExportContext, RedactionNames, ResolutionUpdate, VStrikeFinding } from './types.js';

export interface ExporterDeps {
  /** The caller's rule store: MITRE ids live on Rule.tags. */
  ruleOf: (alert: Alert) => { readonly tags: readonly string[] } | undefined;
  /** Stable per-machine id; hashed from the hostname by default. */
  machineId?: string;
  /** Local names for the redactor; the machine's own by default. */
  names?: RedactionNames;
  /** Byte cap on entity_context. */
  maxEntityBytes?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable batch id, for tests. */
  batchId?: () => string;
  /** Injectable timer work, for tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** A finding batch that will not be retried, or that the SOC refused. */
  onDroppedFindings?: (items: VStrikeFinding[], error: unknown) => void;
  /** A resolution that will not be retried. */
  onDroppedResolutions?: (items: ResolutionUpdate[], error: unknown) => void;
}

/**
 * The opt-in bridge from alerts to the SOC, transport included. Created
 * disabled — the local-first default — it performs no network call of any
 * kind; created enabled, it must have an endpoint, a key, and a safe URL.
 */
export class SocExporter {
  private readonly context: ExportContext | undefined;
  private readonly pushQueue: BatchQueue<VStrikeFinding> | undefined;
  private readonly resolutionQueue: BatchQueue<ResolutionUpdate> | undefined;

  private constructor(
    context: ExportContext | undefined,
    pushQueue: BatchQueue<VStrikeFinding> | undefined,
    resolutionQueue: BatchQueue<ResolutionUpdate> | undefined,
  ) {
    this.context = context;
    this.pushQueue = pushQueue;
    this.resolutionQueue = resolutionQueue;
  }

  /** Throws when enabled settings are incomplete: enabling requires both URL and key. */
  static create(settings: SocSettings, deps: ExporterDeps): SocExporter {
    if (!settings.enabled) {
      // Export is off: the local-first default. Nothing below may touch the
      // network — there is no client and no queue to touch it with.
      return new SocExporter(undefined, undefined, undefined);
    }
    const errors = enablementErrors(settings);
    if (errors.length) throw new Error(['SOC export cannot be enabled.', ...errors].join(' '));

    const context: ExportContext = {
      machineId: deps.machineId ?? deriveMachineId(deps.names),
      ruleOf: deps.ruleOf,
      names: deps.names ?? localNames(),
      maxEntityBytes: deps.maxEntityBytes ?? DEFAULT_MAX_ENTITY_BYTES,
    };
    const client = new VStrikeClient({
      baseUrl: settings.socBaseUrl,
      apiKey: settings.socApiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.batchId ? { batchId: deps.batchId } : {}),
    });

    const pushQueue = new BatchQueue<VStrikeFinding>({
      maxItems: settings.batch.maxItems,
      flushAfterMs: settings.batch.flushAfterMs,
      maxQueueItems: settings.batch.maxQueueItems,
      backoff: settings.backoff,
      retryable: retryableTransportError,
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
      onDropped: (items, error) => deps.onDroppedFindings?.(items, error),
      flush: async (batch) => {
        const response = await client.pushFindings(batch);
        const failed = response.results.filter((result) => result.status === 'failed');
        if (!failed.length) return;
        const refusedIds = new Set(failed.map((result) => result.finding_id));
        const error = new TransportError(
          `Vigil SOC refused ${failed.length} of ${batch.length} findings: ${failed[0]?.error ?? 'no detail'}`,
          { retryable: false },
        );
        deps.onDroppedFindings?.(
          batch.filter((finding) => refusedIds.has(finding.finding_id)),
          error,
        );
      },
    });

    const resolutionQueue = new BatchQueue<ResolutionUpdate>({
      maxItems: settings.batch.maxItems,
      flushAfterMs: settings.batch.flushAfterMs,
      maxQueueItems: settings.batch.maxQueueItems,
      backoff: settings.backoff,
      retryable: retryableTransportError,
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
      onDropped: (items, error) => deps.onDroppedResolutions?.(items, error),
      flush: async (batch) => {
        // PATCH is idempotent: one retryable failure retries the whole
        // batch, and re-running a succeeded update cannot double-apply.
        const settled = await Promise.allSettled(
          batch.map((update) => client.patchFinding(update.findingId, update.update)),
        );
        let firstRetryable: unknown;
        settled.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') return;
          if (retryableTransportError(outcome.reason)) {
            firstRetryable ??= outcome.reason;
            return;
          }
          const item = batch[index];
          if (item) deps.onDroppedResolutions?.([item], outcome.reason);
        });
        if (firstRetryable !== undefined) throw firstRetryable;
      },
    });

    return new SocExporter(context, pushQueue, resolutionQueue);
  }

  get enabled(): boolean {
    return this.context !== undefined;
  }

  /** Findings waiting to push, plus resolutions waiting to PATCH. */
  get pending(): number {
    return (this.pushQueue?.size ?? 0) + (this.resolutionQueue?.size ?? 0);
  }

  /** Map and queue one raised alert. A no-op while export is disabled. */
  exportAlert(alert: Alert): void {
    if (!this.pushQueue || !this.context) return;
    this.pushQueue.add(alertToFinding(alert, this.context));
  }

  /**
   * Queue the resolution of a resolved alert: a PATCH on the frozen /api/v1
   * contract closes the finding in the SOC. Alerts in any other state are
   * ignored — the `changed` event fires for every update, not just
   * resolutions — so the caller may subscribe unfiltered.
   */
  resolveAlert(alert: Alert): void {
    if (!this.resolutionQueue) return;
    if (alert.status !== 'resolved') return;
    this.resolutionQueue.add({ findingId: findingIdFor(alert), update: { status: 'resolved' } });
  }

  /** Flush both queues now. Resolves when nothing is left in flight. */
  async flushNow(): Promise<void> {
    await Promise.all([this.pushQueue?.flushNow(), this.resolutionQueue?.flushNow()]);
  }

  /** Flush what is left and settle both queues. Rethrows a final failure. */
  async stop(): Promise<void> {
    await Promise.all([this.pushQueue?.stop(), this.resolutionQueue?.stop()]);
  }
}

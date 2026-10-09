import { describe, expect, it } from 'vitest';
import { SocExporter } from '../exporter.js';
import { SocSettings } from '../config.js';
import { TransportError } from '../transport.js';
import type { ExporterDeps } from '../exporter.js';
import type { VStrikePushRequest } from '../types.js';
import { DEFAULT_ALERT_ID, FIXTURE_MACHINE_ID, TEST_NAMES, makeAlert } from './fixtures.js';

const ENABLED = SocSettings.parse({
  enabled: true,
  socBaseUrl: 'https://soc.test',
  socApiKey: 'k',
});

interface StubCall {
  url: string;
  method: string;
  body: string;
}

/** Fetch stub answering a queued list of responses; the last repeats. */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: StubCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchImpl };
}

function deps(overrides: Partial<ExporterDeps> = {}): ExporterDeps {
  return {
    ruleOf: () => ({ tags: ['T1003'] }),
    machineId: FIXTURE_MACHINE_ID,
    names: TEST_NAMES,
    ...overrides,
  };
}

const OK_PUSH = {
  status: 200,
  body: {
    batch_id: 'b1',
    received: 2,
    created: 2,
    updated: 0,
    failed: 0,
    results: [
      { finding_id: `vah-${DEFAULT_ALERT_ID}`, status: 'created' },
      { finding_id: 'vah-bb', status: 'created' },
    ],
    case_ids: ['case-1'],
  },
};

describe('SocExporter', () => {
  it('performs no network call of any kind while disabled', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error('no network in the disabled exporter');
    };
    const exporter = SocExporter.create(SocSettings.parse({}), deps({ fetch: fetchImpl }));
    expect(exporter.enabled).toBe(false);
    exporter.exportAlert(makeAlert());
    exporter.resolveAlert(makeAlert({ status: 'resolved', containment: 'released' }));
    await exporter.flushNow();
    await exporter.stop();
    expect(calls).toBe(0);
    expect(exporter.pending).toBe(0);
  });

  it('refuses to construct enabled without both an address and a key', () => {
    expect(() =>
      SocExporter.create(
        SocSettings.parse({ enabled: true, socBaseUrl: 'https://soc.test' }),
        deps(),
      ),
    ).toThrow(/API key/);
    expect(() =>
      SocExporter.create(
        SocSettings.parse({ enabled: true, socApiKey: 'k', socBaseUrl: 'http://soc.test' }),
        deps(),
      ),
    ).toThrow(/https/);
  });

  it('exports raised alerts through one batch to the push endpoint', async () => {
    const stub = stubFetch([OK_PUSH]);
    const exporter = SocExporter.create(ENABLED, deps({ fetch: stub.fetch, batchId: () => 'b1' }));
    exporter.exportAlert(makeAlert());
    exporter.exportAlert(makeAlert({ id: 'bb' }));
    await exporter.flushNow();

    expect(stub.calls).toHaveLength(1);
    const push = stub.calls[0];
    expect(push?.url).toBe('https://soc.test/api/integrations/vstrike/findings');
    expect(push?.method).toBe('POST');
    const sent = JSON.parse(push?.body ?? '') as VStrikePushRequest;
    expect(sent.batch_id).toBe('b1');
    expect(sent.source).toBe('vigil-at-home');
    expect(sent.auto_cluster_cases).toBe(true);
    expect(sent.findings.map((finding) => finding.finding_id)).toEqual([
      `vah-${DEFAULT_ALERT_ID}`,
      'vah-bb',
    ]);
    for (const finding of sent.findings) {
      expect(finding.vstrike_enrichment?.asset_id).toBe(FIXTURE_MACHINE_ID);
    }
  });

  it('queues resolutions for resolved alerts and PATCHes the frozen endpoint', async () => {
    const stub = stubFetch([
      { status: 200, body: { success: true, finding: {}, updated_fields: ['status'] } },
    ]);
    const exporter = SocExporter.create(ENABLED, deps({ fetch: stub.fetch }));
    exporter.resolveAlert(makeAlert()); // open: ignored
    exporter.resolveAlert(makeAlert({ status: 'resolved', containment: 'released' }));
    await exporter.flushNow();

    expect(stub.calls).toHaveLength(1);
    const patch = stub.calls[0];
    expect(patch?.method).toBe('PATCH');
    expect(patch?.url).toBe(`https://soc.test/api/v1/findings/vah-${DEFAULT_ALERT_ID}`);
    expect(JSON.parse(patch?.body ?? '')).toEqual({ status: 'resolved' });
  });

  it('surfaces findings the SOC refused, with only those items', async () => {
    const droppedFindings: Array<{ count: number; error: unknown }> = [];
    const stub = stubFetch([
      {
        status: 200,
        body: {
          batch_id: 'b1',
          received: 2,
          created: 1,
          updated: 0,
          failed: 1,
          results: [
            { finding_id: `vah-${DEFAULT_ALERT_ID}`, status: 'failed', error: 'bad anomaly_score' },
            { finding_id: 'vah-bb', status: 'created' },
          ],
          case_ids: [],
        },
      },
    ]);
    const exporter = SocExporter.create(
      ENABLED,
      deps({
        fetch: stub.fetch,
        onDroppedFindings: (items, error) => droppedFindings.push({ count: items.length, error }),
      }),
    );
    exporter.exportAlert(makeAlert());
    exporter.exportAlert(makeAlert({ id: 'bb' }));
    await exporter.flushNow();

    expect(droppedFindings).toHaveLength(1);
    expect(droppedFindings[0]?.count).toBe(1);
    expect(droppedFindings[0]?.error).toBeInstanceOf(TransportError);
  });

  it('surfaces a resolution the SOC would not take', async () => {
    const droppedResolutions: Array<{ items: unknown[]; error: unknown }> = [];
    const stub = stubFetch([{ status: 422, body: { detail: 'no such finding' } }]);
    const exporter = SocExporter.create(
      ENABLED,
      deps({
        fetch: stub.fetch,
        onDroppedResolutions: (items, error) => droppedResolutions.push({ items, error }),
      }),
    );
    exporter.resolveAlert(makeAlert({ status: 'resolved', containment: 'released' }));
    await exporter.flushNow();

    expect(droppedResolutions).toHaveLength(1);
    expect(droppedResolutions[0]?.error).toBeInstanceOf(TransportError);
  });
});

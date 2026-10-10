import type { DecodedFlow } from './decode/types';
import type { IngestRecord } from './record';

/**
 * Maps one decoded flow to the appliance's normalized record. Pure: the
 * reception timestamp is injected by the caller (the appliance clock).
 */
export function flowToRecord(
  flow: DecodedFlow,
  exporterAddress: string,
  receivedAt: string,
): IngestRecord {
  return {
    schema: 'vigil.flow.v1',
    source: 'netflow',
    receivedAt,
    exporter: {
      address: exporterAddress,
      version: flow.version,
      engineId: flow.engineId,
    },
    flow: flow.flow,
  };
}

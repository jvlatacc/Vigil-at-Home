import type { Condition, DetectionRuleInput } from '../types.js';

/**
 * Relay rules: raised by the app itself, never matched from a sensor event.
 * When telemetry shipping to the relay stops for a reason the user must know
 * about — the relay revoked the device's token, or events were pruned before
 * they shipped — the relay service synthesizes a system.alert event carrying
 * the rule's subtype (relay_revoked / relay_gap, app-only values no sensor
 * emits) and raises it here, once per episode, the way the agent service
 * raises its socket-tamper rule. Turning a rule off here stops that alert.
 */

/** When this pack version was written. Rules carry it as createdAt/updatedAt. */
const PACK_DATE = Date.UTC(2026, 9, 1);

type PackRule = Omit<
  DetectionRuleInput,
  'version' | 'origin' | 'createdAt' | 'updatedAt' | 'eventKinds' | 'response' | 'tags'
> & { version?: number };

function rule(r: PackRule): DetectionRuleInput {
  return {
    version: 1,
    origin: 'builtin',
    createdAt: PACK_DATE,
    updatedAt: PACK_DATE,
    eventKinds: ['system.alert'],
    response: [],
    tags: ['relay'],
    ...r,
  };
}

export const RELAY_REVOKED_RULE_ID = 'relay-revoked';
export const RELAY_GAP_RULE_ID = 'relay-gap';

const revokedCondition: Condition = { field: 'subtype', op: 'eq', value: 'relay_revoked' };
const gapCondition: Condition = { field: 'subtype', op: 'eq', value: 'relay_gap' };

export const relayRules: DetectionRuleInput[] = [
  rule({
    id: RELAY_REVOKED_RULE_ID,
    name: 'Telemetry relay revoked this device',
    description:
      "Raised by Vigil: the relay answered the shipper with 403 or unknown device, so its token no longer works and the SOC is no longer receiving this computer's telemetry. Shipping stops until the device is re-provisioned.",
    mode: 'alert',
    severity: 'high',
    fidelity: 'high',
    condition: revokedCondition,
    reasons: [
      'The relay refused this device (403 or unknown device): its token was revoked.',
      'Shipping stopped, so the SOC stopped receiving telemetry from this computer.',
    ],
  }),
  rule({
    id: RELAY_GAP_RULE_ID,
    name: 'Telemetry relay missed a stretch of events',
    description:
      'Raised by Vigil: events reached the retention limit and were pruned before the relay received them. The gap is marked in the shipped stream, and the cursor moved past it — older events are gone for the SOC.',
    mode: 'alert',
    severity: 'medium',
    fidelity: 'high',
    condition: gapCondition,
    reasons: [
      'The computer pruned events before they shipped to the relay (long outage against the retention cap).',
      'The SOC will not see the pruned events; shipping continues from the newest.',
    ],
  }),
];

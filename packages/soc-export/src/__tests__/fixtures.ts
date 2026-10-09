import type { Alert } from '@vigil/core';
import { DEFAULT_MAX_ENTITY_BYTES, type ExportContext, type RedactionNames } from '../types.js';

/** Fake local names, shaped like the redactor's own localNames() output. */
export const TEST_NAMES: RedactionNames = {
  username: 'alice-holland',
  hostname: 'alice-macbook.local',
};

export const DEFAULT_ALERT_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
export const FIXTURE_RULE_ID = 'persistence.unsigned-launch-agent';
export const FIXTURE_RULE_TAGS = ['T1059.001', 'persistence', 'T1003'];
export const FIXTURE_MACHINE_ID = 'vah-host-0123456789abcdef';

export function makeAlert(overrides: Partial<Alert> = {}): Alert {
  const base: Alert = {
    id: DEFAULT_ALERT_ID,
    createdAt: 1728460000000,
    updatedAt: 1728460000000,
    ruleId: FIXTURE_RULE_ID,
    ruleVersion: 3,
    title: 'Unsigned launch agent persisted',
    summary: 'A process wrote a launch agent, and no signature covers it.',
    severity: 'high',
    fidelity: 'high',
    notify: 'popup',
    status: 'open',
    containment: 'none',
    eventIds: ['e1'],
    actionIds: [],
  };
  return { ...base, ...overrides };
}

export function makeContext(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    machineId: FIXTURE_MACHINE_ID,
    ruleOf: (alert) => (alert.ruleId === FIXTURE_RULE_ID ? { tags: FIXTURE_RULE_TAGS } : undefined),
    names: TEST_NAMES,
    maxEntityBytes: DEFAULT_MAX_ENTITY_BYTES,
    ...overrides,
  };
}

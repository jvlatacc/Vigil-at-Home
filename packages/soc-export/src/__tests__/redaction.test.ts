import { describe, expect, it } from 'vitest';
import { alertToFinding } from '../mapping.js';
import { DEFAULT_MAX_ENTITY_BYTES, type ExportContext } from '../types.js';
import { makeAlert, makeContext, TEST_NAMES } from './fixtures.js';

const { username, hostname } = TEST_NAMES;

/** Payload text as it would cross the wire, exactly. */
function wireOf(alert: Parameters<typeof alertToFinding>[0], overrides?: Partial<ExportContext>) {
  return JSON.stringify(alertToFinding(alert, makeContext(overrides)));
}

const HOSTILE_ALERT = makeAlert({
  title: `Unsigned launch agent on ${hostname} persisted`,
  summary: 'Password=hunter2 written to the plist; github token ghp_' + 'a'.repeat(36) + ' seen.',
  subject: {
    kind: 'file',
    label: `agent-${username}.plist`,
    path: `/Users/${username}/Library/LaunchAgents/agent-${username}.plist`,
  },
});

const LONG_ALERT = makeAlert({
  subject: { kind: 'file', label: 'x'.repeat(20_000), path: '/tmp/long' },
  summary: 'y'.repeat(30_000),
});

describe('redaction before egress', () => {
  it('leaks none of the local names or fixture secrets from the hostile alert', () => {
    const wire = wireOf(HOSTILE_ALERT);
    expect(wire).not.toContain(username);
    expect(wire).not.toContain(hostname);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('ghp_');
  });

  it('leaks no local names or secrets from any payload shape, whatever the cap', () => {
    for (const alert of [HOSTILE_ALERT, LONG_ALERT, makeAlert()]) {
      const wire = wireOf(alert);
      expect(wire).not.toContain(username);
      expect(wire).not.toContain(hostname);
      expect(wire).not.toContain('hunter2');
      expect(wire).not.toContain('ghp_');
    }
  });

  it('marks redactions visibly instead of passing text through untouched', () => {
    const wire = wireOf(HOSTILE_ALERT);
    expect(wire).toMatch(/<user>|\[redacted\]|withheld/);
  });

  it('keeps entity_context under the default byte cap on the wire', () => {
    const finding = alertToFinding(LONG_ALERT, makeContext());
    expect(finding.entity_context_extra).toBeDefined();
    expect(
      Buffer.byteLength(JSON.stringify(finding.entity_context_extra), 'utf8'),
    ).toBeLessThanOrEqual(DEFAULT_MAX_ENTITY_BYTES);
  });

  it('holds a tightened cap while keeping host and alert id', () => {
    const alert = makeAlert({ id: 'fedcba9876543210fedcba9876543210' });
    const finding = alertToFinding(alert, makeContext({ maxEntityBytes: 250 }));
    const extra = finding.entity_context_extra as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(extra), 'utf8')).toBeLessThanOrEqual(250);
    expect(extra['host']).toBe('vah-host-0123456789abcdef');
    expect(extra['alert_id']).toBe(alert.id);
  });

  it('drops an oversize field whole, never mid-secret', () => {
    const secret = 'canary-1234567890-secret-marker';
    const alert = makeAlert({
      subject: { kind: 'file', label: `${'z'.repeat(5_000)} ${secret}`, path: '/tmp/long' },
    });
    const finding = alertToFinding(alert, makeContext({ maxEntityBytes: 300 }));
    const extra = JSON.stringify(finding.entity_context_extra);
    // No prefix of the big field survived: it was withheld whole.
    expect(extra).not.toContain('zzzzzzzzzz');
    expect(extra).not.toContain(secret);
  });

  it('withholds a field that only states it holds a secret', () => {
    const alert = makeAlert({ summary: 'The key was password=hunter2 in the config.' });
    const wire = wireOf(alert);
    expect(wire).not.toContain('hunter2');
    expect(wire).toMatch(/withheld/i);
  });
});

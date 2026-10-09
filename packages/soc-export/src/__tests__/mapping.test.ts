import { Alert } from '@vigil/core';
import { describe, expect, it } from 'vitest';
import { alertToFinding, anomalyScore, findingIdFor, mitrePredictions } from '../mapping.js';
import { makeAlert, makeContext } from './fixtures.js';

describe('alertToFinding', () => {
  it('maps each severity to its deterministic score and the SOC severity', () => {
    const cases = [
      { severity: 'info', score: 0.2, finding: 'low' },
      { severity: 'low', score: 0.4, finding: 'low' },
      { severity: 'medium', score: 0.6, finding: 'medium' },
      { severity: 'high', score: 0.8, finding: 'high' },
      { severity: 'critical', score: 1.0, finding: 'critical' },
    ] as const;
    for (const c of cases) {
      const out = alertToFinding(makeAlert({ severity: c.severity }), makeContext());
      expect(out.anomaly_score).toBe(c.score);
      expect(out.severity).toBe(c.finding);
    }
  });

  it('scores monotonically with severity, within 0.2 to 1.0', () => {
    const severities = ['info', 'low', 'medium', 'high', 'critical'] as const;
    const scores = severities.map((severity) => anomalyScore(makeAlert({ severity })));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1] as number);
    }
  });

  it('maps the same alert to the same finding on every pass', () => {
    const alert = makeAlert();
    const first = alertToFinding(alert, makeContext());
    const second = alertToFinding(alert, makeContext());
    expect(first).toEqual(second);
    expect(first.finding_id).toBe(`vah-${alert.id}`);
    expect(findingIdFor(alert)).toBe(first.finding_id);
  });

  it('lifts MITRE ids off the rule tags, weighted by fidelity', () => {
    const high = alertToFinding(makeAlert({ fidelity: 'high' }), makeContext());
    expect(high.mitre_predictions).toEqual({ 'T1059.001': 0.9, T1003: 0.9 });
    const low = alertToFinding(makeAlert({ fidelity: 'low' }), makeContext());
    expect(low.mitre_predictions).toEqual({ 'T1059.001': 0.6, T1003: 0.6 });
    const medium = alertToFinding(makeAlert({ fidelity: 'medium' }), makeContext());
    expect(medium.mitre_predictions).toEqual({ 'T1059.001': 0.6, T1003: 0.6 });
  });

  it('leaves free tags and malformed technique ids out of mitre_predictions', () => {
    const out = mitrePredictions(makeAlert({ fidelity: 'high' }), [
      'persistence',
      'T1059.001.007',
      'T12',
      'T12345',
      'tn1059',
    ]);
    expect(out).toEqual({});
  });

  it('predicts a base technique id with no sub-technique suffix', () => {
    const out = mitrePredictions(makeAlert({ fidelity: 'high' }), ['T1003', 'persistence']);
    expect(out).toEqual({ T1003: 0.9 });
  });

  it('predicts nothing without a rule', () => {
    const out = alertToFinding(makeAlert({ ruleId: 'no.such-rule' }), makeContext());
    expect(out.mitre_predictions).toEqual({});
  });

  it('carries the receiver-required enrichment with the machine id as the asset', () => {
    const alert = makeAlert();
    const out = alertToFinding(alert, makeContext());
    const timestamp = new Date(alert.createdAt).toISOString();
    expect(out.vstrike_enrichment).toEqual({
      asset_id: 'vah-host-0123456789abcdef',
      segment: 'endpoint',
      criticality: 'medium',
      enriched_at: timestamp,
    });
    expect(out.timestamp).toBe(timestamp);
  });

  it('leads the description with the title: the receiver has no title field', () => {
    const alert = makeAlert();
    expect(alertToFinding(alert, makeContext()).description).toBe(
      `${alert.title}\n${alert.summary}`,
    );
  });

  it('renders its fixture against the Alert schema the mapping reads', () => {
    expect(Alert.safeParse(makeAlert()).success).toBe(true);
    expect(
      Alert.safeParse(
        makeAlert({
          subject: {
            kind: 'file',
            label: 'agent.plist',
            path: '/Library/LaunchAgents/agent.plist',
          },
          ai: {
            provider: 'test',
            at: 1728460000000,
            verdict: 'suspicious',
            confidence: 0.75,
            summary: 'looks bad',
            proposalIds: [],
          },
        }),
      ).success,
    ).toBe(true);
  });
});

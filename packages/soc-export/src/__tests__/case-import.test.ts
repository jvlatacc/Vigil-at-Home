import { describe, expect, it } from 'vitest';
import { IngestCase, redactCaseDocument, serializeCase } from '../case-import.js';
import { TEST_NAMES } from './fixtures.js';

function caseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    case_id: 'case-2026-10-09-lunchpad',
    title: 'Launch-agent persistence campaign',
    description: 'Three unsigned persistence attempts in an hour.',
    finding_ids: ['vah-a1', 'vah-a2', 'vah-a3'],
    status: 'open',
    priority: 'high',
    tags: ['persistence', 'demo'],
    ...overrides,
  };
}

describe('IngestCase', () => {
  it('accepts a complete document', () => {
    const result = IngestCase.safeParse(caseDoc());
    expect(result.success).toBe(true);
  });

  it('requires a case id, a title, and at least one finding link', () => {
    expect(IngestCase.safeParse(caseDoc({ case_id: '' })).success).toBe(false);
    expect(IngestCase.safeParse(caseDoc({ title: '' })).success).toBe(false);
    expect(IngestCase.safeParse(caseDoc({ finding_ids: [] })).success).toBe(false);
    expect(IngestCase.safeParse(caseDoc({ finding_ids: ['vah-a1', ''] })).success).toBe(false);
  });

  it('ignores unknown fields rather than rejecting the whole document', () => {
    const result = IngestCase.safeParse(caseDoc({ extra: 'upstream may add fields' }));
    expect(result.success).toBe(true);
  });
});

describe('redactCaseDocument', () => {
  it('redacts local names in the free-text fields and keeps keys intact', () => {
    const doc = IngestCase.parse(
      caseDoc({
        title: 'agent-alice-holland.plist staged on alice-macbook.local',
        description: 'Staged for alice-holland via a download chain.',
      }),
    );
    const redacted = redactCaseDocument(doc, TEST_NAMES);
    expect(redacted.title).not.toContain('alice-holland');
    expect(redacted.title).not.toContain('alice-macbook.local');
    expect(redacted.description).not.toContain('alice-holland');
    expect(redacted.title).toMatch(/<user>/);
    expect(redacted.description).toMatch(/<user>/);
    expect(redacted.case_id).toBe(doc.case_id);
    expect(redacted.finding_ids).toEqual(doc.finding_ids);
    expect(redacted.tags).toEqual(doc.tags);
  });

  it('leaves a document without a description without one', () => {
    const doc = IngestCase.parse(caseDoc({ description: undefined }));
    expect(redactCaseDocument(doc, TEST_NAMES).description).toBeUndefined();
  });
});

describe('serializeCase', () => {
  it('wraps the document as the cases-keyed object the router routes', () => {
    const doc = IngestCase.parse(caseDoc());
    const serialized = serializeCase(redactCaseDocument(doc, TEST_NAMES));
    expect(JSON.parse(serialized)).toEqual({ cases: [redactCaseDocument(doc, TEST_NAMES)] });
  });
});

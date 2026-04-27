import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '../api/types';
import { activeEvidenceFor } from './evidenceState';

const evidence = (id: string): EvidenceItem => ({
  id,
  label: id,
  relation: 'node-source',
  confidence: 'EXTRACTED',
});

describe('evidence state', () => {
  it('uses source-grounded answer evidence before stale query evidence', () => {
    expect(activeEvidenceFor({ evidence: [evidence('answer')] }, { evidence: [evidence('query')] }).map((item) => item.id)).toEqual(['answer']);
  });

  it('falls back to query evidence when no answer evidence exists', () => {
    expect(activeEvidenceFor({ evidence: [] }, { evidence: [evidence('query')] }).map((item) => item.id)).toEqual(['query']);
    expect(activeEvidenceFor(null, { evidence: [evidence('query')] }).map((item) => item.id)).toEqual(['query']);
  });
});

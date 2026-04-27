import type { EvidenceItem } from '../api/types';

interface EvidenceCardProps {
  evidence: EvidenceItem;
  selected?: boolean;
  onSelect?: (evidence: EvidenceItem) => void;
}

function confidenceTone(confidence: string): string {
  const normalized = confidence.toUpperCase();
  if (normalized.includes('INFER')) return 'inferred';
  if (normalized.includes('AMBIG')) return 'ambiguous';
  if (normalized.includes('EXTRACT')) return 'extracted';
  return 'unknown';
}

export function EvidenceCard({ evidence, selected = false, onSelect }: EvidenceCardProps) {
  const sourcePath = evidence.source_file || evidence.path || 'source file 없음';
  const sourceUrl = evidence.source_url;

  return (
    <article
      className="lg-evidence-card"
      data-confidence={confidenceTone(String(evidence.confidence))}
      data-selected={selected}
    >
      <button
        type="button"
        className="lg-evidence-card__button"
        onClick={() => onSelect?.(evidence)}
        aria-label={`${evidence.label} 근거 선택`}
      >
        <span className="lg-evidence-card__title">{evidence.label}</span>
        <span className="lg-evidence-card__meta">
          <span>{evidence.relation}</span>
          <span>{evidence.confidence}</span>
          {evidence.community !== null && evidence.community !== undefined ? <span>Community {evidence.community}</span> : null}
          {typeof evidence.degree === 'number' ? <span>degree {evidence.degree}</span> : null}
        </span>
        {evidence.rationale ? <span className="lg-evidence-card__rationale">{evidence.rationale}</span> : null}
        <code title={sourcePath}>{sourcePath}</code>
        {sourceUrl ? <code title={sourceUrl}>{sourceUrl}</code> : null}
      </button>
    </article>
  );
}

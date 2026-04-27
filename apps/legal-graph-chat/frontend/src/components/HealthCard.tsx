import type { NormalizedHealth } from '../api/types';

interface HealthCardProps {
  health: NormalizedHealth | null;
  error?: string;
  compact?: boolean;
  title?: string;
}

function formatCount(value: number | null): string {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

export function HealthCard({ health, error, compact = false, title }: HealthCardProps) {
  const state = error ? 'error' : health?.ok ? 'ready' : 'loading';
  const heading = title ?? (compact ? 'Graph health' : 'Graph health');

  return (
    <section className="lg-card lg-health-card" data-state={state} aria-label="Graph health status">
      <div className="lg-health-card__header">
        <span className="lg-health-dot" aria-hidden="true" />
        <div>
          <h2>{heading}</h2>
          <p>{error ?? health?.statusText ?? 'backend 연결 확인 중'}</p>
        </div>
      </div>
      {!compact && (
        <dl className="lg-health-card__stats">
          <div>
            <dt>Nodes</dt>
            <dd>{formatCount(health?.nodes ?? null)}</dd>
          </div>
          <div>
            <dt>Edges</dt>
            <dd>{formatCount(health?.edges ?? null)}</dd>
          </div>
          <div>
            <dt>Communities</dt>
            <dd>{formatCount(health?.communities ?? null)}</dd>
          </div>
        </dl>
      )}
      {health?.warnings?.length ? (
        <ul className="lg-health-card__warnings" aria-label="Graph health warnings">
          {health.warnings.slice(0, 3).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

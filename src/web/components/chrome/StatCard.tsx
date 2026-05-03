// `StatCard` — one tile in the summary strip (components.md §3 / design.md §2.1).
//
// Layout: a small caption label sitting above a large `--text-h1` number,
// inside a 12px-radius surface card. Loading state renders a muted dash so
// the strip never collapses while data is fetched.

export interface StatCardProps {
  label: string;
  /** `null` while loading. */
  value: number | null;
  /** Optional extra hint shown small under the number. */
  hint?: string;
  /** Highlight tone — used for "Unassigned trains" when `value > 0`. */
  emphasis?: 'default' | 'warning' | 'danger';
}

export function StatCard({
  label,
  value,
  hint,
  emphasis = 'default',
}: StatCardProps) {
  return (
    <div className={`stat-card stat-card--${emphasis}`}>
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value === null ? '—' : value}</p>
      {hint ? <p className="stat-card__hint">{hint}</p> : null}
    </div>
  );
}

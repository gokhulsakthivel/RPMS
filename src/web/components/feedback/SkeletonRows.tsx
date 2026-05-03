// `SkeletonRows` — placeholder rows shown while a table's first fetch is
// in flight (components.md §5 / design.md §7).
//
// design.md §12 forbids pulse animation; the rows are static muted blocks
// so the eye doesn't get a moving target. Each "row" is a flex strip of
// pill-shaped placeholders that mirrors the eventual column count.

export interface SkeletonRowsProps {
  /** How many rows to render. Default 5 — fills the table viewport nicely. */
  rows?: number;
  /** How many "cells" per row. Default 6. */
  columns?: number;
}

export function SkeletonRows({
  rows = 5,
  columns = 6,
}: SkeletonRowsProps) {
  return (
    <div className="skeleton" role="status" aria-label="Loading…">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton__row" key={r}>
          {Array.from({ length: columns }, (_, c) => (
            <div className="skeleton__cell" key={c} />
          ))}
        </div>
      ))}
    </div>
  );
}

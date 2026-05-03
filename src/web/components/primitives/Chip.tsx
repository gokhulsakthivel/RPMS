// `Chip` — compact label used in the Trains table "Currently assigned crew"
// cell (components.md §4 / design.md §9.1). Renders crew names tightly so
// two chips fit on one row.
//
// Keeping it deliberately simple: no removal X, no icon, no clickable state
// — that's `Button` / `IconButton` territory.

import type { ReactNode } from 'react';

export interface ChipProps {
  children: ReactNode;
  /** Small role hint shown in lighter text, e.g. `LP` / `ALP`. */
  role?: string;
  className?: string;
}

export function Chip({ children, role, className }: ChipProps) {
  const cls = ['chip', className].filter(Boolean).join(' ');
  return (
    <span className={cls}>
      {role ? <span className="chip__role">{role}</span> : null}
      <span className="chip__label">{children}</span>
    </span>
  );
}

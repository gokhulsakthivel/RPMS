// `EmptyState` — centered icon + headline + helper copy + optional CTA
// (components.md §5 / design.md §7).
//
// Used inside the table area when the API returns `[]`. The page header and
// tab bar render normally; this component fills only the table region.

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';

export interface EmptyStateProps {
  /** Optional decorative glyph or SVG (e.g. "🚂"). */
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon ? (
        <div className="empty-state__icon" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="empty-state__title">{title}</p>
      {description ? (
        <p className="empty-state__desc">{description}</p>
      ) : null}
      {action ? (
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

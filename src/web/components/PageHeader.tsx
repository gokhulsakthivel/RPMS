// `PageHeader` — the section title + right-aligned action used by every
// tab page (design.md §2.2):
//
//   ┌──────────────────────────────────────────────────────┐
//   │  <h2>Trains</h2>                       [+ Add new]   │
//   └──────────────────────────────────────────────────────┘

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** Optional right-aligned action (typically a secondary `Button`). */
  action?: ReactNode;
  /** Optional helper text shown under the title. */
  subtitle?: ReactNode;
}

export function PageHeader({ title, action, subtitle }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        <h1 className="page-header__title">{title}</h1>
        {subtitle ? (
          <p className="page-header__subtitle">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}

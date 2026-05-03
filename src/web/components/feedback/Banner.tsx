// `Banner` — full-width inline message (components.md §5 / design.md §7).
//
// Used for:
//   - Page-level error state ("API call failed", with a retry).
//   - Modal-level rule error (server returned a structured 422).
//
// Tone is encoded as a CSS variant; default `tone="error"` gives the
// red-soft banner from design.md §3.4.

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';

export type BannerTone = 'error' | 'warning' | 'info';

export interface BannerProps {
  tone?: BannerTone;
  title?: string;
  /** Body copy. May be a string or any inline content. */
  children: ReactNode;
  /** Optional retry/dismiss action rendered to the right. */
  action?: { label: string; onClick: () => void };
}

export function Banner({
  tone = 'error',
  title,
  children,
  action,
}: BannerProps) {
  return (
    <div className={`banner banner--${tone}`} role="alert">
      <div className="banner__copy">
        {title ? <p className="banner__title">{title}</p> : null}
        <div className="banner__body">{children}</div>
      </div>
      {action ? (
        <Button variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

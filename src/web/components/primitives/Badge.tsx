// `Badge` — soft pill (light tinted background + saturated text) used for
// train-type and LP-grade labels (components.md §4 / design.md §3.5).
//
// The caller passes the **CSS custom-property names** for the bg/text pair
// (e.g. `--accent-mail-express-bg` / `--accent-mail-express-text`) — the
// Badge stays generic and never hard-codes a token.

import type { ReactNode } from 'react';

export interface BadgeProps {
  /** CSS custom-property name for the background, e.g. `--accent-memu-bg`. */
  bgVar: string;
  /** CSS custom-property name for the text color, e.g. `--accent-memu-text`. */
  textVar: string;
  /** Optional aria-label override; defaults to `children` text. */
  'aria-label'?: string;
  children: ReactNode;
  className?: string;
}

export function Badge({
  bgVar,
  textVar,
  className,
  children,
  ...rest
}: BadgeProps) {
  const cls = ['badge', className].filter(Boolean).join(' ');
  // Inline styles are the right tool here: the bg/text varies per type and
  // we can't enumerate every accent class without duplication.
  const style = {
    backgroundColor: `var(${bgVar})`,
    color: `var(${textVar})`,
  };
  return (
    <span className={cls} style={style} {...rest}>
      {children}
    </span>
  );
}

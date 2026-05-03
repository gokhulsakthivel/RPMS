// `IconButton` — square 32×32 button used inside table action cells
// (components.md §4 / design.md §5). Always carries an `aria-label`.
//
// We don't ship an icon font; the `children` are typically a single
// pictograph character (e.g. `✎` for edit, `↺` for refresh) or an
// inline SVG. Keep it small — the action column is tight.

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** REQUIRED — there is no visible label, so screen readers depend on this. */
  'aria-label': string;
  /** Optional tooltip text; falls back to aria-label. */
  title?: string;
  children: ReactNode;
}

export function IconButton({
  className,
  title,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const cls = ['icon-btn', className].filter(Boolean).join(' ');
  return (
    <button
      type={type}
      title={title ?? rest['aria-label']}
      className={cls}
      {...rest}
    >
      {children}
    </button>
  );
}

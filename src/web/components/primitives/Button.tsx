// `Button` — the single button primitive (components.md §4).
//
// Variants:
//   - primary    → filled, brand color, used for the modal submit / Assign CTA.
//   - secondary  → outlined, used for "+ Add Train" / "+ Add crew".
//   - danger     → outlined red, used for ConfirmDialog "Archive".
//   - text       → unstyled inline link-button, used for "Cancel" in modals.
//
// Sizes (design.md §5):
//   - default → 32px tall (most controls)
//   - cta     → 40px tall, primary CTA only
//
// `disabled` is set explicitly; no auto-disable on submit (forms own state).

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text';
export type ButtonSize    = 'default' | 'cta';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Force 100% width — used by the modal submit button (design.md §8). */
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'default',
  fullWidth = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    fullWidth ? 'btn--full' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    // eslint-disable-next-line react/button-has-type — we set `type` from props.
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

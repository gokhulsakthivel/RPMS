// `Select` — native `<select>` with our dark-theme styling
// (components.md §4). Used for the Train type dropdown and the LP category
// dropdown.
//
// Options are passed as `<option>` children so the caller can render
// optgroups or extra empty placeholders if needed.

import type { SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ invalid, className, children, ...rest }, ref) {
    const cls = [
      'select',
      invalid ? 'select--invalid' : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <select ref={ref} className={cls} {...rest}>
        {children}
      </select>
    );
  },
);

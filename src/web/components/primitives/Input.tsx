// `Input` — thin styled wrapper around the native `<input>` (components.md §4).
//
// Exposes only the props we use; `FormField` renders the label, hint, and
// error; this primitive is just the styled control. The 36px height comes
// from design.md §5.

import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ invalid, className, type = 'text', ...rest }, ref) {
    const cls = [
      'input',
      invalid ? 'input--invalid' : null,
      className,
    ]
      .filter(Boolean)
      .join(' ');
    return <input ref={ref} type={type} className={cls} {...rest} />;
  },
);

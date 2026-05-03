// `FormField` — labeled wrapper around an Input/Select/DateTimeInput
// (components.md §4). Renders:
//
//   ┌─────────────────────────────────────────────┐
//   │ Label *               (small caption hint)  │
//   │ [ control                                ]  │
//   │ Optional inline error message               │
//   └─────────────────────────────────────────────┘
//
// The control is rendered via `children`. The field is responsible for
// associating the label with the control via `htmlFor` / `id`, and for
// wiring `aria-describedby` to the error/hint when present.

import { useId, type ReactNode } from 'react';

export interface FormFieldProps {
  label: string;
  /** Show the trailing red `*`. Defaults to `false` — caller must opt in. */
  required?: boolean;
  /** Optional explanatory text under the label. */
  hint?: string;
  /** Inline error message, rendered below the control in `--color-danger`. */
  error?: string;
  /**
   * Render-prop receives the wired `id` and `aria-describedby` attributes
   * the control should spread onto the input/select.
   */
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}

export function FormField({
  label,
  required,
  hint,
  error,
  children,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    hint ? hintId : null,
    error ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <div className="form-field">
      <label className="form-field__label" htmlFor={id}>
        {label}
        {required ? <span className="form-field__required" aria-hidden> *</span> : null}
      </label>
      {hint ? (
        <p className="form-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children({ id, describedBy })}
      {error ? (
        <p className="form-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

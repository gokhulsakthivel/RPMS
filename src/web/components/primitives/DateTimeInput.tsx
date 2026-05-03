// `DateTimeInput` — wraps a native `<input type="datetime-local">` for the
// Add/Edit Train modal (components.md §4 / design.md §9.1).
//
// Critical contract:
//   - The native control reads/writes a **local-wall-clock** string in the
//     form `YYYY-MM-DDTHH:mm` (no timezone). Operators enter IST values.
//   - This component owns the IST↔UTC translation: the caller passes a
//     `Date` (UTC instant), we render the equivalent IST wall-clock; on
//     change we parse the IST wall-clock back to a UTC `Date`.
//
// All math goes through helpers in `shared/time.ts` so the rule lives in
// exactly one place.

import { forwardRef } from 'react';
import {
  istWallClockToUtc,
  utcToIstWallClock,
} from '../../../shared/time';

export interface DateTimeInputProps {
  id?: string;
  name?: string;
  /** Current value as a UTC `Date`, or `null` when empty. */
  value: Date | null;
  /** Fires with a UTC `Date` whenever the operator picks an IST wall time. */
  onChange: (next: Date | null) => void;
  /** True when the field has a validation error. */
  invalid?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** ARIA label or labelledby comes from the surrounding `FormField`. */
  'aria-describedby'?: string;
}

export const DateTimeInput = forwardRef<HTMLInputElement, DateTimeInputProps>(
  function DateTimeInput(
    { id, name, value, onChange, invalid, required, disabled, ...aria },
    ref,
  ) {
    // Native input wants a 16-char local string. Empty string when null.
    const wallClock = value ? utcToIstWallClock(value) : '';
    const cls = [
      'input',
      'input--datetime',
      invalid ? 'input--invalid' : null,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <input
        ref={ref}
        id={id}
        name={name}
        type="datetime-local"
        className={cls}
        value={wallClock}
        required={required}
        disabled={disabled}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onChange(v ? istWallClockToUtc(v) : null);
        }}
        {...aria}
      />
    );
  },
);

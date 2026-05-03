// `DatePicker` — the single date input mounted in the header.
//
// Wraps `<input type="date">`. Per components.md §3 it exposes a controlled
// `value` / `onChange` so the parent (AppShell) can wire it directly to the
// `useSelectedDate()` hook. The input value is the **IST calendar date** as
// `YYYY-MM-DD`; conversion to a UTC instant happens in the hook.
//
// We do NOT format the visible value ourselves — the browser renders the
// native control. The `<label>` next to it just gives the picker a name for
// screen readers and pointer affordance.

import { ChangeEvent, useId } from 'react';

export interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (next: string) => void;
}

export function DatePicker({ value, onChange }: DatePickerProps) {
  const inputId = useId();

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    // Native date inputs return `''` if the user clears the field. We
    // ignore empties — the rest of the app assumes a valid YYYY-MM-DD —
    // and let the browser's built-in validity UI signal the issue.
    if (next) onChange(next);
  }

  return (
    <div className="date-picker">
      <label htmlFor={inputId} className="date-picker__label">
        Date (IST)
      </label>
      <input
        id={inputId}
        type="date"
        className="date-picker__input"
        value={value}
        onChange={handleChange}
        aria-label="Select date in IST"
      />
    </div>
  );
}

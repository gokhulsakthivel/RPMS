// `EligibleCrewSelect` — single-select dropdown of eligible crew, with a
// mini-grade badge inside each option (components.md §10).
//
// Pre-filtered server-side — the SPA never re-runs eligibility / rest /
// overlap rules. The dropdown is a thin <select> over `LpSummary[]`.

import type { LpSummary } from '../../../shared/schemas';
import { longFormLabel } from '../../lib/grade';
import { Select } from '../primitives/Select';

export interface EligibleCrewSelectProps {
  id?: string;
  /** The eligible options (server-filtered). */
  options: ReadonlyArray<LpSummary>;
  /** Currently selected ID, or `null` for unselected. */
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  'aria-describedby'?: string;
}

export function EligibleCrewSelect({
  id,
  options,
  value,
  onChange,
  placeholder = 'Select crew member…',
  disabled,
  invalid,
  'aria-describedby': describedBy,
}: EligibleCrewSelectProps) {
  return (
    <Select
      id={id}
      value={value ?? ''}
      disabled={disabled || options.length === 0}
      invalid={invalid}
      onChange={(e) => onChange(e.currentTarget.value || null)}
      aria-describedby={describedBy}
    >
      <option value="">
        {options.length === 0
          ? 'No eligible crew available'
          : placeholder}
      </option>
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.name}
          {opt.grade ? ` — ${longFormLabel(opt.grade)}` : ''}
        </option>
      ))}
    </Select>
  );
}

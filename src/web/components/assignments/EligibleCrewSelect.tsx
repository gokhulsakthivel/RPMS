// `EligibleCrewSelect` — single-select dropdown of eligible crew, split into
// two `<optgroup>`s by rest status (components.md §10).
//
// The 16-hour rest gate is no longer enforced server-side, so resting crew
// appear in the list under "Not yet rested (16h)" with the remaining hours
// labelled per option. Rested crew sit in the top group so the operator's
// muscle-memory pick is still the safest pick by default.

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
  // Split by rest status. `restHoursRemaining === 0` means rested.
  const rested = options.filter((o) => o.restHoursRemaining <= 0);
  const resting = options.filter((o) => o.restHoursRemaining > 0);

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
      {rested.length > 0 ? (
        <optgroup label="Rested (16h+)">
          {rested.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {formatRestedLabel(opt)}
            </option>
          ))}
        </optgroup>
      ) : null}
      {resting.length > 0 ? (
        <optgroup label="Not yet rested">
          {resting.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {formatRestingLabel(opt)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </Select>
  );
}

function formatRestedLabel(opt: LpSummary): string {
  const grade = opt.grade ? ` — ${longFormLabel(opt.grade)}` : '';
  return `${opt.name}${grade} · rested`;
}

function formatRestingLabel(opt: LpSummary): string {
  const grade = opt.grade ? ` — ${longFormLabel(opt.grade)}` : '';
  // Round up so "0.1h" doesn't render as "0h remaining".
  const hours = Math.ceil(opt.restHoursRemaining);
  return `${opt.name}${grade} · ${hours}h rest remaining`;
}


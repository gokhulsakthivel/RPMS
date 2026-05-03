// `CrewForm` — shared form behind Add/Edit Crew modals (components.md §9 /
// design.md §9.2).
//
// Modes:
//   - 'add'  → role is editable (LP/ALP toggle), `lastSignOffTime` hidden.
//   - 'edit' → role is locked (server doesn't support cross-table moves),
//              `lastSignOffTime` editable (the manual override per HLD §4.7).
//
// The form holds a single `eligibleTrainTypes` set and filters the toggle
// list based on the active role:
//   - LP eligibleTrainTypes ↦ all 6 train types — eligibility is fully
//     data-driven (HLD §4.2). `category` is a label only.
//   - ALP eligibleTrainTypes ↦ all types except MEMU and DEMU (Zod refines).
//
// On submit, the parent decides which API to call based on `kind`.

import { useEffect, useId, useMemo, useState } from 'react';
import { LpCategory, TrainType } from '../../../domain/types';
import { longFormLabel, sortByHierarchy } from '../../lib/grade';
import type {
  AlpCreateInput,
  CrewRow,
  LocoPilotCreateInput,
} from '../../../shared/schemas';
import { Button } from '../primitives/Button';
import { DateTimeInput } from '../primitives/DateTimeInput';
import { FormField } from '../primitives/FormField';
import { Input } from '../primitives/Input';
import { Select } from '../primitives/Select';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CrewKind = 'LP' | 'ALP';

export interface CrewFormValues {
  kind: CrewKind;
  name: string;
  /** Only meaningful when kind === 'LP'. */
  category: LpCategory;
  eligibleTrainTypes: TrainType[];
  /** Only present in 'edit' mode. `null` clears the field; `undefined` leaves untouched. */
  lastSignOffTime?: Date | null;
}

const EMPTY_LP: CrewFormValues = {
  kind: 'LP',
  name: '',
  category: LpCategory.MAIL_EXPRESS,
  eligibleTrainTypes: [],
};
const EMPTY_ALP: CrewFormValues = {
  kind: 'ALP',
  name: '',
  category: LpCategory.MAIL_EXPRESS, // unused for ALP, kept for shape stability
  eligibleTrainTypes: [],
};

// ---------------------------------------------------------------------------
// Eligibility constants — see src/shared/schemas.ts for the same lists.
// ---------------------------------------------------------------------------

/** LP eligibilities — every TrainType. Eligibility is fully data-driven. */
const LP_ELIGIBILITY: ReadonlyArray<TrainType> = sortByHierarchy([
  TrainType.PASSENGER,
  TrainType.MAIL_EXPRESS,
  TrainType.MEMU,
  TrainType.DEMU,
  TrainType.VANDE_BHARAT,
  TrainType.AMRIT_BHARAT,
]);

/** ALP eligibilities — every type except MEMU/DEMU. */
const ALP_ELIGIBILITY: ReadonlyArray<TrainType> = sortByHierarchy([
  TrainType.PASSENGER,
  TrainType.MAIL_EXPRESS,
  TrainType.VANDE_BHARAT,
  TrainType.AMRIT_BHARAT,
]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type CrewFormMode = 'add' | 'edit';

export interface CrewFormProps {
  mode: CrewFormMode;
  /** Pre-fill (Edit). If omitted, blank form (Add). */
  initial?: { row: CrewRow; lastSignOffTime: Date | null };
  /**
   * Called with the validated payload + chosen kind. Parent decides which
   * API endpoint to call.
   */
  onSubmit: (
    kind: CrewKind,
    payload:
      | { kind: 'LP-CREATE';  data: LocoPilotCreateInput }
      | { kind: 'LP-UPDATE';  data: LpUpdateData }
      | { kind: 'ALP-CREATE'; data: AlpCreateInput }
      | { kind: 'ALP-UPDATE'; data: AlpUpdateData },
  ) => Promise<void>;
  submitLabel: string;
  onCancel: () => void;
}

interface LpUpdateData {
  name: string;
  category: LpCategory;
  eligibleTrainTypes: TrainType[];
  /** `Date` to set, `null` to clear, `undefined` to leave unchanged. */
  lastSignOffTime?: Date | null;
}

interface AlpUpdateData {
  name: string;
  eligibleTrainTypes: TrainType[];
  lastSignOffTime?: Date | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CrewForm({
  mode,
  initial,
  onSubmit,
  submitLabel,
  onCancel,
}: CrewFormProps) {
  const formId = useId();
  const [values, setValues] = useState<CrewFormValues>(() =>
    initial ? hydrate(initial) : EMPTY_LP,
  );
  const [errors, setErrors] = useState<Partial<Record<keyof CrewFormValues, string>>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setValues(initial ? hydrate(initial) : EMPTY_LP);
    setErrors({});
  }, [initial]);

  const eligibilityOptions = useMemo(
    () => (values.kind === 'LP' ? LP_ELIGIBILITY : ALP_ELIGIBILITY),
    [values.kind],
  );

  function patch<K extends keyof CrewFormValues>(key: K, value: CrewFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  }

  function toggleType(t: TrainType) {
    setValues((v) => {
      const has = v.eligibleTrainTypes.includes(t);
      return {
        ...v,
        eligibleTrainTypes: has
          ? v.eligibleTrainTypes.filter((x) => x !== t)
          : sortByHierarchy([...v.eligibleTrainTypes, t]),
      };
    });
  }

  function setKind(next: CrewKind) {
    // Switching role wipes eligibilities since the legal sets differ.
    setValues((v) => ({ ...v, kind: next, eligibleTrainTypes: [] }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation = validate(values);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    setPending(true);
    try {
      await dispatch(values, mode, onSubmit);
    } finally {
      setPending(false);
    }
  }

  return (
    <form id={formId} className="crew-form" onSubmit={handleSubmit} noValidate>
      <FormField label="Role" required>
        {({ id }) => (
          <div id={id} className="crew-form__role" role="radiogroup" aria-label="Role">
            <label className="crew-form__role-opt">
              <input
                type="radio"
                name="kind"
                value="LP"
                checked={values.kind === 'LP'}
                disabled={mode === 'edit'}
                onChange={() => setKind('LP')}
              />
              <span>Loco Pilot</span>
            </label>
            <label className="crew-form__role-opt">
              <input
                type="radio"
                name="kind"
                value="ALP"
                checked={values.kind === 'ALP'}
                disabled={mode === 'edit'}
                onChange={() => setKind('ALP')}
              />
              <span>Assistant Loco Pilot</span>
            </label>
            {mode === 'edit' ? (
              <p className="crew-form__role-locked">
                Role is locked when editing — archive and re-add to convert.
              </p>
            ) : null}
          </div>
        )}
      </FormField>

      <FormField label="Name" required error={errors.name}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={values.name}
            onChange={(e) => patch('name', e.currentTarget.value)}
            invalid={!!errors.name}
            placeholder="e.g. R. Kumar"
          />
        )}
      </FormField>

      {values.kind === 'LP' ? (
        <FormField
          label="Category"
          required
          hint="Role label only — eligibility is set via the train-type checkboxes below."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={values.category}
              onChange={(e) =>
                patch('category', e.currentTarget.value as LpCategory)
              }
            >
              <option value={LpCategory.MAIL_EXPRESS}>Mail/Express</option>
              <option value={LpCategory.PASSENGER}>Passenger</option>
            </Select>
          )}
        </FormField>
      ) : null}

      <FormField
        label="Eligible train types"
        hint={
          values.kind === 'LP'
            ? 'Tick every train type this LP is certified to drive.'
            : 'ALPs are not assigned to MEMU or DEMU trains.'
        }
      >
        {({ id, describedBy }) => (
          <fieldset
            id={id}
            aria-describedby={describedBy}
            className="crew-form__checks"
          >
            <legend className="visually-hidden">Eligible train types</legend>
            {eligibilityOptions.map((t) => (
              <label key={t} className="crew-form__check">
                <input
                  type="checkbox"
                  checked={values.eligibleTrainTypes.includes(t)}
                  onChange={() => toggleType(t)}
                />
                <span>{longFormLabel(t)}</span>
              </label>
            ))}
          </fieldset>
        )}
      </FormField>

      {mode === 'edit' ? (
        <FormField
          label="Last sign-off time (IST)"
          hint="Leave blank to clear. Manual override — see HLD §4.7."
        >
          {({ id, describedBy }) => (
            <div className="crew-form__signoff">
              <DateTimeInput
                id={id}
                aria-describedby={describedBy}
                value={values.lastSignOffTime ?? null}
                onChange={(d) => patch('lastSignOffTime', d)}
              />
              {values.lastSignOffTime ? (
                <Button
                  variant="text"
                  onClick={() => patch('lastSignOffTime', null)}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          )}
        </FormField>
      ) : null}

      <div className="modal__actions">
        <Button variant="text" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="cta"
          fullWidth
          type="submit"
          disabled={pending}
        >
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hydrate({
  row,
  lastSignOffTime,
}: NonNullable<CrewFormProps['initial']>): CrewFormValues {
  // CrewRow.editable carries the raw domain fields needed by the form
  // (see the projection layer). Falls back to safe defaults for
  // forward-compat in case a server response somehow omits the slice.
  const editable = row.editable;
  return row.kind === 'LP'
    ? {
        kind: 'LP',
        name: row.name,
        category: editable.category ?? LpCategory.MAIL_EXPRESS,
        eligibleTrainTypes: [...editable.eligibleTrainTypes],
        lastSignOffTime,
      }
    : {
        ...EMPTY_ALP,
        name: row.name,
        eligibleTrainTypes: [...editable.eligibleTrainTypes],
        lastSignOffTime,
      };
}

function validate(v: CrewFormValues): Partial<Record<keyof CrewFormValues, string>> {
  const e: Partial<Record<keyof CrewFormValues, string>> = {};
  if (!v.name.trim()) e.name = 'Required.';
  return e;
}

async function dispatch(
  v: CrewFormValues,
  mode: CrewFormMode,
  onSubmit: CrewFormProps['onSubmit'],
): Promise<void> {
  const trimmedName = v.name.trim();
  if (v.kind === 'LP') {
    if (mode === 'add') {
      await onSubmit('LP', {
        kind: 'LP-CREATE',
        data: {
          name: trimmedName,
          category: v.category,
          eligibleTrainTypes: v.eligibleTrainTypes,
        },
      });
    } else {
      await onSubmit('LP', {
        kind: 'LP-UPDATE',
        data: {
          name: trimmedName,
          category: v.category,
          eligibleTrainTypes: v.eligibleTrainTypes,
          lastSignOffTime: v.lastSignOffTime,
        },
      });
    }
  } else {
    if (mode === 'add') {
      await onSubmit('ALP', {
        kind: 'ALP-CREATE',
        data: {
          name: trimmedName,
          eligibleTrainTypes: v.eligibleTrainTypes,
        },
      });
    } else {
      await onSubmit('ALP', {
        kind: 'ALP-UPDATE',
        data: {
          name: trimmedName,
          eligibleTrainTypes: v.eligibleTrainTypes,
          lastSignOffTime: v.lastSignOffTime,
        },
      });
    }
  }
}

// Re-export the dispatch payload types for the modal wrappers.
export type { LpUpdateData, AlpUpdateData };

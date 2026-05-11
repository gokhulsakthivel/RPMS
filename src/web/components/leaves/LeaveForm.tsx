// `LeaveForm` — shared form behind Add/Edit Leave modals (components.md §11 /
// design.md §9.5).
//
// Modes:
//   - 'add'  → crew picker (Role + Crew member dropdowns), all fields editable.
//   - 'edit' → crew identity is locked (server doesn't move a leave between
//              crew records); type / dates / reason remain editable.
//
// The crew picker hydrates from `/api/loco-pilots` and
// `/api/assistant-loco-pilots`. We drop archived rows on the client side so
// the operator never picks someone who's been removed from the roster.
//
// Date inputs are native `<input type="date">` so the value is the
// `YYYY-MM-DD` IST calendar string the backend already speaks — no
// timezone math required.

import { useEffect, useId, useMemo, useState } from 'react';
import { LeaveType } from '../../../domain/types';
import {
  assistantLocoPilots as alpApi,
  locoPilots as lpApi,
} from '../../lib/api';
import type {
  CrewRow,
  LeaveCreateInput,
  LeaveRow,
  LeaveUpdateInput,
} from '../../../shared/schemas';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { Input } from '../primitives/Input';
import { Select } from '../primitives/Select';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type LeaveFormMode = 'add' | 'edit';

type CrewRole = 'LP' | 'ALP';

interface LeaveFormValues {
  crewRole: CrewRole;
  crewId: string;
  type: LeaveType;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  reason: string;
}

const EMPTY: LeaveFormValues = {
  crewRole: 'LP',
  crewId: '',
  type: LeaveType.SICK,
  fromDate: '',
  toDate: '',
  reason: '',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LeaveFormProps {
  mode: LeaveFormMode;
  /** Pre-fill (Edit). If omitted, blank form (Add). */
  initial?: LeaveRow;
  /**
   * Called with the validated payload. Parent decides which API endpoint to
   * call (create vs update by id).
   */
  onSubmit: (
    payload:
      | { kind: 'CREATE'; data: LeaveCreateInput }
      | { kind: 'UPDATE'; data: LeaveUpdateInput },
  ) => Promise<void>;
  submitLabel: string;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LeaveForm({
  mode,
  initial,
  onSubmit,
  submitLabel,
  onCancel,
}: LeaveFormProps) {
  const formId = useId();
  const [values, setValues] = useState<LeaveFormValues>(() =>
    initial ? hydrate(initial) : EMPTY,
  );
  const [errors, setErrors] = useState<Partial<Record<keyof LeaveFormValues, string>>>({});
  const [pending, setPending] = useState(false);

  // Crew lists for the picker. We re-fetch when the form opens so a crew
  // member added in another tab shows up without a hard reload. We pass
  // today's IST date because the list endpoint requires `?date=` for rest
  // projection — we don't read the rest fields, only id + name.
  const [lps, setLps] = useState<CrewRow[] | null>(null);
  const [alps, setAlps] = useState<CrewRow[] | null>(null);
  const [crewLoadError, setCrewLoadError] = useState<string | null>(null);

  useEffect(() => {
    setValues(initial ? hydrate(initial) : EMPTY);
    setErrors({});
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    setCrewLoadError(null);
    const today = istToday();
    Promise.all([lpApi.list(today), alpApi.list(today)])
      .then(([lpRows, alpRows]) => {
        if (cancelled) return;
        setLps(lpRows);
        setAlps(alpRows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCrewLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const crewOptions = useMemo(() => {
    const list = values.crewRole === 'LP' ? lps : alps;
    if (!list) return [];
    return [...list].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [lps, alps, values.crewRole]);

  function patch<K extends keyof LeaveFormValues>(key: K, value: LeaveFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  }

  function setRole(next: CrewRole) {
    // Switching role wipes the crewId since the legal options differ.
    setValues((v) => ({ ...v, crewRole: next, crewId: '' }));
    setErrors((e) => ({ ...e, crewId: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation = validate(values, mode);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }
    setPending(true);
    try {
      await dispatch(values, mode, onSubmit, initial);
    } finally {
      setPending(false);
    }
  }

  return (
    <form id={formId} className="leave-form" onSubmit={handleSubmit} noValidate>
      <FormField label="Role" required>
        {({ id }) => (
          <div id={id} className="leave-form__role" role="radiogroup" aria-label="Role">
            <label className="leave-form__role-opt">
              <input
                type="radio"
                name="crewRole"
                value="LP"
                checked={values.crewRole === 'LP'}
                disabled={mode === 'edit'}
                onChange={() => setRole('LP')}
              />
              <span>Loco Pilot</span>
            </label>
            <label className="leave-form__role-opt">
              <input
                type="radio"
                name="crewRole"
                value="ALP"
                checked={values.crewRole === 'ALP'}
                disabled={mode === 'edit'}
                onChange={() => setRole('ALP')}
              />
              <span>Assistant Loco Pilot</span>
            </label>
            {mode === 'edit' ? (
              <p className="leave-form__role-locked">
                Crew identity is locked when editing — archive and re-add to move.
              </p>
            ) : null}
          </div>
        )}
      </FormField>

      <FormField label="Crew member" required error={errors.crewId}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={values.crewId}
            onChange={(e) => patch('crewId', e.currentTarget.value)}
            invalid={!!errors.crewId}
            disabled={mode === 'edit'}
          >
            <option value="">— select —</option>
            {crewOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </FormField>

      {crewLoadError ? (
        <p className="leave-form__crew-error" role="alert">
          Couldn't load crew list: {crewLoadError}
        </p>
      ) : null}

      <FormField label="Type" required>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={values.type}
            onChange={(e) => patch('type', e.currentTarget.value as LeaveType)}
          >
            <option value={LeaveType.SICK}>Sick</option>
            <option value={LeaveType.LEAVE}>Leave (planned)</option>
            <option value={LeaveType.TRAINING}>Training</option>
            <option value={LeaveType.PR}>PR (Periodic Rest)</option>
          </Select>
        )}
      </FormField>

      <div className="leave-form__date-row">
        <FormField label="From (IST)" required error={errors.fromDate}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="date"
              value={values.fromDate}
              onChange={(e) => patch('fromDate', e.currentTarget.value)}
              invalid={!!errors.fromDate}
            />
          )}
        </FormField>

        <FormField label="To (IST)" required error={errors.toDate}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="date"
              value={values.toDate}
              onChange={(e) => patch('toDate', e.currentTarget.value)}
              invalid={!!errors.toDate}
            />
          )}
        </FormField>
      </div>

      <FormField
        label="Reason"
        hint="Optional. Free-text note (≤ 200 characters)."
        error={errors.reason}
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={values.reason}
            onChange={(e) => patch('reason', e.currentTarget.value)}
            placeholder="e.g. Fever — see medical note"
            maxLength={200}
            invalid={!!errors.reason}
          />
        )}
      </FormField>

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

function hydrate(row: LeaveRow): LeaveFormValues {
  return {
    crewRole: row.crewRole,
    crewId: row.crewId,
    type: row.type,
    fromDate: row.fromDate,
    toDate: row.toDate,
    reason: row.reason ?? '',
  };
}

function validate(
  v: LeaveFormValues,
  _mode: LeaveFormMode,
): Partial<Record<keyof LeaveFormValues, string>> {
  const e: Partial<Record<keyof LeaveFormValues, string>> = {};
  if (!v.crewId.trim()) e.crewId = 'Required.';
  if (!v.fromDate) e.fromDate = 'Required.';
  if (!v.toDate) e.toDate = 'Required.';
  if (v.fromDate && v.toDate && v.toDate < v.fromDate) {
    e.toDate = 'To-date must be on or after From-date.';
  }
  if (v.reason.length > 200) e.reason = 'Max 200 characters.';
  return e;
}

async function dispatch(
  v: LeaveFormValues,
  mode: LeaveFormMode,
  onSubmit: LeaveFormProps['onSubmit'],
  initial: LeaveRow | undefined,
): Promise<void> {
  const reason = v.reason.trim();
  if (mode === 'add') {
    const data: LeaveCreateInput = {
      crewId: v.crewId,
      crewRole: v.crewRole,
      type: v.type,
      fromDate: v.fromDate,
      toDate: v.toDate,
      reason: reason.length > 0 ? reason : undefined,
    };
    await onSubmit({ kind: 'CREATE', data });
    return;
  }

  // Edit — only send fields that changed. Date pair is sent together when
  // either endpoint changed (the backend refines that toDate >= fromDate).
  const datesChanged =
    !!initial &&
    (v.fromDate !== initial.fromDate || v.toDate !== initial.toDate);
  const data: LeaveUpdateInput = {
    type: initial && v.type !== initial.type ? v.type : undefined,
    ...(datesChanged ? { fromDate: v.fromDate, toDate: v.toDate } : {}),
    reason:
      initial && (initial.reason ?? '') !== reason
        ? reason.length > 0 ? reason : undefined
        : undefined,
  };
  await onSubmit({ kind: 'UPDATE', data });
}

/**
 * Today's IST calendar date (`YYYY-MM-DD`). Used to query the crew list
 * endpoint — the rest projection is irrelevant here, but the endpoint
 * requires the param.
 */
function istToday(): string {
  const now = new Date();
  // IST = UTC+05:30
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

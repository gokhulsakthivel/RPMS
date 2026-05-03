// `TrainForm` — internal shared form used by both Add- and Edit-Train
// modals. Owns its own state. The parent provides `initialValue` (optional)
// and a `submit` callback that returns the persisted row or throws an
// `ApiError`.
//
// M9 — trains are recurring weekly schedules. The form fields are:
//   • "Runs on"            — 7 checkboxes (Sun…Sat)
//   • "Departure (IST)"    — `<input type="time">` (HH:MM, 24h)
//   • "Inward arrival (IST)" — `<input type="time">`
//   • "Inward arrival day" — `Same day | Next day | +2 days | +3 days`
// At least one day must be picked, and a "probe materialization" against a
// synthetic Sunday must yield arrival > departure before submit.

import { useEffect, useId, useState } from 'react';
import { DayOfWeek, TrainType } from '../../../domain/types';
import { longFormLabel } from '../../lib/grade';
import type {
  TrainCreateInput,
  TrainWithAssignment,
} from '../../../shared/schemas';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { Input } from '../primitives/Input';
import { Select } from '../primitives/Select';

// ---------------------------------------------------------------------------
// Form state — `string` for time-of-day fields so a partially-filled form
// survives mount. The parent's submit handler validates and forwards verbatim.
// ---------------------------------------------------------------------------

const DAY_ORDER: DayOfWeek[] = [
  DayOfWeek.SUN,
  DayOfWeek.MON,
  DayOfWeek.TUE,
  DayOfWeek.WED,
  DayOfWeek.THU,
  DayOfWeek.FRI,
  DayOfWeek.SAT,
];

const DAY_LABEL: Record<DayOfWeek, string> = {
  [DayOfWeek.SUN]: 'Sun',
  [DayOfWeek.MON]: 'Mon',
  [DayOfWeek.TUE]: 'Tue',
  [DayOfWeek.WED]: 'Wed',
  [DayOfWeek.THU]: 'Thu',
  [DayOfWeek.FRI]: 'Fri',
  [DayOfWeek.SAT]: 'Sat',
};

const ARRIVAL_DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Same day' },
  { value: 1, label: 'Next day' },
  { value: 2, label: '+2 days' },
  { value: 3, label: '+3 days' },
];

export interface TrainFormValues {
  number: string;
  name: string;
  type: TrainType;
  onwardFromStation: string;
  onwardToStation: string;
  runsOnDays: DayOfWeek[];
  departureTimeOfDay: string;
  inwardTrainNumber: string;
  inwardFromStation: string;
  inwardToStation: string;
  inwardArrivalTimeOfDay: string;
  inwardArrivalDayOffset: number;
}

const EMPTY: TrainFormValues = {
  number: '',
  name: '',
  type: TrainType.MAIL_EXPRESS,
  onwardFromStation: '',
  onwardToStation: '',
  runsOnDays: [],
  departureTimeOfDay: '',
  inwardTrainNumber: '',
  inwardFromStation: '',
  inwardToStation: '',
  inwardArrivalTimeOfDay: '',
  inwardArrivalDayOffset: 0,
};

export interface TrainFormProps {
  /**
   * Pre-fill the form (Edit flow). Pass a `TrainWithAssignment` and the
   * form will hydrate every field. Omit for Add.
   */
  initial?: TrainWithAssignment;
  /** Called with a fully-validated payload — return value is unused here. */
  onSubmit: (input: TrainCreateInput) => Promise<void>;
  /** "Add train" / "Save changes". */
  submitLabel: string;
  onCancel: () => void;
}

export function TrainForm({
  initial,
  onSubmit,
  submitLabel,
  onCancel,
}: TrainFormProps) {
  const formId = useId();
  const [values, setValues] = useState<TrainFormValues>(() =>
    initial ? hydrate(initial) : EMPTY,
  );
  const [errors, setErrors] = useState<Partial<Record<keyof TrainFormValues, string>>>({});
  const [pending, setPending] = useState(false);

  // Keep form in sync if the parent swaps `initial` mid-mount (e.g. user
  // closes Edit modal then re-opens for a different row).
  useEffect(() => {
    setValues(initial ? hydrate(initial) : EMPTY);
    setErrors({});
  }, [initial]);

  function patch<K extends keyof TrainFormValues>(key: K, value: TrainFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  }

  function toggleDay(day: DayOfWeek) {
    setValues((v) => {
      const next = v.runsOnDays.includes(day)
        ? v.runsOnDays.filter((d) => d !== day)
        : [...v.runsOnDays, day];
      // Preserve canonical (Sun→Sat) order so the persisted list is stable.
      next.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
      return { ...v, runsOnDays: next };
    });
    setErrors((e) => {
      if (!e.runsOnDays) return e;
      const { runsOnDays: _drop, ...rest } = e;
      return rest;
    });
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
      await onSubmit({
        number: values.number.trim(),
        name: values.name.trim(),
        type: values.type,
        onwardFromStation: values.onwardFromStation.trim(),
        onwardToStation: values.onwardToStation.trim(),
        runsOnDays: values.runsOnDays,
        departureTimeOfDay: values.departureTimeOfDay,
        inwardTrainNumber: values.inwardTrainNumber.trim(),
        inwardFromStation: values.inwardFromStation.trim(),
        inwardToStation: values.inwardToStation.trim(),
        inwardArrivalTimeOfDay: values.inwardArrivalTimeOfDay,
        inwardArrivalDayOffset: values.inwardArrivalDayOffset,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form id={formId} className="train-form" onSubmit={handleSubmit} noValidate>
      <FormField label="Train number" required error={errors.number}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={values.number}
            onChange={(e) => patch('number', e.currentTarget.value)}
            invalid={!!errors.number}
            placeholder="e.g. 12951"
          />
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
            placeholder="e.g. Mumbai Rajdhani"
          />
        )}
      </FormField>

      <FormField label="Type" required error={errors.type}>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={values.type}
            onChange={(e) =>
              patch('type', e.currentTarget.value as TrainType)
            }
            invalid={!!errors.type}
          >
            {Object.values(TrainType).map((t) => (
              <option key={t} value={t}>
                {longFormLabel(t)}
              </option>
            ))}
          </Select>
        )}
      </FormField>

      <div className="train-form__row">
        <FormField label="Onward — from" required error={errors.onwardFromStation}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={values.onwardFromStation}
              onChange={(e) =>
                patch('onwardFromStation', e.currentTarget.value)
              }
              invalid={!!errors.onwardFromStation}
              placeholder="BCT"
            />
          )}
        </FormField>
        <FormField label="Onward — to" required error={errors.onwardToStation}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={values.onwardToStation}
              onChange={(e) =>
                patch('onwardToStation', e.currentTarget.value)
              }
              invalid={!!errors.onwardToStation}
              placeholder="NDLS"
            />
          )}
        </FormField>
      </div>

      <FormField label="Runs on" required error={errors.runsOnDays}>
        {({ describedBy }) => (
          <div
            className="train-form__day-row"
            role="group"
            aria-describedby={describedBy}
          >
            {DAY_ORDER.map((day) => {
              const checked = values.runsOnDays.includes(day);
              return (
                <label
                  key={day}
                  className={`train-form__day${checked ? ' train-form__day--on' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleDay(day)}
                  />
                  <span>{DAY_LABEL[day]}</span>
                </label>
              );
            })}
          </div>
        )}
      </FormField>

      <FormField
        label="Departure (IST)"
        required
        error={errors.departureTimeOfDay}
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="time"
            value={values.departureTimeOfDay}
            onChange={(e) => patch('departureTimeOfDay', e.currentTarget.value)}
            invalid={!!errors.departureTimeOfDay}
            required
          />
        )}
      </FormField>

      <div className="train-form__row">
        <FormField label="Inward train number" required error={errors.inwardTrainNumber}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={values.inwardTrainNumber}
              onChange={(e) =>
                patch('inwardTrainNumber', e.currentTarget.value)
              }
              invalid={!!errors.inwardTrainNumber}
              placeholder="e.g. 12952"
            />
          )}
        </FormField>
      </div>

      <div className="train-form__row">
        <FormField label="Inward — from" required error={errors.inwardFromStation}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={values.inwardFromStation}
              onChange={(e) =>
                patch('inwardFromStation', e.currentTarget.value)
              }
              invalid={!!errors.inwardFromStation}
              placeholder="NDLS"
            />
          )}
        </FormField>
        <FormField label="Inward — to" required error={errors.inwardToStation}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={values.inwardToStation}
              onChange={(e) =>
                patch('inwardToStation', e.currentTarget.value)
              }
              invalid={!!errors.inwardToStation}
              placeholder="BCT"
            />
          )}
        </FormField>
      </div>

      <div className="train-form__row">
        <FormField
          label="Inward arrival (IST)"
          required
          error={errors.inwardArrivalTimeOfDay}
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="time"
              value={values.inwardArrivalTimeOfDay}
              onChange={(e) =>
                patch('inwardArrivalTimeOfDay', e.currentTarget.value)
              }
              invalid={!!errors.inwardArrivalTimeOfDay}
              required
            />
          )}
        </FormField>
        <FormField
          label="Inward arrival day"
          required
          error={errors.inwardArrivalDayOffset}
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={String(values.inwardArrivalDayOffset)}
              onChange={(e) =>
                patch(
                  'inwardArrivalDayOffset',
                  Number.parseInt(e.currentTarget.value, 10),
                )
              }
              invalid={!!errors.inwardArrivalDayOffset}
            >
              {ARRIVAL_DAY_OPTIONS.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>

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

function hydrate(t: TrainWithAssignment): TrainFormValues {
  return {
    number: t.number,
    name: t.name,
    type: t.type,
    onwardFromStation: t.onwardFromStation,
    onwardToStation: t.onwardToStation,
    runsOnDays: [...t.runsOnDays],
    departureTimeOfDay: t.departureTimeOfDay,
    inwardTrainNumber: t.inwardTrainNumber,
    inwardFromStation: t.inwardFromStation,
    inwardToStation: t.inwardToStation,
    inwardArrivalTimeOfDay: t.inwardArrivalTimeOfDay,
    inwardArrivalDayOffset: t.inwardArrivalDayOffset,
  };
}

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(v: TrainFormValues): Partial<Record<keyof TrainFormValues, string>> {
  const e: Partial<Record<keyof TrainFormValues, string>> = {};
  if (!v.number.trim()) e.number = 'Required.';
  if (!v.name.trim()) e.name = 'Required.';
  if (!v.onwardFromStation.trim()) e.onwardFromStation = 'Required.';
  if (!v.onwardToStation.trim()) e.onwardToStation = 'Required.';
  if (!v.inwardTrainNumber.trim()) e.inwardTrainNumber = 'Required.';
  if (!v.inwardFromStation.trim()) e.inwardFromStation = 'Required.';
  if (!v.inwardToStation.trim()) e.inwardToStation = 'Required.';
  if (v.runsOnDays.length === 0) e.runsOnDays = 'Pick at least one day.';
  if (!TIME_OF_DAY_RE.test(v.departureTimeOfDay)) {
    e.departureTimeOfDay = 'Required (HH:MM).';
  }
  if (!TIME_OF_DAY_RE.test(v.inwardArrivalTimeOfDay)) {
    e.inwardArrivalTimeOfDay = 'Required (HH:MM).';
  }
  if (
    !Number.isInteger(v.inwardArrivalDayOffset) ||
    v.inwardArrivalDayOffset < 0 ||
    v.inwardArrivalDayOffset > 3
  ) {
    e.inwardArrivalDayOffset = 'Pick an arrival day.';
  }

  // Probe-materialization invariant: when both times + offset are valid,
  // ensure arrival > departure on a synthetic date. Mirrors the orchestrator's
  // per-run check, surfaced before the round-trip.
  if (
    !e.departureTimeOfDay &&
    !e.inwardArrivalTimeOfDay &&
    !e.inwardArrivalDayOffset
  ) {
    const probe = '2026-01-04'; // any Sunday
    const dep = new Date(`${probe}T${v.departureTimeOfDay}:00+05:30`).getTime();
    const arrDate = addDaysIso(probe, v.inwardArrivalDayOffset);
    const arr = new Date(`${arrDate}T${v.inwardArrivalTimeOfDay}:00+05:30`).getTime();
    if (!(arr > dep)) {
      e.inwardArrivalTimeOfDay = 'Arrival must be after departure.';
    }
  }
  return e;
}

function addDaysIso(isoDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(utc + days * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

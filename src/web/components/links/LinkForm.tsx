// `LinkForm` — shared form behind Add/Edit Link modals (HLD §4.9 / LLD §5.5).
//
// Phase 1 simplification: `positions` is captured as a JSON textarea. The
// rich position editor is planned for Phase 2 — keeping it textual here
// lets operators paste a real link cycle straight from a design doc.

import { useEffect, useId, useMemo, useState } from 'react';
import { LpCategory } from '../../../domain/types';
import type {
  LinkCreateInput,
  LinkRow,
  LinkUpdateInput,
} from '../../../shared/schemas';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { Input } from '../primitives/Input';
import { Select } from '../primitives/Select';

export type LinkFormMode = 'add' | 'edit';

type CrewRole = 'LP' | 'ALP';

interface LinkFormValues {
  name: string;
  crewRole: CrewRole;
  lpCategory: '' | LpCategory.MAIL_EXPRESS | LpCategory.PASSENGER;
  cycleLength: string;
  positionsJson: string;
}

const EMPTY: LinkFormValues = {
  name: '',
  crewRole: 'LP',
  lpCategory: '',
  cycleLength: '',
  positionsJson: '',
};

export interface LinkFormProps {
  mode: LinkFormMode;
  initial?: LinkRow;
  onSubmit: (
    payload:
      | { kind: 'CREATE'; data: LinkCreateInput }
      | { kind: 'UPDATE'; data: LinkUpdateInput },
  ) => Promise<void>;
  submitLabel: string;
  onCancel: () => void;
}

export function LinkForm({
  mode,
  initial,
  onSubmit,
  submitLabel,
  onCancel,
}: LinkFormProps) {
  const formId = useId();
  const [values, setValues] = useState<LinkFormValues>(() =>
    initial ? hydrate(initial) : EMPTY,
  );
  const [errors, setErrors] = useState<Partial<Record<keyof LinkFormValues, string>>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (initial) setValues(hydrate(initial));
  }, [initial]);

  const showLpCategory = values.crewRole === 'LP';

  const positionsPreview = useMemo(() => {
    if (values.positionsJson.trim() === '') return null;
    try {
      const parsed = JSON.parse(values.positionsJson);
      if (!Array.isArray(parsed)) return 'positions must be a JSON array';
      return `Parsed: ${parsed.length} position(s)`;
    } catch (e) {
      return `Invalid JSON: ${(e as Error).message}`;
    }
  }, [values.positionsJson]);

  function patch<K extends keyof LinkFormValues>(key: K, value: LinkFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _drop, ...rest } = e;
      return rest;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    if (!values.name.trim()) next.name = 'Name is required';
    const cycleLength = Number(values.cycleLength);
    if (!Number.isInteger(cycleLength) || cycleLength < 1) {
      next.cycleLength = 'Must be a positive integer';
    }
    let positions: unknown = null;
    if (values.positionsJson.trim() === '') {
      next.positionsJson = 'Positions JSON is required';
    } else {
      try {
        positions = JSON.parse(values.positionsJson);
      } catch (e) {
        next.positionsJson = `Invalid JSON: ${(e as Error).message}`;
      }
      if (!next.positionsJson && !Array.isArray(positions)) {
        next.positionsJson = 'Positions must be a JSON array';
      }
      if (
        !next.positionsJson &&
        Array.isArray(positions) &&
        positions.length !== cycleLength
      ) {
        next.positionsJson = `Positions length (${positions.length}) must equal cycleLength (${cycleLength})`;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setPending(true);
    try {
      if (mode === 'add') {
        const payload: LinkCreateInput = {
          name: values.name.trim(),
          crewRole: values.crewRole,
          cycleLength,
          positions: positions as LinkCreateInput['positions'],
          ...(showLpCategory && values.lpCategory !== ''
            ? { lpCategory: values.lpCategory }
            : {}),
        };
        await onSubmit({ kind: 'CREATE', data: payload });
      } else {
        const updatePatch: LinkUpdateInput = {
          name: values.name.trim(),
          crewRole: values.crewRole,
          cycleLength,
          positions: positions as LinkUpdateInput['positions'],
          lpCategory: showLpCategory && values.lpCategory !== '' ? values.lpCategory : null,
        };
        await onSubmit({ kind: 'UPDATE', data: updatePatch });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form id={formId} className="link-form" onSubmit={handleSubmit} noValidate>
      <FormField label="Name" required error={errors.name}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={values.name}
            onChange={(e) => patch('name', e.currentTarget.value)}
            placeholder="CBE MAIL LINK — 19 MEN"
            invalid={!!errors.name}
            autoFocus
          />
        )}
      </FormField>

      <FormField label="Crew role" required>
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={values.crewRole}
            onChange={(e) => patch('crewRole', e.currentTarget.value as CrewRole)}
          >
            <option value="LP">LP</option>
            <option value="ALP">ALP</option>
          </Select>
        )}
      </FormField>

      {showLpCategory ? (
        <FormField label="LP category (optional)" error={errors.lpCategory}>
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={values.lpCategory}
              onChange={(e) =>
                patch('lpCategory', e.currentTarget.value as LinkFormValues['lpCategory'])
              }
            >
              <option value="">— Any LP —</option>
              <option value={LpCategory.MAIL_EXPRESS}>Mail Express</option>
              <option value={LpCategory.PASSENGER}>Passenger</option>
            </Select>
          )}
        </FormField>
      ) : null}

      <FormField label="Cycle length" required error={errors.cycleLength}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="number"
            min={1}
            step={1}
            aria-describedby={describedBy}
            value={values.cycleLength}
            onChange={(e) => patch('cycleLength', e.currentTarget.value)}
            placeholder="19"
            invalid={!!errors.cycleLength}
          />
        )}
      </FormField>

      <FormField
        label="Positions (JSON)"
        required
        error={errors.positionsJson}
        hint={
          positionsPreview ??
          'Array of { positionNumber, kind: "DUTY" | "OFF" | "PR", segments? }. See LLD §2.1.'
        }
      >
        {({ id, describedBy }) => (
          <textarea
            id={id}
            aria-describedby={describedBy}
            className="link-form__positions"
            value={values.positionsJson}
            rows={12}
            onChange={(e) => patch('positionsJson', e.currentTarget.value)}
            placeholder={'[\n  { "positionNumber": 1, "kind": "DUTY", "segments": [\n    { "trainNumber": "12677", "signOnTimeOfDay": "21:30", "signOffTimeOfDay": "06:30", "signOffDayOffset": 1 }\n  ]},\n  { "positionNumber": 2, "kind": "OFF" }\n]'}
            spellCheck={false}
          />
        )}
      </FormField>

      <div className="link-form__actions">
        <Button variant="text" type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function hydrate(row: LinkRow): LinkFormValues {
  return {
    name: row.name,
    crewRole: row.crewRole,
    lpCategory: (row.lpCategory ?? '') as LinkFormValues['lpCategory'],
    cycleLength: String(row.cycleLength),
    positionsJson: JSON.stringify(row.positions, null, 2),
  };
}

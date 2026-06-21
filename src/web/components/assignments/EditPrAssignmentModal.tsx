// `EditPrAssignmentModal` — pick (or clear) crew for one PR slot.
//
// Direct-save (no draft cart): clicking Save calls `PUT /api/pr-assignments`
// immediately; Clear calls `DELETE`. The parent re-fetches on close so the
// table reflects the new state.

import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpsApi,
  locoPilots as lpsApi,
  prAssignments as prApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type { CrewRow, PrAssignmentRow } from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { Select } from '../primitives/Select';
import { Modal } from '../overlay/Modal';

export interface EditPrAssignmentModalProps {
  target: PrAssignmentRow | null;
  runDate: string;
  onClose: () => void;
  onSaved: () => void;
}

const NO_PR = '__NO_PR__';
const USE_DEFAULT = '__USE_DEFAULT__';

export function EditPrAssignmentModal({
  target,
  runDate,
  onClose,
  onSaved,
}: EditPrAssignmentModalProps) {
  const [crew, setCrew] = useState<CrewRow[] | null>(null);
  const [selection, setSelection] = useState<string>(USE_DEFAULT);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the active crew of the right role once the modal opens.
  useEffect(() => {
    if (!target) return;
    setCrew(null);
    setServerError(null);

    const initial = target.override
      ? target.override.crewId
        ? target.override.crewId
        : NO_PR
      : USE_DEFAULT;
    setSelection(initial);

    let cancelled = false;
    const loader =
      target.crewRole === 'LP' ? lpsApi.list(runDate) : alpsApi.list(runDate);
    loader
      .then((data) => {
        if (cancelled) return;
        setCrew(data.filter((c) => c.kind === target.crewRole));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setServerError(
          e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        );
        setCrew([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target, runDate]);

  const sortedCrew = useMemo(() => {
    if (!crew) return [] as CrewRow[];
    return crew.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [crew]);

  if (!target) return null;

  async function handleSave() {
    if (!target) return;
    setSaving(true);
    setServerError(null);
    try {
      if (selection === USE_DEFAULT) {
        if (target.override) {
          await prApi.remove({
            linkId: target.linkId,
            positionNumber: target.positionNumber,
            runDate,
          });
        }
      } else {
        const crewId = selection === NO_PR ? '' : selection;
        await prApi.upsert({
          linkId: target.linkId,
          positionNumber: target.positionNumber,
          runDate,
          crewRole: target.crewRole,
          crewId,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setServerError(
        e instanceof ApiError ? describeApiError(e) : (e as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  const subtitle = `${target.linkName} · PR position ${target.positionNumber}`;

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title="Edit Periodic Rest"
      subtitle={subtitle}
      footer={
        <>
          <Button variant="text" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {serverError ? (
        <Banner tone="error" title="Couldn't save">
          {serverError}
        </Banner>
      ) : null}

      <FormField
        label={`${target.crewRole} on PR`}
        hint="Leave on default to follow the link rotation. Pick a crew member to override, or choose “No PR today” to suppress it."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            disabled={crew === null || saving}
          >
            <option value={USE_DEFAULT}>
              Default ({target.defaultCrew ? target.defaultCrew.name : 'no rotation match'})
            </option>
            <option value={NO_PR}>No PR today (clear)</option>
            <optgroup label={`${target.crewRole}s`}>
              {sortedCrew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </Select>
        )}
      </FormField>
    </Modal>
  );
}

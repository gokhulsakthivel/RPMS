// `AssignCrewModal` — "the heart of the app" (design.md §9.3).
//
// Workflow:
//   1. Modal opens with a `trainId`. Fetch `/api/eligible-crew?trainId=…`.
//   2. Render two pre-filtered dropdowns (LP + optional ALP) plus a
//      `HiddenCrewFootnote` under each.
//   3. For MEMU/DEMU trains the ALP slot is omitted entirely
//      (`response.assistant_loco_pilots === null`) — there's no slot to fill.
//   4. Submit → POST `/api/assignments`. Success closes; rule errors render
//      as a Banner inside the modal so the operator can pick differently.

import { useEffect, useState } from 'react';
import {
  ApiError,
  assignments as assignmentsApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type {
  AssignmentRow,
  EligibleCrewResponse,
} from '../../../shared/schemas';
import { Banner } from '../feedback/Banner';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { Modal } from '../overlay/Modal';
import { TrainTypeBadge } from '../trains/TrainTypeBadge';
import { formatIst } from '../../lib/time';
import { EligibleCrewSelect } from './EligibleCrewSelect';
import { HiddenCrewFootnote } from './HiddenCrewFootnote';

export interface AssignCrewModalProps {
  /** Open iff non-null. Carries the train identifier + display fields. */
  target: AssignmentRow | null;
  onClose: () => void;
  onAssigned: () => void;
}

export function AssignCrewModal({
  target,
  onClose,
  onAssigned,
}: AssignCrewModalProps) {
  const [eligible, setEligible] = useState<EligibleCrewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [lpId, setLpId] = useState<string | null>(null);
  const [alpId, setAlpId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset transient state on each open.
  useEffect(() => {
    if (!target) return;
    setLpId(null);
    setAlpId(null);
    setServerError(null);
    setEligible(null);

    let cancelled = false;
    setLoading(true);
    // M9 — eligibility is per-run-date. The page passes the selected date in
    // via `target.runDate`, so the modal never has to know about the date
    // picker; the AssignmentRow it was opened from is the single source.
    assignmentsApi
      .eligibleCrew(target.trainId, target.runDate)
      .then((data) => {
        if (cancelled) return;
        setEligible(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setServerError(
          e instanceof ApiError
            ? describeApiError(e)
            : (e as Error).message,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  function close() {
    setServerError(null);
    onClose();
  }

  async function submit() {
    if (!target || !lpId) return;
    setServerError(null);
    setSubmitting(true);
    try {
      await assignmentsApi.create({
        trainId: target.trainId,
        // M9 — assignments are keyed by `(trainId, runDate)`; the orchestrator
        // re-materializes departure / sign-off from the train schedule, so the
        // SPA never sends absolute UTC instants.
        runDate: target.runDate,
        lpId,
        // The eligibleCrew response tells us whether the ALP slot exists.
        // Only include `alpId` when the slot is required AND the user picked.
        ...(eligible?.assistant_loco_pilots && alpId ? { alpId } : {}),
      });
      onAssigned();
    } catch (e) {
      if (e instanceof ApiError) {
        setServerError(describeApiError(e));
      } else {
        setServerError((e as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Derived guards for the submit button.
  const requiresAlp = !!eligible?.assistant_loco_pilots;
  const canSubmit =
    !!target &&
    !loading &&
    !!eligible &&
    !!lpId &&
    (!requiresAlp || !!alpId) &&
    !submitting;

  return (
    <Modal
      open={target !== null}
      onClose={close}
      title="Assign crew"
      size="assign"
      closeOnBackdrop={false}
      subtitle={
        target
          ? `${target.trainNumber} · ${target.trainName}`
          : undefined
      }
      footer={
        <>
          <Button variant="text" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="cta"
            fullWidth
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? 'Assigning…' : 'Assign'}
          </Button>
        </>
      }
    >
      {target ? (
        <div className="assign-modal__head">
          <TrainTypeBadge type={target.trainType} />
          <time dateTime={target.departureTime} className="assign-modal__time">
            Departs {formatIst(new Date(target.departureTime))}
          </time>
        </div>
      ) : null}

      {serverError ? (
        <Banner tone="error" title="Couldn't assign crew">
          {serverError}
        </Banner>
      ) : null}

      {loading ? (
        <p className="assign-modal__loading">Loading eligible crew…</p>
      ) : eligible ? (
        <>
          <FormField label="Loco Pilot" required>
            {({ id }) => (
              <>
                <EligibleCrewSelect
                  id={id}
                  options={eligible.loco_pilots.eligible}
                  value={lpId}
                  onChange={setLpId}
                />
                <HiddenCrewFootnote counts={eligible.loco_pilots.hidden} />
              </>
            )}
          </FormField>

          {eligible.assistant_loco_pilots ? (
            <FormField label="Assistant Loco Pilot" required>
              {({ id }) => (
                <>
                  <EligibleCrewSelect
                    id={id}
                    options={eligible.assistant_loco_pilots!.eligible}
                    value={alpId}
                    onChange={setAlpId}
                  />
                  <HiddenCrewFootnote
                    counts={eligible.assistant_loco_pilots!.hidden}
                  />
                </>
              )}
            </FormField>
          ) : (
            <p className="assign-modal__no-alp">
              {longTrainTypeName(target?.trainType)} trains do not require an ALP.
            </p>
          )}
        </>
      ) : null}
    </Modal>
  );
}

function longTrainTypeName(t?: string): string {
  switch (t) {
    case 'MEMU': return 'MEMU';
    case 'DEMU': return 'DEMU';
    default: return 'These';
  }
}

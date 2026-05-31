// `EditAssignmentModal` — Edit an existing assignment's LP / ALP
// (components.md §10 / design.md §9.3).
//
// Mirrors the AssignCrewModal flow: open with an `AssignmentRow` (whose
// `assignmentId` is non-null), fetch eligible crew for that train + runDate,
// pre-select the currently-assigned LP / ALP, and let the operator pick
// replacements.
//
// Staging semantics (M-staging): every selection change updates LOCAL
// component state ONLY. **Save emits a `'update'` op into the page-level
// draft cart — it does NOT call PUT /api/assignments/:id.** Persistence
// happens only when the operator clicks the toolbar "+ Assign" button on
// the page, which drains every staged op into the appropriate REST
// endpoint.
//
// Pre-fill: if the operator already has an `'update'` op staged for this
// assignment and re-opens the modal, `initialLpId` / `initialAlpId`
// repopulate the form so the existing draft is editable in place.

import { useEffect, useState } from 'react';
import {
  ApiError,
  assignments as assignmentsApi,
} from '../../lib/api';
import { describeApiError } from '../../lib/errors';
import type {
  AssignmentRow,
  EligibleCrewResponse,
  LpSummary,
} from '../../../shared/schemas';
import { formatIst } from '../../lib/time';
import { Banner } from '../feedback/Banner';
import { Modal } from '../overlay/Modal';
import { Button } from '../primitives/Button';
import { FormField } from '../primitives/FormField';
import { TrainTypeBadge } from '../trains/TrainTypeBadge';
import { EligibleCrewSelect } from './EligibleCrewSelect';
import { HiddenCrewFootnote } from './HiddenCrewFootnote';
import {
  type StagedOp,
  type StagedUpdate,
  stagedCrewIds,
} from './stagedAssignments';

export interface EditAssignmentModalProps {
  /** Open iff non-null. Carries the assignment + train identity. */
  target: AssignmentRow | null;
  /** Pre-selected LP — used when re-editing an already-staged draft. */
  initialLpId?: string | null;
  /** Pre-selected ALP — used when re-editing an already-staged draft. */
  initialAlpId?: string | null;
  /** Pre-selected second ALP (Amrit Bharat) — used when re-editing a draft. */
  initialAlpId2?: string | null;
  /**
   * The page-level draft cart. Used to hide crew already claimed by
   * staged ops on OTHER trains so the operator never offers the same
   * person twice. The current train's own staged op is excluded so
   * re-opening Edit on a draft row keeps that draft's picks visible.
   */
  staged?: ReadonlyMap<string, StagedOp>;
  onClose: () => void;
  /**
   * Called when the operator clicks Save with a non-empty diff. Emits an
   * `'update'` op the page can insert into the draft cart. A no-op edit
   * (no fields changed) closes via `onClose` without emitting.
   */
  onStage: (op: StagedUpdate) => void;
}

export function EditAssignmentModal({
  target,
  initialLpId,
  initialAlpId,
  initialAlpId2,
  staged,
  onClose,
  onStage,
}: EditAssignmentModalProps) {
  const [eligible, setEligible] = useState<EligibleCrewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Local form state — buffered. Initial values pulled from the staged
  // draft (if present) or from `target` (the persisted row) so the
  // currently-assigned crew show as pre-selected.
  const [lpId, setLpId] = useState<string | null>(null);
  const [alpId, setAlpId] = useState<string | null>(null);
  const [alpId2, setAlpId2] = useState<string | null>(null);

  // Resolve the form's "initial" state — the staged draft wins over the
  // persisted row when both exist.
  const baselineLpId =
    initialLpId !== undefined && initialLpId !== null
      ? initialLpId
      : target?.lp
        ? target.lp.id
        : null;
  const baselineAlpId =
    initialAlpId !== undefined && initialAlpId !== null
      ? initialAlpId
      : target && target.alp && target.alp !== 'NOT_REQUIRED'
        ? target.alp.id
        : null;
  const baselineAlpId2 =
    initialAlpId2 !== undefined && initialAlpId2 !== null
      ? initialAlpId2
      : target && target.alp2 && target.alp2 !== 'NOT_REQUIRED'
        ? target.alp2.id
        : null;

  // Reset transient state on each open.
  useEffect(() => {
    if (!target || !target.assignmentId) return;
    setServerError(null);
    setEligible(null);
    setLpId(baselineLpId);
    setAlpId(baselineAlpId);

    let cancelled = false;
    setLoading(true);
    assignmentsApi
      .eligibleCrew(target.trainId, target.runDate)
      .then((data) => {
        if (cancelled) return;
        setEligible(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setServerError(
          e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-run when the assignmentId changes — intentionally not the whole row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.assignmentId, target?.trainId, target?.runDate]);

  function close() {
    setServerError(null);
    onClose();
  }

  function reset() {
    // Reset buffered picks back to the modal's baseline. For a fresh edit
    // that's the persisted crew; for a re-edit it's the originally-staged
    // values.
    setLpId(baselineLpId);
    setAlpId(baselineAlpId);
    setAlpId2(baselineAlpId2);
    setServerError(null);
  }

  function save() {
    if (!target || !target.assignmentId || !lpId || !eligible) return;

    // No-op edit — nothing changed relative to whatever's persisted on
    // the row. Close without emitting an op so the draft cart stays clean.
    const persistedLpId = target.lp ? target.lp.id : null;
    const persistedAlpId =
      target.alp && target.alp !== 'NOT_REQUIRED' ? target.alp.id : null;
    const persistedAlpId2 =
      target.alp2 && target.alp2 !== 'NOT_REQUIRED' ? target.alp2.id : null;
    if (
      lpId === persistedLpId &&
      alpId === persistedAlpId &&
      alpId2 === persistedAlpId2
    ) {
      onClose();
      return;
    }

    // Resolve the picked LP/ALP to display names. Re-use the same
    // "fall back to the currently-assigned crew" trick as the dropdown
    // options so a no-change LP still resolves.
    const lpOpt =
      eligible.loco_pilots.eligible.find((o) => o.id === lpId) ??
      (target.lp && target.lp.id === lpId
        ? { id: target.lp.id, name: target.lp.name, grade: null, restHoursRemaining: 0 }
        : null);
    if (!lpOpt) {
      setServerError('Selected Loco Pilot is no longer eligible. Please reselect.');
      return;
    }
    const alpOpt =
      eligible.assistant_loco_pilots && alpId
        ? eligible.assistant_loco_pilots.eligible.find((o) => o.id === alpId) ??
          (target.alp && target.alp !== 'NOT_REQUIRED' && target.alp.id === alpId
            ? { id: target.alp.id, name: target.alp.name, grade: null, restHoursRemaining: 0 }
            : null)
        : null;
    const alp2Opt =
      eligible.assistant_loco_pilots?.requiredCount === 2 && alpId2
        ? eligible.assistant_loco_pilots.eligible.find((o) => o.id === alpId2) ??
          (target.alp2 && target.alp2 !== 'NOT_REQUIRED' && target.alp2.id === alpId2
            ? { id: target.alp2.id, name: target.alp2.name, grade: null, restHoursRemaining: 0 }
            : null)
        : null;

    onStage({
      kind: 'update',
      assignmentId: target.assignmentId,
      trainId: target.trainId,
      trainNumber: target.trainNumber,
      trainName: target.trainName,
      trainType: target.trainType,
      runDate: target.runDate,
      departureTime: target.departureTime,
      originalLpName: target.lp ? target.lp.name : '',
      originalAlpName:
        target.alp && target.alp !== 'NOT_REQUIRED' ? target.alp.name : null,
      originalAlpName2:
        target.alp2 && target.alp2 !== 'NOT_REQUIRED' ? target.alp2.name : null,
      lpId: lpOpt.id,
      lpName: lpOpt.name,
      alpId: alpOpt ? alpOpt.id : null,
      alpName: alpOpt ? alpOpt.name : null,
      alpId2: alp2Opt ? alp2Opt.id : null,
      alpName2: alp2Opt ? alp2Opt.name : null,
    });
  }

  const requiresAlp = !!eligible?.assistant_loco_pilots;
  const requiresTwoAlps =
    eligible?.assistant_loco_pilots?.requiredCount === 2;
  const canSave =
    !!target &&
    !!target.assignmentId &&
    !loading &&
    !!eligible &&
    !!lpId &&
    (!requiresAlp || !!alpId) &&
    (!requiresTwoAlps || !!alpId2);
  const canReset =
    lpId !== baselineLpId ||
    alpId !== baselineAlpId ||
    alpId2 !== baselineAlpId2;

  // Crew already claimed by staged ops on OTHER trains. We exclude the
  // current train's own op so re-editing a draft doesn't make its own
  // picks vanish from the dropdown.
  const claimed = staged
    ? stagedCrewIds(staged, target?.trainId)
    : { lpIds: new Set<string>(), alpIds: new Set<string>() };

  // Eligible options must include the currently-assigned crew member as a
  // selectable option even though server-side filtering may have removed
  // them (already-assigned-to-this-train would show them as "hidden"). We
  // synthesize a fallback option from `target.lp` / `target.alp` so the
  // pre-selection is never empty in the dropdown.
  //
  // Order matters: filter staged-claimed FIRST, then re-inject the current
  // crew of THIS train. That way a crew member staged on another train is
  // hidden, but THIS train's own persisted crew is always selectable.
  const eligibleLp = eligible?.loco_pilots.eligible ?? [];
  const eligibleAlp = eligible?.assistant_loco_pilots?.eligible ?? [];
  const filteredLp = eligibleLp.filter((o) => !claimed.lpIds.has(o.id));
  const filteredAlp = eligibleAlp.filter((o) => !claimed.alpIds.has(o.id));
  // ALP-1 / ALP-2 must additionally hide whoever is picked in the OTHER
  // ALP slot so the operator can never assign the same person twice.
  const filteredAlp1 = filteredAlp.filter((o) => o.id !== alpId2);
  const filteredAlp2 = filteredAlp.filter((o) => o.id !== alpId);
  const lpStagedHidden = eligibleLp.length - filteredLp.length;
  const alpStagedHidden = eligibleAlp.length - filteredAlp1.length;
  const alp2StagedHidden = eligibleAlp.length - filteredAlp2.length;
  const lpOptions = withCurrentSelection(filteredLp, target?.lp ?? null);
  const alpOptions = withCurrentSelection(
    filteredAlp1,
    target && target.alp !== 'NOT_REQUIRED' ? target.alp : null,
  );
  const alp2Options = withCurrentSelection(
    filteredAlp2,
    target && target.alp2 !== 'NOT_REQUIRED' ? target.alp2 : null,
  );

  return (
    <Modal
      open={target !== null && target.assignmentId !== null}
      onClose={close}
      title="Edit assignment"
      size="assign"
      closeOnBackdrop={false}
      subtitle={
        target ? `${target.trainNumber} · ${target.trainName}` : undefined
      }
      footer={
        <>
          <Button variant="text" onClick={close}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={reset} disabled={!canReset}>
            Reset
          </Button>
          <Button
            variant="primary"
            size="cta"
            fullWidth
            onClick={save}
            disabled={!canSave}
          >
            Save
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
        <Banner tone="error" title="Couldn't update assignment">
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
                  options={lpOptions}
                  value={lpId}
                  onChange={setLpId}
                />
                <HiddenCrewFootnote
                  counts={{
                    ...eligible.loco_pilots.hidden,
                    alreadyAssigned:
                      eligible.loco_pilots.hidden.alreadyAssigned +
                      lpStagedHidden,
                  }}
                />
              </>
            )}
          </FormField>

          {eligible.assistant_loco_pilots ? (
            <FormField
              label={
                requiresTwoAlps
                  ? 'Assistant Loco Pilot 1'
                  : 'Assistant Loco Pilot'
              }
              required
            >
              {({ id }) => (
                <>
                  <EligibleCrewSelect
                    id={id}
                    options={alpOptions}
                    value={alpId}
                    onChange={setAlpId}
                  />
                  <HiddenCrewFootnote
                    counts={{
                      ...eligible.assistant_loco_pilots!.hidden,
                      alreadyAssigned:
                        eligible.assistant_loco_pilots!.hidden.alreadyAssigned +
                        alpStagedHidden,
                    }}
                  />
                </>
              )}
            </FormField>
          ) : (
            <p className="assign-modal__no-alp">
              {longTrainTypeName(target?.trainType)} trains do not require an ALP.
            </p>
          )}

          {requiresTwoAlps ? (
            <FormField label="Assistant Loco Pilot 2" required>
              {({ id }) => (
                <>
                  <EligibleCrewSelect
                    id={id}
                    options={alp2Options}
                    value={alpId2}
                    onChange={setAlpId2}
                  />
                  <HiddenCrewFootnote
                    counts={{
                      ...eligible.assistant_loco_pilots!.hidden,
                      alreadyAssigned:
                        eligible.assistant_loco_pilots!.hidden.alreadyAssigned +
                        alp2StagedHidden,
                    }}
                  />
                </>
              )}
            </FormField>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

/**
 * Inject the currently-selected crew member into the option list if the
 * server's filter dropped them. The orchestrator's "already assigned"
 * bucket excludes a crew member from `eligible` even when they're THE
 * current holder of THIS assignment — without this fallback their name
 * would not be selectable in the Edit modal.
 */
function withCurrentSelection(
  options: ReadonlyArray<LpSummary>,
  current: { id: string; name: string } | null,
): ReadonlyArray<LpSummary> {
  if (!current) return options;
  if (options.some((o) => o.id === current.id)) return options;
  // Synthesise a minimal option. `grade: null` because we don't have the
  // crew row hydrated here; the dropdown still renders the name correctly.
  return [{ id: current.id, name: current.name, grade: null, restHoursRemaining: 0 }, ...options];
}

function longTrainTypeName(t?: string): string {
  switch (t) {
    case 'MEMU':
      return 'MEMU';
    case 'DEMU':
      return 'DEMU';
    default:
      return 'These';
  }
}

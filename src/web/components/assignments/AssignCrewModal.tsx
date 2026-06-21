// `AssignCrewModal` — "the heart of the app" (design.md §9.3).
//
// Workflow (M-staging):
//   1. Modal opens with a `trainId`. Fetch `/api/eligible-crew?trainId=…`.
//   2. Render two pre-filtered dropdowns (LP + optional ALP) plus a
//      `HiddenCrewFootnote` under each.
//   3. For MEMU/DEMU trains the ALP slot is omitted entirely
//      (`response.assistant_loco_pilots === null`) — there's no slot to fill.
//   4. **Save adds the picks to the page-level draft cart — it does NOT
//      POST to /api/assignments.** Persistence happens only when the
//      operator clicks the toolbar "+ Assign" button on the page, which
//      drains every staged op into the appropriate REST endpoint.
//
// Buffered semantics: the modal owns its own LP/ALP state until the
// operator clicks Save (or Reset / Cancel). On Save it emits a `StagedOp`
// of kind `'create'` via `onStage`. The parent decides what to do with
// it — typically: insert into the draft `Map<trainId, StagedOp>`.
//
// Pre-fill: if the operator already has a `'create'` op staged for this
// train and re-opens the modal, `initialLpId` / `initialAlpId` repopulate
// the form so the existing draft is editable in place.

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
import type { LinkSuggestion } from './linkSuggestions';
import {
  type StagedCreate,
  type StagedOp,
  stagedCrewIds,
} from './stagedAssignments';

export interface AssignCrewModalProps {
  /** Open iff non-null. Carries the train identifier + display fields. */
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
   * re-opening the modal on a draft row keeps that draft's picks visible.
   */
  staged?: ReadonlyMap<string, StagedOp>;
  /**
   * Phase 4 — Link-derived suggestion for this train + runDate. If both
   * provided and the suggested crew appear in the eligible list, the modal
   * pre-fills the dropdowns and surfaces a banner crediting the source link.
   * Ignored when an existing draft is being re-edited.
   */
  linkSuggestion?: LinkSuggestion | null;
  onClose: () => void;
  /**
   * Called when the operator clicks Save. Emits a `'create'` op carrying
   * everything the parent needs to a) display the draft in the table and
   * b) POST it on bulk-commit.
   */
  onStage: (op: StagedCreate) => void;
}

export function AssignCrewModal({
  target,
  initialLpId = null,
  initialAlpId = null,
  initialAlpId2 = null,
  staged,
  linkSuggestion = null,
  onClose,
  onStage,
}: AssignCrewModalProps) {
  const [eligible, setEligible] = useState<EligibleCrewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [lpId, setLpId] = useState<string | null>(null);
  const [alpId, setAlpId] = useState<string | null>(null);
  const [alpId2, setAlpId2] = useState<string | null>(null);

  // Reset transient state on each open and pre-fill from `initial*` if
  // provided (re-edit of an existing staged draft).
  useEffect(() => {
    if (!target) return;
    setLpId(initialLpId);
    setAlpId(initialAlpId);
    setAlpId2(initialAlpId2);
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
    // We deliberately key on `target?.trainId` rather than the whole row so
    // a parent refetch (which produces a new AssignmentRow object) doesn't
    // wipe the operator's in-flight picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.trainId, target?.runDate]);

  function close() {
    setServerError(null);
    onClose();
  }

  function reset() {
    // Clear buffered picks back to the modal's initial open-state. For a
    // fresh draft that's "no picks"; for a re-edit it's the originally-
    // staged values. The eligible-crew cache is preserved so the dropdowns
    // repopulate instantly.
    setLpId(initialLpId);
    setAlpId(initialAlpId);
    setAlpId2(initialAlpId2);
    setServerError(null);
  }

  // Crew already claimed by staged ops on OTHER trains. We exclude the
  // current train's own op so re-editing a draft doesn't make its own
  // picks vanish from the dropdown.
  const claimed = staged
    ? stagedCrewIds(staged, target?.trainId)
    : { lpIds: new Set<string>(), alpIds: new Set<string>() };

  // Filtered options + counts of how many we hid so the footnote can show
  // an accurate "already assigned" count (the server's count plus our
  // staged-but-not-yet-persisted picks).
  const eligibleLp = eligible?.loco_pilots.eligible ?? [];
  const eligibleAlp = eligible?.assistant_loco_pilots?.eligible ?? [];
  const requiredAlpCount = eligible?.assistant_loco_pilots?.requiredCount ?? 0;
  const lpOptions = eligibleLp.filter((o) => !claimed.lpIds.has(o.id));
  // First-ALP options exclude crew already claimed by other staged ops AND
  // anyone picked for the second-ALP slot on this same row.
  const alpOptions = eligibleAlp.filter(
    (o) => !claimed.alpIds.has(o.id) && o.id !== alpId2,
  );
  // Second-ALP options additionally exclude whoever was picked for the
  // first slot, so the operator can never assign the same person twice.
  const alp2Options = eligibleAlp.filter(
    (o) => !claimed.alpIds.has(o.id) && o.id !== alpId,
  );
  const lpStagedHidden = eligibleLp.length - lpOptions.length;
  const alpStagedHidden = eligibleAlp.length - alpOptions.length;
  const alp2StagedHidden = eligibleAlp.length - alp2Options.length;

  // Phase 4 — auto-apply link suggestion once eligibility resolves, but
  // only on a fresh draft (no `initial*Id`). We additionally require the
  // suggested crew to appear in the still-eligible-after-staged-filter
  // option list — otherwise we'd pre-fill an invalid pick. We also won't
  // overwrite an operator's in-progress edit (only run when buffered state
  // matches the unchanged baseline of `null`).
  const lpSuggestedAppliedId =
    linkSuggestion?.lp && lpOptions.some((o) => o.id === linkSuggestion.lp!.id)
      ? linkSuggestion.lp.id
      : null;
  const alpSuggestedAppliedId =
    linkSuggestion?.alp &&
    alpOptions.some((o) => o.id === linkSuggestion.alp!.id)
      ? linkSuggestion.alp.id
      : null;
  useEffect(() => {
    if (!eligible || !linkSuggestion) return;
    if (initialLpId == null && lpId == null && lpSuggestedAppliedId) {
      setLpId(lpSuggestedAppliedId);
    }
    if (
      initialAlpId == null &&
      alpId == null &&
      alpSuggestedAppliedId &&
      eligible.assistant_loco_pilots
    ) {
      setAlpId(alpSuggestedAppliedId);
    }
    // We intentionally exclude `lpId`/`alpId` from deps — this should fire
    // only when eligibility (or the suggestion itself) changes, never as a
    // reaction to the operator changing the dropdown back to empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, linkSuggestion, lpSuggestedAppliedId, alpSuggestedAppliedId]);

  function save() {
    if (!target || !lpId || !eligible) return;
    // Resolve the picked LP/ALP to their display names so the page table
    // can render the staged draft without re-fetching crew rows.
    const lpOpt = lpOptions.find((o) => o.id === lpId);
    if (!lpOpt) {
      setServerError('Selected Loco Pilot is no longer eligible. Please reselect.');
      return;
    }
    const alpOpt =
      eligible.assistant_loco_pilots && alpId
        ? alpOptions.find((o) => o.id === alpId) ?? null
        : null;
    const alp2Opt =
      eligible.assistant_loco_pilots?.requiredCount === 2 && alpId2
        ? alp2Options.find((o) => o.id === alpId2) ?? null
        : null;

    onStage({
      kind: 'create',
      trainId: target.trainId,
      trainNumber: target.trainNumber,
      trainName: target.trainName,
      trainType: target.trainType,
      runDate: target.runDate,
      departureTime: target.departureTime,
      lpId: lpOpt.id,
      lpName: lpOpt.name,
      alpId: alpOpt ? alpOpt.id : null,
      alpName: alpOpt ? alpOpt.name : null,
      alpId2: alp2Opt ? alp2Opt.id : null,
      alpName2: alp2Opt ? alp2Opt.name : null,
    });
    // Parent typically closes the modal in response. We don't call
    // onClose() here so the parent retains full control.
  }

  // Derived guards for the submit button.
  const requiresAlp = !!eligible?.assistant_loco_pilots;
  const requiresTwoAlps = requiredAlpCount === 2;
  const canSubmit =
    !!target &&
    !loading &&
    !!eligible &&
    !!lpId &&
    (!requiresAlp || !!alpId) &&
    (!requiresTwoAlps || !!alpId2);
  // Reset is only meaningful when the buffered picks differ from the
  // modal's initial values (fresh: both null; re-edit: originally staged).
  const canReset =
    lpId !== initialLpId || alpId !== initialAlpId || alpId2 !== initialAlpId2;

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
          <Button variant="text" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={reset}
            disabled={!canReset}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            size="cta"
            fullWidth
            onClick={save}
            disabled={!canSubmit}
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
        <Banner tone="error" title="Couldn't assign crew">
          {serverError}
        </Banner>
      ) : null}

      {!serverError &&
      !loading &&
      eligible &&
      linkSuggestion &&
      (lpSuggestedAppliedId || alpSuggestedAppliedId) ? (
        <Banner tone="info" title="Pre-filled from link roster">
          {[
            lpSuggestedAppliedId && linkSuggestion.lp
              ? `LP ${linkSuggestion.lp.name} (${linkSuggestion.lp.linkName})`
              : null,
            alpSuggestedAppliedId && linkSuggestion.alp
              ? `ALP ${linkSuggestion.alp.name} (${linkSuggestion.alp.linkName})`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
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

function longTrainTypeName(t?: string): string {
  switch (t) {
    case 'MEMU': return 'MEMU';
    case 'DEMU': return 'DEMU';
    default: return 'These';
  }
}

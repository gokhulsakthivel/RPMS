// `updateAssignment` — application-layer orchestrator for the Edit-an-
// assignment flow.
//
// Rationale: an operator may want to swap the LP and/or ALP on an existing
// active assignment without going through archive + re-create (which would
// burn an assignment id and clutter the audit trail). The orchestrator
// re-runs the **same** rule predicates as `assignCrew` against the existing
// run window so the invariants are identical no matter which path created
// the assignment.
//
// Invariants preserved relative to `assignCrew`:
//   - eligibility (LP + ALP) is data-driven from `eligibleTrainTypes`
//   - leave windows block assignment regardless of certification
//   - 16h rest is checked against the existing materialized departureTime
//   - window-conflict checks exclude THIS assignment from the candidate's
//     active set (otherwise an unchanged LP/ALP would always conflict with
//     itself)
//   - the (trainId, runDate) uniqueness key cannot be modified
//
// Out of scope:
//   - changing trainId or runDate. Operators wanting to move a crew to a
//     different train must archive + re-create.
//   - rolling back the OLD crew's `lastSignOffTime`. Historic sign-offs are
//     monotonic by design (HLD §4.7 — manual override exists for explicit
//     corrections).

import { hasSufficientRest, MIN_REST_HOURS } from '../domain/hasSufficientRest';
import { findWindowConflict } from '../domain/hasWindowConflict';
import { isAlpEligible } from '../domain/isAlpEligible';
import { isLpEligible } from '../domain/isLpEligible';
import { findCoveringLeave } from '../domain/isOnLeave';
import { requiresAlp } from '../domain/requiresAlp';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LeaveRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import {
  Assignment,
  AssignmentError,
  Result,
  err,
  ok,
} from '../domain/types';

export interface UpdateAssignmentDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
  leaves: LeaveRepo;
}

export interface UpdateAssignmentInput {
  /** The active assignment to mutate. */
  assignmentId: string;
  /** Optional new LP. Omit to keep the existing LP. */
  lpId?: string;
  /**
   * Optional new ALP. Omit to keep the existing ALP. `null` clears the
   * slot entirely (only valid for trains that don't require an ALP — the
   * orchestrator rejects clears for ALP-required trains).
   */
  alpId?: string | null;
}

/**
 * Mutates the LP and/or ALP on an existing active assignment, re-running
 * eligibility / leave / rest / window checks. Returns the persisted row on
 * success or a structured `AssignmentError` on rule violation.
 */
export async function updateAssignment(
  deps: UpdateAssignmentDeps,
  input: UpdateAssignmentInput,
): Promise<Result<Assignment, AssignmentError>> {
  // ------- Load the target assignment. We accept archived rows in the
  //         lookup so the "already archived" case can produce a precise
  //         error code instead of a generic 404.
  const existing = await deps.assignments.findById(input.assignmentId, {
    includeArchived: true,
  });
  if (!existing) {
    throw new Error(
      `updateAssignment: assignment not found: ${input.assignmentId}`,
    );
  }
  if (existing.archivedAt) {
    // Re-using ARCHIVED_ENTITY by widening the entity tag would change the
    // shared type for every consumer; instead we surface the row's archived
    // state by throwing — the api layer turns this into a 409.
    throw new Error(
      `updateAssignment: assignment is archived: ${input.assignmentId}`,
    );
  }

  // ------- Resolve the train. Window timestamps are immutable per
  //         assignment row, so we lean on the snapshot stored at create
  //         time rather than re-materializing the schedule.
  const train = await deps.trains.findById(existing.trainId, {
    includeArchived: true,
  });
  if (!train) {
    throw new Error(`updateAssignment: train not found: ${existing.trainId}`);
  }
  if (train.archivedAt) {
    return err({ code: 'ARCHIVED_ENTITY', entity: 'TRAIN', id: train.id });
  }

  const departureTimeUtc = existing.departureTime;
  const signOffTimeUtc = existing.signOffTime;
  const needsAlp = requiresAlp(train.type);

  // ------- Resolve the effective LP id / ALP id after the patch is
  //         applied. Unchanged slots use the existing values.
  const newLpId = input.lpId ?? existing.lpId;
  const newAlpId =
    input.alpId === undefined ? existing.alpId ?? undefined : input.alpId ?? undefined;

  const lpChanged = newLpId !== existing.lpId;
  const alpChanged = (input.alpId !== undefined) && (newAlpId !== existing.alpId);

  if (!lpChanged && !alpChanged) {
    // Nothing actually moved — short-circuit to avoid noisy CSV writes.
    return ok(existing);
  }

  // ------- Resolve the new LP entity (re-fetched even when unchanged so
  //         downstream checks see a single, consistent snapshot).
  const lp = await deps.lps.findById(newLpId, { includeArchived: true });
  if (!lp) {
    throw new Error(`updateAssignment: lp not found: ${newLpId}`);
  }
  if (lp.archivedAt) {
    return err({ code: 'ARCHIVED_ENTITY', entity: 'LP', id: lp.id });
  }

  let alp = null as Awaited<ReturnType<AssistantLocoPilotRepo['findById']>>;
  if (newAlpId !== undefined) {
    alp = await deps.alps.findById(newAlpId, { includeArchived: true });
    if (!alp) {
      throw new Error(`updateAssignment: alp not found: ${newAlpId}`);
    }
    if (alp.archivedAt) {
      return err({ code: 'ARCHIVED_ENTITY', entity: 'ALP', id: alp.id });
    }
  }

  // ------- Step 1: LP eligibility (re-checked even when unchanged — train
  //         type might have been edited since the assignment was created).
  if (!isLpEligible(lp, train.type)) {
    return err({ code: 'LP_NOT_ELIGIBLE', lpId: lp.id, trainType: train.type });
  }

  // ------- Step 1b: LP leave window. Only relevant when the LP changed —
  //         an unchanged LP already passed this check at create time and
  //         the rule predicate is anchored to the same runDate.
  if (lpChanged) {
    const lpLeaves = await deps.leaves.listByCrew(lp.id);
    const lpOnLeave = findCoveringLeave(lpLeaves, existing.runDate);
    if (lpOnLeave) {
      return err({
        code: 'LP_ON_LEAVE',
        lpId: lp.id,
        leaveType: lpOnLeave.type,
        fromDate: lpOnLeave.fromDate,
        toDate: lpOnLeave.toDate,
      });
    }
  }

  // ------- Step 2: LP rest. Only check when the LP changed — keeping an
  //         existing LP would always trip rest (their lastSignOffTime was
  //         set to THIS assignment's signOffTime when it was created).
  if (lpChanged && !hasSufficientRest(lp, departureTimeUtc)) {
    return err({
      code: 'LP_REST_VIOLATION',
      lpId: lp.id,
      requiredHours: MIN_REST_HOURS,
      actualHours: hoursBetween(lp.lastSignOffTime, departureTimeUtc),
    });
  }

  // ------- Step 3: LP window-overlap. Exclude THIS assignment from the
  //         candidate's active set so an unchanged LP doesn't conflict
  //         with the row we're updating.
  if (lpChanged) {
    const lpAssignments = (await deps.assignments.listByCrew(lp.id)).filter(
      (a) => a.id !== existing.id,
    );
    const lpConflict = findWindowConflict(
      { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
      lpAssignments,
    );
    if (lpConflict) {
      return err({
        code: 'LP_WINDOW_CONFLICT',
        lpId: lp.id,
        conflictingAssignmentId: lpConflict.id,
      });
    }
  }

  // ------- Step 4: ALP branching.
  if (needsAlp) {
    if (!alp) {
      return err({ code: 'ALP_REQUIRED_BUT_MISSING', trainType: train.type });
    }
    if (!isAlpEligible(alp, train.type)) {
      return err({
        code: 'ALP_NOT_ELIGIBLE',
        alpId: alp.id,
        trainType: train.type,
      });
    }
    if (alpChanged) {
      const alpLeaves = await deps.leaves.listByCrew(alp.id);
      const alpOnLeave = findCoveringLeave(alpLeaves, existing.runDate);
      if (alpOnLeave) {
        return err({
          code: 'ALP_ON_LEAVE',
          alpId: alp.id,
          leaveType: alpOnLeave.type,
          fromDate: alpOnLeave.fromDate,
          toDate: alpOnLeave.toDate,
        });
      }
      if (!hasSufficientRest(alp, departureTimeUtc)) {
        return err({
          code: 'ALP_REST_VIOLATION',
          alpId: alp.id,
          requiredHours: MIN_REST_HOURS,
          actualHours: hoursBetween(alp.lastSignOffTime, departureTimeUtc),
        });
      }
      const alpAssignments = (await deps.assignments.listByCrew(alp.id)).filter(
        (a) => a.id !== existing.id,
      );
      const alpConflict = findWindowConflict(
        { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
        alpAssignments,
      );
      if (alpConflict) {
        return err({
          code: 'ALP_WINDOW_CONFLICT',
          alpId: alp.id,
          conflictingAssignmentId: alpConflict.id,
        });
      }
    }
  } else if (alp) {
    // MEMU/DEMU: ALP supplied where none is allowed. Cleared assignments
    // (`alp === null` resolved above) hit this branch with `alp == null`,
    // so they fall through to the persistence step.
    return err({ code: 'ALP_NOT_ALLOWED', trainType: train.type });
  }

  // ------- Persist. Repo's `update` is the single CSV-write site.
  const updated = await deps.assignments.update(existing.id, {
    ...(lpChanged ? { lpId: lp.id } : {}),
    ...(input.alpId !== undefined
      ? { alpId: alp ? alp.id : null }
      : {}),
  });

  // ------- Sign-off cascade. Mirror `assignCrew`'s post-persist updates —
  //         only for crew that actually changed. The previous slot-holder's
  //         `lastSignOffTime` is intentionally left as-is (see HLD §4.7).
  if (lpChanged) {
    await deps.lps.updateLastSignOff(lp.id, signOffTimeUtc);
  }
  if (alpChanged && alp) {
    await deps.alps.updateLastSignOff(alp.id, signOffTimeUtc);
  }

  return ok(updated);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hoursBetween(from: Date | undefined, to: Date): number {
  if (!from) return Number.POSITIVE_INFINITY;
  const ms = to.getTime() - from.getTime();
  return Math.round((ms / 3_600_000) * 10) / 10;
}

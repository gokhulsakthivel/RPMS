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
//
// Rest-clock rollback (was previously out of scope):
//   When the LP and/or ALP slot is replaced or cleared, the orchestrator now
//   restores the OLD crew member's `lastSignOffTime` to the snapshot captured
//   on this assignment row at create-time (`previousLpSignOffTime` /
//   `previousAlpSignOffTime`). The NEW crew member's *current* sign-off is
//   then snapshotted into the row (rotating the field) before their own
//   `lastSignOffTime` is stamped to this run's sign-off. This keeps the
//   snapshot one-deep — exactly enough to undo this single Edit/Delete —
//   while preserving the audit trail in the CSV.

import { findWindowConflict } from '../domain/hasWindowConflict';
import { isAlpEligible } from '../domain/isAlpEligible';
import { isLpEligible } from '../domain/isLpEligible';
import { findCoveringLeave } from '../domain/isOnLeave';
import { requiredAlpCount } from '../domain/requiresAlp';
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
  /**
   * Optional new second ALP (Amrit Bharat). Same semantics as `alpId`:
   * omit to keep, `null` to clear (rejected for trains that need two ALPs).
   */
  alpId2?: string | null;
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
  const alpCount = requiredAlpCount(train.type);
  const needsAlp = alpCount > 0;
  const needsTwoAlps = alpCount === 2;

  // ------- Resolve the effective LP id / ALP id after the patch is
  //         applied. Unchanged slots use the existing values.
  const newLpId = input.lpId ?? existing.lpId;
  const newAlpId =
    input.alpId === undefined ? existing.alpId ?? undefined : input.alpId ?? undefined;
  const newAlpId2 =
    input.alpId2 === undefined
      ? existing.alpId2 ?? undefined
      : input.alpId2 ?? undefined;

  const lpChanged = newLpId !== existing.lpId;
  const alpChanged = (input.alpId !== undefined) && (newAlpId !== existing.alpId);
  const alp2Changed =
    (input.alpId2 !== undefined) && (newAlpId2 !== existing.alpId2);

  if (!lpChanged && !alpChanged && !alp2Changed) {
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

  let alp2 = null as Awaited<ReturnType<AssistantLocoPilotRepo['findById']>>;
  if (newAlpId2 !== undefined) {
    alp2 = await deps.alps.findById(newAlpId2, { includeArchived: true });
    if (!alp2) {
      throw new Error(`updateAssignment: alp not found: ${newAlpId2}`);
    }
    if (alp2.archivedAt) {
      return err({ code: 'ARCHIVED_ENTITY', entity: 'ALP', id: alp2.id });
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

  // ------- Step 2: LP rest — no longer enforced. Operators may swap in
  //         any LP regardless of the 16-hour window.

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
      // ALP rest — no longer enforced (see LP step 2).
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

    // -- Second ALP slot (Amrit Bharat).
    if (needsTwoAlps) {
      if (!alp2) {
        return err({
          code: 'SECOND_ALP_REQUIRED_BUT_MISSING',
          trainType: train.type,
        });
      }
      if (alp2.id === alp.id) {
        return err({ code: 'ALP_DUPLICATE', alpId: alp.id });
      }
      if (!isAlpEligible(alp2, train.type)) {
        return err({
          code: 'ALP_NOT_ELIGIBLE',
          alpId: alp2.id,
          trainType: train.type,
        });
      }
      if (alp2Changed) {
        const alp2Leaves = await deps.leaves.listByCrew(alp2.id);
        const alp2OnLeave = findCoveringLeave(alp2Leaves, existing.runDate);
        if (alp2OnLeave) {
          return err({
            code: 'ALP_ON_LEAVE',
            alpId: alp2.id,
            leaveType: alp2OnLeave.type,
            fromDate: alp2OnLeave.fromDate,
            toDate: alp2OnLeave.toDate,
          });
        }
        const alp2Assignments = (
          await deps.assignments.listByCrew(alp2.id)
        ).filter((a) => a.id !== existing.id);
        const alp2Conflict = findWindowConflict(
          { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
          alp2Assignments,
        );
        if (alp2Conflict) {
          return err({
            code: 'ALP_WINDOW_CONFLICT',
            alpId: alp2.id,
            conflictingAssignmentId: alp2Conflict.id,
          });
        }
      }
    } else if (alp2) {
      return err({ code: 'SECOND_ALP_NOT_ALLOWED', trainType: train.type });
    }
  } else if (alp || alp2) {
    // MEMU/DEMU: ALP supplied where none is allowed.
    return err({ code: 'ALP_NOT_ALLOWED', trainType: train.type });
  }

  // ------- Restore the old slot-holder's `lastSignOffTime` from the snapshot
  //         we took when THIS assignment was created. We capture the new
  //         slot-holder's current sign-off into a fresh snapshot in the same
  //         repo write so the row tracks exactly one level of history.
  const patch: {
    lpId?: string;
    alpId?: string | null;
    alpId2?: string | null;
    previousLpSignOffTime?: Date | null;
    previousAlpSignOffTime?: Date | null;
    previousAlpSignOffTime2?: Date | null;
  } = {};

  if (lpChanged) {
    patch.lpId = lp.id;
    // Capture the new LP's PRE-stamp sign-off into the row's snapshot before
    // we overwrite it on the LP record below. `null` clears the cell (= "this
    // person had never signed off before").
    patch.previousLpSignOffTime = lp.lastSignOffTime ?? null;
    // Restore the old LP's `lastSignOffTime` to whatever it was before this
    // assignment first stamped it. Brand-new old LPs (no prior) get their
    // `lastSignOffTime` cleared so the rest rule treats them as un-stamped.
    await deps.lps.update(existing.lpId, {
      lastSignOffTime: existing.previousLpSignOffTime,
    });
  }

  if (input.alpId !== undefined) {
    patch.alpId = alp ? alp.id : null;
    // Old ALP was set and is being replaced or cleared — roll their
    // sign-off back. (The new ALP being the SAME person is impossible here
    // because alpChanged would be false in that case.)
    if (existing.alpId && (!alp || alp.id !== existing.alpId)) {
      await deps.alps.update(existing.alpId, {
        lastSignOffTime: existing.previousAlpSignOffTime,
      });
    }
    if (alp && alp.id !== existing.alpId) {
      // Brand-new ALP for this row — capture their pre-stamp sign-off.
      patch.previousAlpSignOffTime = alp.lastSignOffTime ?? null;
    } else if (!alp && existing.alpId) {
      // Slot cleared — drop the snapshot too.
      patch.previousAlpSignOffTime = null;
    }
  }

  if (input.alpId2 !== undefined) {
    patch.alpId2 = alp2 ? alp2.id : null;
    if (existing.alpId2 && (!alp2 || alp2.id !== existing.alpId2)) {
      await deps.alps.update(existing.alpId2, {
        lastSignOffTime: existing.previousAlpSignOffTime2,
      });
    }
    if (alp2 && alp2.id !== existing.alpId2) {
      patch.previousAlpSignOffTime2 = alp2.lastSignOffTime ?? null;
    } else if (!alp2 && existing.alpId2) {
      patch.previousAlpSignOffTime2 = null;
    }
  }

  // ------- Persist. Repo's `update` is the single CSV-write site.
  const updated = await deps.assignments.update(existing.id, patch);

  // ------- Sign-off cascade. Mirror `assignCrew`'s post-persist updates —
  //         only for crew that actually changed. The OLD slot-holder was
  //         already restored above; the new slot-holder takes the run's
  //         sign-off here.
  if (lpChanged) {
    await deps.lps.updateLastSignOff(lp.id, signOffTimeUtc);
  }
  if (alpChanged && alp) {
    await deps.alps.updateLastSignOff(alp.id, signOffTimeUtc);
  }
  if (alp2Changed && alp2) {
    await deps.alps.updateLastSignOff(alp2.id, signOffTimeUtc);
  }

  return ok(updated);
}

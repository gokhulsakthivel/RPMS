// `assignCrew` — application-layer orchestrator.
//
// Encodes the rule sequence from LLD §3.6 over the repo *interfaces* declared
// in `src/domain/repositories.ts`. It MUST NOT import from `src/persistence/*`
// directly — the composition root in `src/api/*.ts` injects the Csv* impls.
//
// Pure domain rule predicates (`isLpEligible`, `hasSufficientRest`, …) live
// in `src/domain/`. This file's job is to wire them in the right order, load
// active assignments for window-conflict checks, and on success persist a new
// `Assignment` plus update LP/ALP `lastSignOffTime`.
//
// M9 — the train carries a recurring weekly schedule. The orchestrator now
// takes a `runDate` (`YYYY-MM-DD`, IST), materializes the absolute UTC
// departure / sign-off window via `runSchedule.materializeRun`, and uses
// those for every downstream rule check. The Assignment is persisted with
// the `runDate` so `(trainId, runDate)` is the natural uniqueness key.

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
import { istDayOfWeek, materializeRun, trainRunsOn } from '../domain/runSchedule';
import {
  Assignment,
  AssignmentError,
  Result,
  err,
  ok,
} from '../domain/types';

export interface AssignCrewDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
  leaves: LeaveRepo;
  /** Pluggable for tests / replay. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface AssignCrewInput {
  trainId: string;
  /** IST calendar date (`YYYY-MM-DD`) selecting which run of the train. */
  runDate: string;
  lpId: string;
  alpId?: string;
  /** Second ALP — only allowed when `requiredAlpCount(train.type) === 2`. */
  alpId2?: string;
}

/**
 * Implements LLD §3.6 step-by-step. Returns `Result<Assignment, AssignmentError>`
 * — never throws on rule violations. Repo I/O errors propagate as exceptions
 * (caller turns those into HTTP 500 / generic operator messages).
 */
export async function assignCrew(
  deps: AssignCrewDeps,
  input: AssignCrewInput,
): Promise<Result<Assignment, AssignmentError>> {
  const now = deps.now ?? (() => new Date());

  // ------- Load entities (`includeArchived: true` so we can produce a
  //         precise ARCHIVED_ENTITY error rather than a "not found" mystery).
  const train = await deps.trains.findById(input.trainId, { includeArchived: true });
  if (!train) {
    // No archive distinction here — repo says it's gone entirely. The caller
    // (api layer) will translate this absence into an HTTP 404. We surface a
    // plain Error rather than overload the AssignmentError union.
    throw new Error(`assignCrew: train not found: ${input.trainId}`);
  }
  if (train.archivedAt) {
    return err({ code: 'ARCHIVED_ENTITY', entity: 'TRAIN', id: train.id });
  }

  // ------- Day-of-week gate (M9). Returns a precise error code so the UI
  //         can render "Train 16187 does not run on Sunday" instead of a
  //         generic 422.
  if (!trainRunsOn(train, input.runDate)) {
    return err({
      code: 'TRAIN_DOES_NOT_RUN_ON_DAY',
      trainId: train.id,
      runDate: input.runDate,
      dayOfWeek: istDayOfWeek(input.runDate),
    });
  }

  // ------- Materialize the absolute UTC window for this run. Throws on a
  //         malformed run-date or a non-positive window (sign-off ≤ departure)
  //         — those are programmer errors; the schema layer should have
  //         already rejected the input shape.
  const { departureTimeUtc, signOffTimeUtc } = materializeRun(train, input.runDate);

  const lp = await deps.lps.findById(input.lpId, { includeArchived: true });
  if (!lp) {
    throw new Error(`assignCrew: lp not found: ${input.lpId}`);
  }
  if (lp.archivedAt) {
    return err({ code: 'ARCHIVED_ENTITY', entity: 'LP', id: lp.id });
  }

  const alpCount = requiredAlpCount(train.type);
  const needsAlp = alpCount > 0;
  const needsTwoAlps = alpCount === 2;

  // alp is loaded only if supplied; we still load before any checks so the
  // ARCHIVED_ENTITY error fires before less-specific ones (LLD §3.6 step 0).
  let alp = null as Awaited<ReturnType<AssistantLocoPilotRepo['findById']>>;
  if (input.alpId !== undefined) {
    alp = await deps.alps.findById(input.alpId, { includeArchived: true });
    if (!alp) {
      throw new Error(`assignCrew: alp not found: ${input.alpId}`);
    }
    if (alp.archivedAt) {
      return err({ code: 'ARCHIVED_ENTITY', entity: 'ALP', id: alp.id });
    }
  }

  let alp2 = null as Awaited<ReturnType<AssistantLocoPilotRepo['findById']>>;
  if (input.alpId2 !== undefined) {
    alp2 = await deps.alps.findById(input.alpId2, { includeArchived: true });
    if (!alp2) {
      throw new Error(`assignCrew: alp not found: ${input.alpId2}`);
    }
    if (alp2.archivedAt) {
      return err({ code: 'ARCHIVED_ENTITY', entity: 'ALP', id: alp2.id });
    }
  }

  // ------- Already-assigned guard (M9). `(trainId, runDate)` should be a
  //         uniqueness key for active rows; if an active assignment already
  //         exists for this run we reject with a structured error instead
  //         of silently double-booking the train.
  const existingForTrain = await deps.assignments.listByTrain(train.id);
  const existingForRun = existingForTrain.find(
    (a) => a.runDate === input.runDate && !a.archivedAt,
  );
  if (existingForRun) {
    return err({
      code: 'ALREADY_ASSIGNED',
      trainId: train.id,
      runDate: input.runDate,
      conflictingAssignmentId: existingForRun.id,
    });
  }

  // ------- Step 1: LP eligibility.
  // Eligibility is fully data-driven: the train type must appear in
  // `lp.eligibleTrainTypes`. A single error code covers every miss.
  if (!isLpEligible(lp, train.type)) {
    return err({
      code: 'LP_NOT_ELIGIBLE',
      lpId: lp.id,
      trainType: train.type,
    });
  }

  // ------- Step 1b: LP leave window. A non-archived Leave covering
  //         `runDate` makes the LP unavailable regardless of rest or
  //         certification (HLD §4.4). Checked before rest so the operator
  //         sees the more specific reason first.
  const lpLeaves = await deps.leaves.listByCrew(lp.id);
  const lpOnLeave = findCoveringLeave(lpLeaves, input.runDate);
  if (lpOnLeave) {
    return err({
      code: 'LP_ON_LEAVE',
      lpId: lp.id,
      leaveType: lpOnLeave.type,
      fromDate: lpOnLeave.fromDate,
      toDate: lpOnLeave.toDate,
    });
  }

  // ------- Step 2: LP rest — no longer enforced. Operators may assign any
  //         LP regardless of the 16-hour window; the dropdown surfaces rest
  //         remaining for situational awareness.

  // ------- Step 3: LP window-overlap.
  // Active assignments only — repo defaults to `archivedAt IS NULL`.
  const lpAssignments = await deps.assignments.listByCrew(lp.id);
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
    // Mirror of the LP leave check — same precedence, same shape.
    const alpLeaves = await deps.leaves.listByCrew(alp.id);
    const alpOnLeave = findCoveringLeave(alpLeaves, input.runDate);
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
    const alpAssignments = await deps.assignments.listByCrew(alp.id);
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

    // -- Second ALP slot (Amrit Bharat). The two ALPs go through identical
    //    eligibility / leave / window checks; we additionally reject a row
    //    that names the same crew member in both slots.
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
      const alp2Leaves = await deps.leaves.listByCrew(alp2.id);
      const alp2OnLeave = findCoveringLeave(alp2Leaves, input.runDate);
      if (alp2OnLeave) {
        return err({
          code: 'ALP_ON_LEAVE',
          alpId: alp2.id,
          leaveType: alp2OnLeave.type,
          fromDate: alp2OnLeave.fromDate,
          toDate: alp2OnLeave.toDate,
        });
      }
      const alp2Assignments = await deps.assignments.listByCrew(alp2.id);
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
    } else if (alp2) {
      // Train type only requires one ALP but a second was supplied.
      return err({ code: 'SECOND_ALP_NOT_ALLOWED', trainType: train.type });
    }
  } else if (alp || alp2) {
    // MEMU/DEMU: ALP supplied where none is allowed.
    return err({ code: 'ALP_NOT_ALLOWED', trainType: train.type });
  }

  // ------- Step 5/6: Persist + sign-off cascade.
  // We persist the Assignment first so that — if a sign-off update fails for
  // any reason — the audit trail still records the duty. The two sign-off
  // updates are best-effort; a hard failure here surfaces as a 500 to the
  // operator, but the train will not be re-assignable to the same crew until
  // the operator either retries or uses the manual override (HLD §4.7).
  //
  // The Assignment row also snapshots whatever `lastSignOffTime` each crew
  // member carried *before* this stamp, so a later edit/archive can roll
  // their rest clock back to that pre-assignment value. Brand-new crew
  // (no prior sign-off) snapshot as `undefined` and survive the round trip
  // through the CSV as an empty cell.
  const created = await deps.assignments.create({
    trainId: train.id,
    runDate: input.runDate,
    lpId: lp.id,
    alpId: alp?.id,
    alpId2: alp2?.id,
    departureTime: departureTimeUtc,
    signOffTime: signOffTimeUtc,
    ...(lp.lastSignOffTime
      ? { previousLpSignOffTime: lp.lastSignOffTime }
      : {}),
    ...(alp?.lastSignOffTime
      ? { previousAlpSignOffTime: alp.lastSignOffTime }
      : {}),
    ...(alp2?.lastSignOffTime
      ? { previousAlpSignOffTime2: alp2.lastSignOffTime }
      : {}),
  });

  await deps.lps.updateLastSignOff(lp.id, signOffTimeUtc);
  if (alp) {
    await deps.alps.updateLastSignOff(alp.id, signOffTimeUtc);
  }
  if (alp2) {
    await deps.alps.updateLastSignOff(alp2.id, signOffTimeUtc);
  }

  // `now` is referenced for tests that pin time; the orchestrator itself does
  // not need a "now" because all rule comparisons are anchored to the
  // materialized `departureTimeUtc`. Keeping the dep so future rule additions
  // (e.g. a not-in-the-past check) can land without changing call sites.
  void now;

  return ok(created);
}

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

import { hasSufficientRest, MIN_REST_HOURS } from '../domain/hasSufficientRest';
import { findWindowConflict } from '../domain/hasWindowConflict';
import { isAlpEligible } from '../domain/isAlpEligible';
import { isLpEligible } from '../domain/isLpEligible';
import { requiresAlp } from '../domain/requiresAlp';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
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
  /** Pluggable for tests / replay. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface AssignCrewInput {
  trainId: string;
  /** IST calendar date (`YYYY-MM-DD`) selecting which run of the train. */
  runDate: string;
  lpId: string;
  alpId?: string;
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

  const needsAlp = requiresAlp(train.type);

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

  // ------- Step 2: LP rest. Anchored to the materialized UTC departure.
  if (!hasSufficientRest(lp, departureTimeUtc)) {
    return err({
      code: 'LP_REST_VIOLATION',
      lpId: lp.id,
      requiredHours: MIN_REST_HOURS,
      actualHours: hoursBetween(lp.lastSignOffTime, departureTimeUtc),
    });
  }

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
    if (!hasSufficientRest(alp, departureTimeUtc)) {
      return err({
        code: 'ALP_REST_VIOLATION',
        alpId: alp.id,
        requiredHours: MIN_REST_HOURS,
        actualHours: hoursBetween(alp.lastSignOffTime, departureTimeUtc),
      });
    }
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
  } else if (alp) {
    // MEMU/DEMU: ALP supplied where none is allowed.
    return err({ code: 'ALP_NOT_ALLOWED', trainType: train.type });
  }

  // ------- Step 5/6: Persist + sign-off cascade.
  // We persist the Assignment first so that — if a sign-off update fails for
  // any reason — the audit trail still records the duty. The two sign-off
  // updates are best-effort; a hard failure here surfaces as a 500 to the
  // operator, but the train will not be re-assignable to the same crew until
  // the operator either retries or uses the manual override (HLD §4.7).
  const created = await deps.assignments.create({
    trainId: train.id,
    runDate: input.runDate,
    lpId: lp.id,
    alpId: alp?.id,
    departureTime: departureTimeUtc,
    signOffTime: signOffTimeUtc,
  });

  await deps.lps.updateLastSignOff(lp.id, signOffTimeUtc);
  if (alp) {
    await deps.alps.updateLastSignOff(alp.id, signOffTimeUtc);
  }

  // `now` is referenced for tests that pin time; the orchestrator itself does
  // not need a "now" because all rule comparisons are anchored to the
  // materialized `departureTimeUtc`. Keeping the dep so future rule additions
  // (e.g. a not-in-the-past check) can land without changing call sites.
  void now;

  return ok(created);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Hours between `from` and `to`, rounded down to one decimal. Returns
 * `Number.POSITIVE_INFINITY` for a brand-new crew member (no `lastSignOffTime`)
 * — matches the "never signed off → unlimited rest" treatment in
 * `hasSufficientRest`.
 */
function hoursBetween(from: Date | undefined, to: Date): number {
  if (!from) return Number.POSITIVE_INFINITY;
  const ms = to.getTime() - from.getTime();
  return Math.round((ms / 3_600_000) * 10) / 10;
}

// Server-side eligibility filter for the AssignCrewModal dropdowns.
//
// design.md §9.3: "Each dropdown is pre-filtered server-side to crew who
// satisfy: isLpEligible / isAlpEligible AND hasSufficientRest AND no window
// overlap with any active assignment." Filtered-out crew are returned in
// buckets so the UI can show "Hidden: 8 not eligible, 3 still resting,
// 1 already assigned" footnotes.
//
// Archived crew are silently excluded — they never appear at all.
//
// M9 — the filter takes a `runDate` and materializes the train's recurring
// schedule into an absolute UTC window via `runSchedule.materializeRun`
// before applying the rest and window-conflict checks.

import { hasSufficientRest } from '../domain/hasSufficientRest';
import { hasWindowConflict } from '../domain/hasWindowConflict';
import { isAlpEligible } from '../domain/isAlpEligible';
import { isLpEligible } from '../domain/isLpEligible';
import { isOnLeave } from '../domain/isOnLeave';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LeaveRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { materializeRun, trainRunsOn } from '../domain/runSchedule';
import { CrewRole, Leave, Train } from '../domain/types';

export interface ListCrewForAssignmentDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
  leaves: LeaveRepo;
}

/** A "filtered out" reason for the dropdown footnote. Same buckets for LP and ALP. */
export type FilteredOutReason =
  | 'not_eligible'
  | 'still_resting'
  | 'already_assigned'
  | 'on_leave';

export interface CrewOption {
  id: string;
  name: string;
}

export interface FilteredOutBucket {
  reason: FilteredOutReason;
  /** Stable order so the UI footnote sums and the audit log are deterministic. */
  crewIds: string[];
}

export interface CrewForAssignmentResult {
  /** LPs that pass eligibility + rest + no-window-overlap, sorted by name. */
  eligibleLps: CrewOption[];
  /** ALPs that pass the same checks; empty when the train type does not require an ALP. */
  eligibleAlps: CrewOption[];
  /** Buckets of LPs that were excluded — for the LP dropdown footnote. */
  filteredOutLps: FilteredOutBucket[];
  /** Buckets of ALPs that were excluded — for the ALP dropdown footnote. */
  filteredOutAlps: FilteredOutBucket[];
}

/**
 * Build the eligible-crew dropdown payload for one specific run of a train.
 * Pure query: never mutates state. Window-overlap uses the same closed-
 * interval rule as `assignCrew`, so the dropdown can never show a candidate
 * who would be rejected by the orchestrator.
 *
 * Throws when the train does not run on the given run-date — the API layer
 * translates that into a structured `TRAIN_DOES_NOT_RUN_ON_DAY` response.
 */
export async function listCrewForAssignment(
  deps: ListCrewForAssignmentDeps,
  trainId: string,
  runDate: string,
): Promise<CrewForAssignmentResult> {
  const train = await deps.trains.findById(trainId);
  if (!train) {
    throw new Error(`listCrewForAssignment: train not found or archived: ${trainId}`);
  }
  if (!trainRunsOn(train, runDate)) {
    throw new Error(
      `listCrewForAssignment: train ${trainId} does not run on ${runDate}`,
    );
  }

  const { departureTimeUtc, signOffTimeUtc } = materializeRun(train, runDate);

  // ------- Leaves covering `runDate`. Fetched once per role and indexed by
  //         crewId so the classifier short-circuits with no extra I/O. The
  //         repo applies the role filter so we never iterate the wrong set.
  const lpLeaveIndex = await indexLeavesByCrew(deps.leaves, runDate, 'LP');
  const alpLeaveIndex = await indexLeavesByCrew(deps.leaves, runDate, 'ALP');

  // ------- LP candidates.
  const allLps = await deps.lps.list(); // active only by default
  const lpResult = await classifyCandidates({
    train,
    departureTimeUtc,
    signOffTimeUtc,
    runDate,
    candidates: allLps.map((lp) => ({
      id: lp.id,
      name: lp.name,
      lastSignOffTime: lp.lastSignOffTime,
      isEligible: isLpEligible(lp, train.type),
      leavesForDate: lpLeaveIndex.get(lp.id) ?? [],
    })),
    fetchAssignments: (id) => deps.assignments.listByCrew(id),
  });

  // ------- ALP candidates: only meaningful if the train type allows an ALP.
  // For MEMU/DEMU we return empty arrays — the UI hides the ALP dropdown
  // entirely (design.md §9.3) so empty buckets here are correct.
  const allAlps = train.type === 'MEMU' || train.type === 'DEMU'
    ? []
    : await deps.alps.list();
  const alpResult = await classifyCandidates({
    train,
    departureTimeUtc,
    signOffTimeUtc,
    runDate,
    candidates: allAlps.map((alp) => ({
      id: alp.id,
      name: alp.name,
      lastSignOffTime: alp.lastSignOffTime,
      isEligible: isAlpEligible(alp, train.type),
      leavesForDate: alpLeaveIndex.get(alp.id) ?? [],
    })),
    fetchAssignments: (id) => deps.assignments.listByCrew(id),
  });

  return {
    eligibleLps: lpResult.eligible,
    eligibleAlps: alpResult.eligible,
    filteredOutLps: lpResult.filteredOut,
    filteredOutAlps: alpResult.filteredOut,
  };
}

// ---------------------------------------------------------------------------
// internal — shared classifier so LP and ALP go through identical logic
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  name: string;
  lastSignOffTime?: Date;
  /** Domain-level eligibility verdict; varies by LP vs ALP. */
  isEligible: boolean;
  /** Non-archived leaves whose window covers `runDate`. May be empty. */
  leavesForDate: ReadonlyArray<Leave>;
}

interface ClassifierInput {
  train: Train;
  departureTimeUtc: Date;
  signOffTimeUtc: Date;
  runDate: string;
  candidates: Candidate[];
  fetchAssignments: (crewId: string) => Promise<{ departureTime: Date; signOffTime: Date }[]>;
}

interface ClassifierResult {
  eligible: CrewOption[];
  filteredOut: FilteredOutBucket[];
}

async function classifyCandidates(input: ClassifierInput): Promise<ClassifierResult> {
  const { departureTimeUtc, signOffTimeUtc, runDate, candidates, fetchAssignments } = input;

  const eligible: CrewOption[] = [];
  const notEligible: string[] = [];
  const onLeave: string[] = [];
  const stillResting: string[] = [];
  const alreadyAssigned: string[] = [];

  for (const c of candidates) {
    if (!c.isEligible) {
      notEligible.push(c.id);
      continue;
    }
    // Leave check mirrors `assignCrew`'s precedence: surfaces before rest so
    // the footnote attributes the rejection to the most specific reason.
    if (isOnLeave(c.leavesForDate, runDate)) {
      onLeave.push(c.id);
      continue;
    }
    if (!hasSufficientRest({ lastSignOffTime: c.lastSignOffTime }, departureTimeUtc)) {
      stillResting.push(c.id);
      continue;
    }
    // Window-overlap check is the most expensive (per-candidate I/O), so we
    // run it last after the cheap predicates have shed obvious rejections.
    const existing = await fetchAssignments(c.id);
    if (
      hasWindowConflict(
        { departureTime: departureTimeUtc, signOffTime: signOffTimeUtc },
        existing as never,
      )
    ) {
      alreadyAssigned.push(c.id);
      continue;
    }
    eligible.push({ id: c.id, name: c.name });
  }

  // Stable sort so the dropdown is deterministic and the footnote sums match
  // a re-rendered UI without a refetch.
  eligible.sort((a, b) => a.name.localeCompare(b.name));

  const filteredOut: FilteredOutBucket[] = [];
  if (notEligible.length)     filteredOut.push({ reason: 'not_eligible',     crewIds: notEligible });
  if (onLeave.length)         filteredOut.push({ reason: 'on_leave',         crewIds: onLeave });
  if (stillResting.length)    filteredOut.push({ reason: 'still_resting',    crewIds: stillResting });
  if (alreadyAssigned.length) filteredOut.push({ reason: 'already_assigned', crewIds: alreadyAssigned });

  return { eligible, filteredOut };
}

/**
 * Build a `crewId → covering leaves` index for one `runDate`/role. Uses the
 * repo's role-scoped query so the lookup table never carries cross-role
 * rows. Multiple covering leaves per crew are preserved in case the UI
 * later wants to surface "X is on TRAINING and SICK".
 */
async function indexLeavesByCrew(
  repo: LeaveRepo,
  runDate: string,
  crewRole: CrewRole,
): Promise<Map<string, Leave[]>> {
  const covering = await repo.listCoveringDate(runDate, { crewRole });
  const index = new Map<string, Leave[]>();
  for (const l of covering) {
    const existing = index.get(l.crewId);
    if (existing) existing.push(l);
    else index.set(l.crewId, [l]);
  }
  return index;
}

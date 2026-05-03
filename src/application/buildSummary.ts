// `buildSummary` — produces the four summary-card numbers for the StatCard
// strip on every page. Source of truth: design.md §9.4.
//
// All numbers are scoped to a calendar date `D` in IST. The IST→UTC anchor
// (`startOfDayIstAsUtc`) lives in `src/shared/time.ts`, the only place
// allowed to do that math.
//
// M9 — trains carry a recurring weekly schedule. "Trains scoped to D IST"
// means "trains whose `runsOnDays` contains the IST day-of-week of D".
// Assignments are matched by `runDate === D`.

import { hasSufficientRest } from '../domain/hasSufficientRest';
import { requiresAlp } from '../domain/requiresAlp';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { trainRunsOn } from '../domain/runSchedule';
import { startOfDayIstAsUtc } from '../shared/time';
import { SummaryResponse } from '../shared/schemas';

export interface BuildSummaryDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

/**
 * @param isoDate `YYYY-MM-DD` interpreted as the operator's selected date in IST.
 */
export async function buildSummary(
  deps: BuildSummaryDeps,
  isoDate: string,
): Promise<SummaryResponse> {
  const fromUtc = startOfDayIstAsUtc(isoDate);

  // ---- Trains scoped to D IST via day-of-week filter (M9).
  const allTrains = await deps.trains.list();
  const trainsToday = allTrains.filter((t) => trainRunsOn(t, isoDate));

  // ---- Active assignments for this run-date. We index by trainId so the
  //      unassigned count is one map lookup per train.
  const allAssignments = await deps.assignments.list();
  const assignmentsToday = allAssignments.filter(
    (a) => a.runDate === isoDate,
  );
  const assignmentsByTrainId = new Map<string, typeof assignmentsToday>();
  for (const a of assignmentsToday) {
    const list = assignmentsByTrainId.get(a.trainId) ?? [];
    list.push(a);
    assignmentsByTrainId.set(a.trainId, list);
  }

  let unassignedTrains = 0;
  for (const train of trainsToday) {
    const trainAssignments = assignmentsByTrainId.get(train.id) ?? [];
    if (isTrainUnassigned(train.type, trainAssignments)) {
      unassignedTrains += 1;
    }
  }

  // ---- Crew availability is anchored to the START of the IST day, not to
  //      any specific train's departure. design.md §9.4 spells this out.
  const [lps, alps] = await Promise.all([deps.lps.list(), deps.alps.list()]);

  let availableCrew = 0;
  let restingCrew = 0;
  for (const crew of [...lps, ...alps]) {
    if (hasSufficientRest({ lastSignOffTime: crew.lastSignOffTime }, fromUtc)) {
      availableCrew += 1;
    } else {
      restingCrew += 1;
    }
  }

  return {
    date: isoDate,
    totalTrains: trainsToday.length,
    unassignedTrains,
    availableCrew,
    restingCrew,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * design.md §9.4: "MEMU/DEMU: counted as unassigned iff there is no LP.
 * Others: iff either LP or ALP is missing." We treat any active assignment
 * row for the train as filling its slots — multiple rows on the same train
 * (e.g. a corrected re-assignment) are not expected at this stage.
 */
function isTrainUnassigned(
  trainType: import('../domain/types').TrainType,
  assignments: { lpId: string; alpId?: string }[],
): boolean {
  if (assignments.length === 0) return true;
  const hasLp  = assignments.some((a) => a.lpId);
  const hasAlp = assignments.some((a) => a.alpId);
  if (!requiresAlp(trainType)) {
    // MEMU/DEMU — only the LP slot is required.
    return !hasLp;
  }
  // Others — both LP and ALP must be present.
  return !hasLp || !hasAlp;
}

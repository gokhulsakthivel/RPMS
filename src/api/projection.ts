// Server-side projections that translate domain entities into the wire
// formats declared in `src/shared/schemas.ts`. All row computations
// (highest grade, eligibility labels, "available" vs "resting" status,
// hours-of-rest-remaining) live here so:
//
//   1. The Express handlers stay slim — they wire repos and call these.
//   2. The web tier never has to recompute anything (design.md §9.2 / §9.3).
//
// This module sits in `src/api/*` per the layering rule: it is the only place
// allowed to depend on `src/persistence/*` and `src/application/*` together.
//
// M9 — `Train` no longer carries absolute UTC departure / sign-off
// timestamps. List endpoints materialize each train against the operator's
// selected `runDate` and pass the resulting `MaterializedRun` into these
// projections. Single-train endpoints (e.g. eligible-crew) do the same.

import {
  alpDrivableTypes,
  coversAllTrainTypes,
  highestGrade,
  lpDrivableTypes,
} from '../domain/highestGrade';
import { hoursRestRemaining, MIN_REST_HOURS } from '../domain/hasSufficientRest';
import { requiresAlp } from '../domain/requiresAlp';
import type { MaterializedRun } from '../domain/runSchedule';
import {
  Assignment,
  AssistantLocoPilot,
  LocoPilot,
  Train,
  TrainType,
} from '../domain/types';
import {
  AssignmentRow,
  CrewRow,
  TrainRow,
  TrainWithAssignment,
  LpSummary,
} from '../shared/schemas';

// ---------------------------------------------------------------------------
// Train ↔ TrainRow / TrainWithAssignment
// ---------------------------------------------------------------------------

/**
 * Plain Train + materialized run window → wire row. `runDate` is the IST
 * calendar date this row is materialized against; the absolute UTC instants
 * come from `runSchedule.materializeRun`.
 */
export function trainToRow(
  t: Train,
  runDate: string,
  run: MaterializedRun,
): TrainRow {
  return {
    id: t.id,
    number: t.number,
    name: t.name,
    type: t.type,
    onwardFromStation: t.onwardFromStation,
    onwardToStation: t.onwardToStation,
    runDate,
    runsOnDays: [...t.runsOnDays],
    departureTimeOfDay: t.departureTimeOfDay,
    inwardArrivalTimeOfDay: t.inwardArrivalTimeOfDay,
    inwardArrivalDayOffset: t.inwardArrivalDayOffset,
    departureTime: run.departureTimeUtc.toISOString(),
    inwardTrainNumber: t.inwardTrainNumber,
    inwardFromStation: t.inwardFromStation,
    inwardToStation: t.inwardToStation,
    inwardArrivalTime: run.signOffTimeUtc.toISOString(),
  };
}

/**
 * Project a Train + the active assignments scoped to it into a row for the
 * Trains tab (design.md §9.1, "Currently assigned crew" column).
 *
 * `lpsById` / `alpsById` give us the assigned crew names without an extra
 * round trip per row. `trainAssignments` should already be pre-filtered to
 * the selected `runDate`.
 */
export function trainWithAssignment(
  train: Train,
  runDate: string,
  run: MaterializedRun,
  trainAssignments: Assignment[],
  lpsById: ReadonlyMap<string, LocoPilot>,
  alpsById: ReadonlyMap<string, AssistantLocoPilot>,
): TrainWithAssignment {
  const base = trainToRow(train, runDate, run);
  const active = trainAssignments.filter((a) => !a.archivedAt);
  // Within active rows for the same train + runDate we expect at most one —
  // but if the operator has reassigned, we display the most recent.
  const sorted = active.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const current = sorted[0];

  const lp =
    current && current.lpId
      ? lookupNamed(current.lpId, lpsById)
      : null;

  let alp: TrainWithAssignment['alp'];
  if (!requiresAlp(train.type)) {
    alp = 'NOT_REQUIRED';
  } else if (current && current.alpId) {
    alp = lookupNamed(current.alpId, alpsById);
  } else {
    alp = null;
  }

  return { ...base, lp, alp };
}

// ---------------------------------------------------------------------------
// Assignment ↔ AssignmentRow (per-train projection for the Assignments tab)
// ---------------------------------------------------------------------------

/**
 * Project the (train, optional active assignment) tuple into the per-train
 * row consumed by `AssignmentTable` (components.md §10).
 */
export function assignmentRowForTrain(
  train: Train,
  runDate: string,
  run: MaterializedRun,
  trainAssignments: Assignment[],
  lpsById: ReadonlyMap<string, LocoPilot>,
  alpsById: ReadonlyMap<string, AssistantLocoPilot>,
): AssignmentRow {
  const active = trainAssignments
    .filter((a) => !a.archivedAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const current = active[0];

  const lp =
    current && current.lpId
      ? lookupNamed(current.lpId, lpsById)
      : null;

  let alp: AssignmentRow['alp'];
  if (!requiresAlp(train.type)) {
    alp = 'NOT_REQUIRED';
  } else if (current && current.alpId) {
    alp = lookupNamed(current.alpId, alpsById);
  } else {
    alp = null;
  }

  // A train is assignable iff at least one slot it requires is unfilled.
  const lpFilled = lp !== null;
  const alpFilled = alp === 'NOT_REQUIRED' || (alp !== null && alp !== undefined);
  const isAssignable = !(lpFilled && alpFilled);

  return {
    trainId: train.id,
    trainNumber: train.number,
    trainName: train.name,
    trainType: train.type,
    runDate,
    departureTime: run.departureTimeUtc.toISOString(),
    lp,
    alp,
    isAssignable,
  };
}

// ---------------------------------------------------------------------------
// Crew (LP / ALP) → CrewRow
// ---------------------------------------------------------------------------

/**
 * Project an LP into the unified Crew table row (design.md §9.2).
 *
 * The "rest anchor" controls when status is computed:
 *   - For the Crew tab, the page passes `start_of_selected_date_IST_in_UTC`
 *     so the table reflects "as of midnight IST on the chosen day".
 *   - For ad-hoc previews (e.g. inside a modal) callers can pass `new Date()`.
 */
export function lpToCrewRow(lp: LocoPilot, restAnchor: Date): CrewRow {
  const drivable = lpDrivableTypes(lp);
  const grade = highestGrade(drivable) ?? null;
  const eligibleForLabel = buildEligibleForLabel(drivable, /* allowAllTypes */ true);
  return {
    id: lp.id,
    kind: 'LP',
    name: lp.name,
    grade,
    ...buildRestProjection(lp.lastSignOffTime, restAnchor),
    eligibleForLabel,
    editable: {
      category: lp.category,
      // Snapshot — caller mutates the form state, not this array.
      eligibleTrainTypes: [...lp.eligibleTrainTypes],
      lastSignOffTime: lp.lastSignOffTime
        ? lp.lastSignOffTime.toISOString()
        : null,
    },
  };
}

export function alpToCrewRow(alp: AssistantLocoPilot, restAnchor: Date): CrewRow {
  const drivable = alpDrivableTypes(alp);
  const grade = highestGrade(drivable) ?? null;
  // ALPs cannot ever cover all 6 (MEMU/DEMU forbidden). The flag still
  // applies safely because `coversAllTrainTypes` returns false here, but we
  // pass `false` explicitly to make the intent clear.
  const eligibleForLabel = buildEligibleForLabel(drivable, /* allowAllTypes */ false);
  return {
    id: alp.id,
    kind: 'ALP',
    name: alp.name,
    grade,
    ...buildRestProjection(alp.lastSignOffTime, restAnchor),
    eligibleForLabel,
    editable: {
      eligibleTrainTypes: [...alp.eligibleTrainTypes],
      lastSignOffTime: alp.lastSignOffTime
        ? alp.lastSignOffTime.toISOString()
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Crew → LpSummary (the AssignCrewModal dropdown shape)
// ---------------------------------------------------------------------------

export function lpToSummary(lp: LocoPilot): LpSummary {
  return { id: lp.id, name: lp.name, grade: highestGrade(lpDrivableTypes(lp)) ?? null };
}
export function alpToSummary(alp: AssistantLocoPilot): LpSummary {
  return { id: alp.id, name: alp.name, grade: highestGrade(alpDrivableTypes(alp)) ?? null };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lookupNamed(
  id: string,
  byId: ReadonlyMap<string, { id: string; name: string }>,
): { id: string; name: string } {
  const entity = byId.get(id);
  // A missing reference here means the CSVs are inconsistent (e.g. an LP was
  // hard-deleted bypassing the repo). We surface an obvious placeholder so
  // the Assignments tab remains rendered while the operator investigates.
  return entity ? { id: entity.id, name: entity.name } : { id, name: '«missing»' };
}

/** Maps `TrainType` → the short form used in the "Eligible for" cell. */
const SHORT_FORM: Record<TrainType, string> = {
  [TrainType.PASSENGER]:    'Passenger',
  [TrainType.MAIL_EXPRESS]: 'Mail/Express',
  [TrainType.MEMU]:         'MEMU',
  [TrainType.DEMU]:         'DEMU',
  [TrainType.VANDE_BHARAT]: 'VB',
  [TrainType.AMRIT_BHARAT]: 'AB',
};

/** Same display ordering as the grade ranks — drives the cell's sort. */
const HIERARCHY_ORDER: TrainType[] = [
  TrainType.MEMU,
  TrainType.DEMU,
  TrainType.PASSENGER,
  TrainType.MAIL_EXPRESS,
  TrainType.VANDE_BHARAT,
  TrainType.AMRIT_BHARAT,
];

/**
 * "Mail/Express, VB" / "All types" / "" (empty for ALPs with no certs).
 * design.md §9.2 — the value is rendered verbatim by the UI.
 */
function buildEligibleForLabel(
  types: TrainType[],
  allowAllTypes: boolean,
): string {
  if (types.length === 0) return '';
  if (allowAllTypes && coversAllTrainTypes(types)) return 'All types';
  const set = new Set(types);
  return HIERARCHY_ORDER
    .filter((t) => set.has(t))
    .map((t) => SHORT_FORM[t])
    .join(', ');
}

interface RestProjection {
  status: 'available' | 'resting';
  rest: { hoursRemaining: number; neverSignedOff: boolean };
}

/**
 * Build the `status` + `rest` slice of a `CrewRow`. `restAnchor` is the
 * instant we measure rest **against** — usually start-of-selected-day-IST in
 * UTC. We mirror `hasSufficientRest`'s "never signed off → 0h remaining,
 * available" treatment.
 */
function buildRestProjection(
  lastSignOffTime: Date | undefined,
  restAnchor: Date,
): RestProjection {
  if (!lastSignOffTime) {
    return {
      status: 'available',
      rest: { hoursRemaining: 0, neverSignedOff: true },
    };
  }
  const remaining = hoursRestRemaining({ lastSignOffTime }, restAnchor);
  if (remaining <= 0) {
    return {
      status: 'available',
      rest: { hoursRemaining: 0, neverSignedOff: false },
    };
  }
  // Cap at MIN_REST_HOURS to keep the bar fill calculation stable in the UI
  // for very-recently-signed-off crew.
  return {
    status: 'resting',
    rest: {
      hoursRemaining: Math.min(remaining, MIN_REST_HOURS),
      neverSignedOff: false,
    },
  };
}

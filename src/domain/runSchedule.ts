// Recurring-schedule helpers (M9). Pure, side-effect free.
//
// Trains are stored as a weekly schedule: a non-empty subset of `DayOfWeek`,
// a departure time-of-day in IST, and an inward-arrival time-of-day plus a
// day offset (0 = same day, 1 = next day, ...). To run any rule against a
// specific calendar run we *materialize* that schedule into absolute UTC
// instants via `materializeRun`. All IST-wall-clock ↔ UTC math goes through
// `shared/time.ts` to keep the offset in one place.
//
// Source of truth: HLD §4.4 (sign-on / sign-off) + plan ~/.wibey/plans/m9.

import { istWallClockToUtc } from '../shared/time';
import { DayOfWeek, type Train } from './types';

// ---------------------------------------------------------------------------
// Day-of-week index — SUN=0..SAT=6 mirrors `Date.prototype.getDay()`.
// ---------------------------------------------------------------------------

export const DAY_OF_WEEK_INDEX: Record<DayOfWeek, number> = {
  [DayOfWeek.SUN]: 0,
  [DayOfWeek.MON]: 1,
  [DayOfWeek.TUE]: 2,
  [DayOfWeek.WED]: 3,
  [DayOfWeek.THU]: 4,
  [DayOfWeek.FRI]: 5,
  [DayOfWeek.SAT]: 6,
};

const ALL_DAYS: DayOfWeek[] = [
  DayOfWeek.SUN,
  DayOfWeek.MON,
  DayOfWeek.TUE,
  DayOfWeek.WED,
  DayOfWeek.THU,
  DayOfWeek.FRI,
  DayOfWeek.SAT,
];

/**
 * Day-of-week of an IST date string (`YYYY-MM-DD`). Pure: parses the date
 * fields directly into `Date.UTC` and reads `getUTCDay()` — IST has no DST
 * so the IST day-of-week equals the UTC day-of-week of midnight UTC on the
 * same calendar date.
 */
export function istDayOfWeek(istDateStr: string): DayOfWeek {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(istDateStr);
  if (!m) {
    throw new Error(
      `istDayOfWeek: expected YYYY-MM-DD, received ${JSON.stringify(istDateStr)}`,
    );
  }
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const idx = new Date(utcMs).getUTCDay();
  // `idx` is in [0..6]; ALL_DAYS is indexed identically.
  return ALL_DAYS[idx]!;
}

/** True when the train operates on the day-of-week of `runDate` (IST). */
export function trainRunsOn(train: Train, runDate: string): boolean {
  return train.runsOnDays.includes(istDayOfWeek(runDate));
}

// ---------------------------------------------------------------------------
// Materialization — schedule + run date → absolute UTC window.
// ---------------------------------------------------------------------------

export interface MaterializedRun {
  /** UTC instant of the onward sign-on for the given run date. */
  departureTimeUtc: Date;
  /** UTC instant of the inward sign-off, factoring `inwardArrivalDayOffset`. */
  signOffTimeUtc: Date;
}

/**
 * Materialize the train's recurring schedule for a specific IST run date
 * into absolute UTC instants. Throws if the times-of-day or run-date string
 * are malformed, or if the resulting window is non-positive (sign-off must
 * be strictly after departure).
 *
 * Callers are expected to verify `trainRunsOn(train, runDate)` separately —
 * materialization is willing to operate on any date because some flows (a
 * "preview" of an arbitrary run) may need it. The orchestrator enforces the
 * runs-on-day rule via the `TRAIN_DOES_NOT_RUN_ON_DAY` error code.
 */
export function materializeRun(train: Train, runDate: string): MaterializedRun {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw new Error(
      `materializeRun: expected YYYY-MM-DD runDate, received ${JSON.stringify(runDate)}`,
    );
  }
  if (!Number.isInteger(train.inwardArrivalDayOffset) || train.inwardArrivalDayOffset < 0) {
    throw new Error(
      `materializeRun: inwardArrivalDayOffset must be a non-negative integer (got ${train.inwardArrivalDayOffset})`,
    );
  }

  const departureTimeUtc = istWallClockToUtc(`${runDate}T${train.departureTimeOfDay}`);
  const arrivalDate = addDaysIso(runDate, train.inwardArrivalDayOffset);
  const signOffTimeUtc = istWallClockToUtc(
    `${arrivalDate}T${train.inwardArrivalTimeOfDay}`,
  );

  if (signOffTimeUtc.getTime() <= departureTimeUtc.getTime()) {
    throw new Error(
      `materializeRun: signOff (${signOffTimeUtc.toISOString()}) must be strictly after departure (${departureTimeUtc.toISOString()}) for runDate ${runDate}`,
    );
  }

  return { departureTimeUtc, signOffTimeUtc };
}

/**
 * Add an integer number of calendar days to a `YYYY-MM-DD` IST date. Uses
 * `Date.UTC` so the math is timezone-clean (IST has no DST).
 */
function addDaysIso(isoDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) {
    throw new Error(`addDaysIso: bad isoDate ${JSON.stringify(isoDate)}`);
  }
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(utcMs + days * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// Domain types — pure. No I/O, no Date.now(), no imports from outside src/domain/.
// Source of truth: LLD.md §1–§2, §4.

// ---------------------------------------------------------------------------
// 1.1 Enums
// ---------------------------------------------------------------------------

export enum TrainType {
  PASSENGER     = 'PASSENGER',
  MEMU          = 'MEMU',
  DEMU          = 'DEMU',
  MAIL_EXPRESS  = 'MAIL_EXPRESS',
  VANDE_BHARAT  = 'VANDE_BHARAT',
  AMRIT_BHARAT  = 'AMRIT_BHARAT',
}

export enum LpCategory {
  MAIL_EXPRESS = 'MAIL_EXPRESS', // higher rank
  PASSENGER    = 'PASSENGER',    // lower rank
}

/**
 * IST days of week used by the recurring train schedule (M9).
 *
 * The string values are stable over the wire and in CSV. Numeric ordering
 * (SUN=0, MON=1, ...) matches `Date.getUTCDay()` so we can index by the IST
 * day-of-week and compare without case shifts. See `runSchedule.ts`.
 */
export enum DayOfWeek {
  SUN = 'SUN',
  MON = 'MON',
  TUE = 'TUE',
  WED = 'WED',
  THU = 'THU',
  FRI = 'FRI',
  SAT = 'SAT',
}

/**
 * Time-of-day in IST as `HH:MM` (24-hour). The schema enforces the format;
 * the type alias documents intent at usage sites.
 */
export type TimeOfDayString = string;

// ---------------------------------------------------------------------------
// 2. Domain Model
// ---------------------------------------------------------------------------

export interface LocoPilot {
  id: string;
  name: string;
  category: LpCategory;
  /**
   * Train types this LP is certified for. Source of truth for eligibility
   * (see `isLpEligible`). MAY include any of the six TrainType values —
   * including `PASSENGER` and `MAIL_EXPRESS`. `category` is a label only
   * and does not participate in the eligibility decision.
   */
  eligibleTrainTypes: TrainType[];
  /** UTC; undefined for brand-new crew. */
  lastSignOffTime?: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

export interface AssistantLocoPilot {
  id: string;
  name: string;
  /**
   * Train types this ALP is certified for. MEMU and DEMU MUST NOT appear here
   * (those train types do not require an ALP).
   */
  eligibleTrainTypes: TrainType[];
  /** UTC; undefined for brand-new crew. */
  lastSignOffTime?: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

export interface Train {
  id: string;
  /** Unique and stable across time — see LLD §6 standard. */
  number: string;
  name: string;
  type: TrainType;
  onwardFromStation: string;
  onwardToStation: string;
  /**
   * Days of the IST week on which this train operates. Non-empty, no
   * duplicates. The Trains tab filters its list by `dayOfWeek(selectedDate)`
   * — only trains whose `runsOnDays` contains that day appear (M9).
   */
  runsOnDays: DayOfWeek[];
  /** IST departure time-of-day (`HH:MM`, 24h). Sign-on for the day's run. */
  departureTimeOfDay: TimeOfDayString;
  /** Display-only; no rule reads this. */
  inwardTrainNumber: string;
  /** Display-only. */
  inwardFromStation: string;
  /** Display-only. */
  inwardToStation: string;
  /** IST inward-arrival time-of-day (`HH:MM`, 24h). Sign-off for the run. */
  inwardArrivalTimeOfDay: TimeOfDayString;
  /**
   * Days the inward arrival lands AFTER the run's departure date in IST.
   * 0 = same day, 1 = next day (overnight train), and so on. The orchestrator
   * uses this to materialize an absolute UTC sign-off instant for any run
   * date. See `materializeRun` in `runSchedule.ts`.
   */
  inwardArrivalDayOffset: number;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

export interface Assignment {
  id: string;
  trainId: string;
  /**
   * IST calendar date (`YYYY-MM-DD`) the assignment is for. Together with
   * `trainId` this disambiguates which run of a recurring train the
   * assignment belongs to (M9).
   */
  runDate: string;
  lpId: string;
  /** Absent for MEMU/DEMU. */
  alpId?: string;
  /** UTC, materialized from `train.departureTimeOfDay` + `runDate` at create time. */
  departureTime: Date;
  /**
   * UTC sign-off — materialized from `train.inwardArrivalTimeOfDay` +
   * `train.inwardArrivalDayOffset` + `runDate` at create time.
   */
  signOffTime: Date;
  /** UTC. */
  createdAt: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

// ---------------------------------------------------------------------------
// 4. Error Contract — structured, never raw strings.
// ---------------------------------------------------------------------------

export type AssignmentError =
  | { code: 'LP_NOT_ELIGIBLE'; lpId: string; trainType: TrainType }
  | { code: 'LP_REST_VIOLATION'; lpId: string; requiredHours: number; actualHours: number }
  | { code: 'LP_WINDOW_CONFLICT'; lpId: string; conflictingAssignmentId: string }
  | { code: 'ALP_NOT_ELIGIBLE'; alpId: string; trainType: TrainType }
  | { code: 'ALP_REST_VIOLATION'; alpId: string; requiredHours: number; actualHours: number }
  | { code: 'ALP_WINDOW_CONFLICT'; alpId: string; conflictingAssignmentId: string }
  | { code: 'ALP_REQUIRED_BUT_MISSING'; trainType: TrainType }
  | { code: 'ALP_NOT_ALLOWED'; trainType: TrainType }
  | { code: 'ARCHIVED_ENTITY'; entity: 'TRAIN' | 'LP' | 'ALP'; id: string }
  | { code: 'TRAIN_DOES_NOT_RUN_ON_DAY'; trainId: string; runDate: string; dayOfWeek: DayOfWeek }
  | { code: 'ALREADY_ASSIGNED'; trainId: string; runDate: string; conflictingAssignmentId: string };

export type AssignmentErrorCode = AssignmentError['code'];

// ---------------------------------------------------------------------------
// Result helper — Rust-style discriminated union for the orchestrator.
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok  = <T>(value: T): Result<T, never>  => ({ ok: true,  value });
export const err = <E>(error: E): Result<never, E>  => ({ ok: false, error });

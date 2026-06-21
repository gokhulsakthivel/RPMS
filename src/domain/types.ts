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

/**
 * Reason a crew member is unavailable on a calendar window.
 *
 * Sick leave, planned leave, training, and Periodic Rest (PR) all map to
 * the same eligibility outcome — the crew member cannot be assigned to a
 * run whose `runDate` falls within `[fromDate, toDate]`. The label is
 * preserved for reporting and for the rejection reason surfaced in the UI.
 *
 * PR (Periodic Rest) is the Indian Railways term for the mandatory weekly
 * rest period a running-staff crew member is entitled to under the
 * Hours of Employment Regulations. It is recorded the same way as any
 * other leave window — a contiguous `[fromDate, toDate]` slice during
 * which the crew member is unavailable.
 */
export enum LeaveType {
  SICK     = 'SICK',
  LEAVE    = 'LEAVE',
  TRAINING = 'TRAINING',
  PR       = 'PR',
}

/**
 * Crew role a leave window applies to. Discriminator on `Leave.crewRole`
 * so a single repo serves both the LP and ALP rosters without joining
 * across workforce tables.
 */
export type CrewRole = 'LP' | 'ALP';

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
  /**
   * Foreign-staff tag: crew physically on the board but not tracked by
   * this depot. Excluded from default `list()` enumerations (summary
   * counts, assignable lists, Crew page) but still resolvable by id so
   * the Links board can display them.
   */
  isForeign?: boolean;
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
  /** See `LocoPilot.isForeign`. */
  isForeign?: boolean;
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
  /**
   * Second ALP. Only set for train types whose `requiredAlpCount` is 2
   * (currently AMRIT_BHARAT). MUST be different from `alpId` when set.
   */
  alpId2?: string;
  /** UTC, materialized from `train.departureTimeOfDay` + `runDate` at create time. */
  departureTime: Date;
  /**
   * UTC sign-off — materialized from `train.inwardArrivalTimeOfDay` +
   * `train.inwardArrivalDayOffset` + `runDate` at create time.
   */
  signOffTime: Date;
  /**
   * Snapshot of the LP's `lastSignOffTime` *before* this assignment stamped
   * a new value on it. Captured at create-time and rotated when the LP is
   * swapped via `updateAssignment`. On archive (delete) this value is
   * restored to the LP so their rest clock returns to its pre-assignment
   * state. `undefined` means the LP had never signed off before this row.
   */
  previousLpSignOffTime?: Date;
  /**
   * Snapshot of the ALP's `lastSignOffTime` *before* this assignment. Same
   * rotate-on-edit / restore-on-delete semantics as `previousLpSignOffTime`.
   * Always `undefined` when the assignment carries no ALP (MEMU/DEMU).
   */
  previousAlpSignOffTime?: Date;
  /** Mirror of `previousAlpSignOffTime` for the second ALP slot (Amrit Bharat). */
  previousAlpSignOffTime2?: Date;
  /** UTC. */
  createdAt: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

/**
 * A calendar window during which a single crew member (LP or ALP) is
 * unavailable. The window is **inclusive on both ends** in IST calendar
 * dates — `fromDate <= runDate <= toDate` blocks a run.
 *
 * The shape is intentionally flat: one row per window per crew member.
 * Renewing or extending a leave creates a new row rather than mutating
 * an existing one, keeping the ledger append-friendly.
 *
 * Soft-archive only: `archivedAt` retracts the window without losing
 * the audit trail.
 */
export interface Leave {
  id: string;
  /** LP.id or ALP.id depending on `crewRole`. */
  crewId: string;
  crewRole: CrewRole;
  type: LeaveType;
  /** Inclusive start, IST `YYYY-MM-DD`. */
  fromDate: string;
  /** Inclusive end, IST `YYYY-MM-DD`. MUST be `>= fromDate`. */
  toDate: string;
  /** Free-text note for operators. Optional. */
  reason?: string;
  /** UTC. */
  createdAt: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

/**
 * A buffered, server-persisted assignment edit. Operators stage Assign /
 * Edit / Delete actions on the Assignments tab into a "draft cart" that is
 * stored on the server (rather than in browser state) so a page reload, a
 * second tab, or a second operator all see the same pending changes. The
 * cart is drained by the bulk-commit endpoint, which calls `assignCrew`,
 * `updateAssignment`, or `archive` for each draft in turn.
 *
 * Uniqueness: at most one active draft per `(trainId, runDate)`.
 *
 * Field semantics by `kind`:
 *
 * - `create`:  `lpId`/`lpName` populated; `alpId`/`alpName` populated only
 *              when the train type requires an ALP. `assignmentId` and
 *              `originalLp/Alp*` are absent.
 * - `update`:  `assignmentId` is the persisted row to mutate; `lpId`/`lpName`
 *              are the NEW pick (and `alpId`/`alpName` for ALP-required types).
 *              `originalLpName`/`originalAlpName` snapshot the previous values
 *              for "before → after" display.
 * - `delete`:  `assignmentId` is the persisted row to archive. `lpName`/
 *              `alpName` snapshot the crew about to be archived (display only).
 *              `lpId`/`alpId`/`originalLp/Alp*` are absent.
 */
export type AssignmentDraftKind = 'create' | 'update' | 'delete';

export interface AssignmentDraft {
  id: string;
  kind: AssignmentDraftKind;
  trainId: string;
  trainNumber: string;
  trainName: string;
  trainType: TrainType;
  /** IST calendar date (`YYYY-MM-DD`) — together with `trainId` keys the row. */
  runDate: string;
  /** Materialized UTC departure for the run — kept for client-side sorting. */
  departureTime: Date;
  /** Required when `kind === 'update' | 'delete'`. */
  assignmentId?: string;
  /** New pick. Required when `kind === 'create' | 'update'`. */
  lpId?: string;
  /** Display name. Required when `kind === 'create' | 'update'`; on `'delete'`
   *  this carries the snapshot of the LP about to be archived. */
  lpName?: string;
  /** New pick. Set when the train type requires an ALP and a draft pick exists. */
  alpId?: string;
  /** Display name; same dual role as `lpName` on `'delete'`. */
  alpName?: string;
  /** Second ALP pick — only when the train type requires two ALPs (Amrit Bharat). */
  alpId2?: string;
  /** Display name for the second ALP — same dual role as `alpName` on `'delete'`. */
  alpName2?: string;
  /** Snapshot of the previous LP — only set when `kind === 'update'`. */
  originalLpName?: string;
  /** Snapshot of the previous ALP — only set when `kind === 'update'`. */
  originalAlpName?: string;
  /** Snapshot of the previous second ALP — only set when `kind === 'update'`. */
  originalAlpName2?: string;
  /** UTC. */
  createdAt: Date;
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
  | { code: 'SECOND_ALP_REQUIRED_BUT_MISSING'; trainType: TrainType }
  | { code: 'ALP_DUPLICATE'; alpId: string }
  | { code: 'ALP_NOT_ALLOWED'; trainType: TrainType }
  | { code: 'SECOND_ALP_NOT_ALLOWED'; trainType: TrainType }
  | { code: 'ARCHIVED_ENTITY'; entity: 'TRAIN' | 'LP' | 'ALP'; id: string }
  | { code: 'TRAIN_DOES_NOT_RUN_ON_DAY'; trainId: string; runDate: string; dayOfWeek: DayOfWeek }
  | { code: 'ALREADY_ASSIGNED'; trainId: string; runDate: string; conflictingAssignmentId: string }
  | { code: 'LP_ON_LEAVE'; lpId: string; leaveType: LeaveType; fromDate: string; toDate: string }
  | { code: 'ALP_ON_LEAVE'; alpId: string; leaveType: LeaveType; fromDate: string; toDate: string };

export type AssignmentErrorCode = AssignmentError['code'];

// ---------------------------------------------------------------------------
// Result helper — Rust-style discriminated union for the orchestrator.
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok  = <T>(value: T): Result<T, never>  => ({ ok: true,  value });
export const err = <E>(error: E): Result<never, E>  => ({ ok: false, error });

// ---------------------------------------------------------------------------
// 5. Links — predefined duty rotations (HLD §4.9–§4.11, LLD §2.1).
// ---------------------------------------------------------------------------

/**
 * Kinds of position inside a Link cycle.
 *
 * - `DUTY` — one tour of duty composed of one or more chained train segments.
 *            Same-position segments are treated as one continuous tour by the
 *            Auto-Draft orchestrator (HLD §4.11). Ad-hoc assignments still
 *            enforce the full 16-hour rest rule between segments.
 * - `OFF`  — a single calendar day off. No duty, no formal rest accounting.
 * - `PR`   — Periodic Rest. A long rest block (typically ≥ 30h) that
 *            satisfies §4.3 between the surrounding duty positions.
 */
export enum LinkPositionKind {
  DUTY = 'DUTY',
  OFF  = 'OFF',
  PR   = 'PR',
}

/**
 * One train run inside a `DUTY` position. Times are IST `HH:MM` strings —
 * absolute UTC instants are materialized at use-time via `shared/time.ts`,
 * matching how `Train.departureTimeOfDay` is handled.
 */
export interface LinkSegment {
  /** Train number — joined to `Train.number` (the unique-forever identifier). */
  trainNumber: string;
  /**
   * Position of this segment within its DUTY position— sourced from the
   * printed depot link sheet's `Direction` column:
   *   - `outward` = depot-leaving leg (originates from the home depot).
   *   - `inward`  = depot-arriving leg (terminates at the home depot).
   *   - `conti`   = middle leg of a multi-segment chain that neither
   *                 starts nor ends a depot trip (e.g. shuttle in the
   *                 hills).
   * Optional for backwards compatibility — callers that need direction
   * dispatch fall back to inferring from `fromStation` / `toStation`.
   */
  direction?: 'outward' | 'inward' | 'conti';
  /**
   * Originating station code as printed on the depot link sheet (e.g. `CBE`,
   * `MTP`, `ERS`). Optional for backwards compatibility with older link
   * data; when present the UI uses it verbatim instead of joining on the
   * trains roster.
   */
  fromStation?: string;
  /** Destination station code as printed on the depot link sheet. */
  toStation?: string;
  /** IST `HH:MM` (24h) — sign-on at the start of this segment. */
  signOnTimeOfDay: TimeOfDayString;
  /** IST `HH:MM` (24h) — sign-off at the end of this segment. */
  signOffTimeOfDay: TimeOfDayString;
  /**
   * Days the segment's sign-off lands AFTER the position's run date in IST.
   * 0 = same day, 1 = next day (overnight), and so on. Capped at 3 — no real
   * Indian Railways link segment exceeds that envelope.
   */
  signOffDayOffset: number;
}

/** A single position in a Link cycle. Discriminated on `kind`. */
export type LinkPosition =
  | { positionNumber: number; kind: LinkPositionKind.DUTY; segments: LinkSegment[] }
  | { positionNumber: number; kind: LinkPositionKind.OFF }
  | { positionNumber: number; kind: LinkPositionKind.PR  };

/**
 * A predefined duty rotation. The cycle has `cycleLength` positions, and
 * `positions[i].positionNumber === i + 1` for every i. The CSV loader
 * enforces this and the per-kind invariants (DUTY needs ≥ 1 segment, etc.).
 */
export interface Link {
  id: string;
  /** Display label, e.g. `CBE MAIL LINK - 19 MEN`. */
  name: string;
  /** Crew role this link is for — drives which roster supplies memberships. */
  crewRole: CrewRole;
  /**
   * Optional role label. Set ONLY when `crewRole === 'LP'` and the link is
   * authored for a specific LP category (e.g. Mail Express LPs only). The
   * loader rejects rows where this is set with `crewRole === 'ALP'`.
   */
  lpCategory?: LpCategory;
  /** Cycle length — equal to `positions.length`. Always ≥ 1. */
  cycleLength: number;
  /** Ordered list, `positions.length === cycleLength`. */
  positions: LinkPosition[];
  /** UTC. */
  createdAt: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

/**
 * Places one crew member on one Link. The pair `(anchorDate,
 * anchorPositionNumber)` makes the rotation deterministic for any future or
 * past calendar date — see `linkSchedule.positionOnDate`.
 *
 * `crewRole` MUST equal the parent Link's `crewRole`. The loader and Phase 1
 * API both reject violations.
 */
export interface LinkMembership {
  id: string;
  linkId: string;
  /** LP.id when `crewRole === 'LP'`, ALP.id when `crewRole === 'ALP'`. */
  crewId: string;
  crewRole: CrewRole;
  /** IST calendar date `YYYY-MM-DD` at which `anchorPositionNumber` applies. */
  anchorDate: string;
  /** 1-based position the crew member sits at on `anchorDate`. */
  anchorPositionNumber: number;
  /** UTC. */
  createdAt: Date;
  /** UTC; undefined for active rows. */
  archivedAt?: Date;
}

/**
 * Per-day override for a Periodic Rest (PR) position on a Link.
 *
 * The Links projection resolves a default crew for each PR slot via the
 * normal rotation. A `PrAssignment` overrides that default for one IST
 * `runDate`. Uniqueness key: `(linkId, positionNumber, runDate)`.
 *
 * - `crewId` populated  -> operator picked a different crew for this PR day.
 * - `crewId` empty      -> operator explicitly suppressed the PR for this day
 *                          ("no PR today"). Projection consumers should treat
 *                          this as a deliberate absence rather than a default.
 *
 * No row in the table   -> fall back to the projection default.
 */
export interface PrAssignment {
  id: string;
  linkId: string;
  positionNumber: number;
  /** IST calendar date `YYYY-MM-DD`. */
  runDate: string;
  crewRole: CrewRole;
  /** Empty string = explicit "no PR today" override. */
  crewId: string;
  createdAt: Date;
  updatedAt: Date;
}


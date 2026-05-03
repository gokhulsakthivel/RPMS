// Zod schemas shared by frontend (form validation) and backend
// (request-body validation). One source of truth keeps the two in lockstep
// per techstack.md §2.
//
// Wire format: timestamps travel as ISO-8601 strings; the schemas transform
// them into JS `Date` objects so the orchestrator and repos see real
// `Date` instances.

import { z } from 'zod';
import { DayOfWeek, LeaveType, LpCategory, TrainType } from '../domain/types';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, parsed into a `Date`. */
const isoUtcDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

/** `YYYY-MM-DD` calendar date used by the `?date=` query param. */
const isoCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Native enum schemas for the two domain enums. */
const trainTypeSchema = z.nativeEnum(TrainType);
const lpCategorySchema = z.nativeEnum(LpCategory);
const dayOfWeekSchema = z.nativeEnum(DayOfWeek);
const leaveTypeSchema = z.nativeEnum(LeaveType);
const crewRoleSchema = z.enum(['LP', 'ALP']);

/**
 * IST time-of-day, 24h `HH:MM`. Used by the recurring train schedule (M9):
 * `departureTimeOfDay` and `inwardArrivalTimeOfDay`. The orchestrator
 * materializes these into absolute UTC instants per run-date via
 * `runSchedule.materializeRun`.
 */
const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');

/** Non-empty trimmed string for names, station codes, etc. */
const nonEmptyString = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Train — create / update
// ---------------------------------------------------------------------------

/**
 * `runsOnDays` is a non-empty subset of `DayOfWeek`. Duplicates are rejected
 * because they encode no extra meaning and would silently bloat the CSV row.
 */
const runsOnDaysSchema = z
  .array(dayOfWeekSchema)
  .min(1, 'runsOnDays must contain at least one day')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'runsOnDays must not contain duplicate days',
  });

/**
 * Inward-arrival day offset relative to the run's departure date.
 * 0 = same IST day, 1 = next day (overnight train), 2 = +2 days, 3 = +3 days.
 * Capped at 3 because no real Indian Railways run exceeds that envelope.
 */
const inwardArrivalDayOffsetSchema = z
  .number()
  .int('inwardArrivalDayOffset must be an integer')
  .min(0, 'inwardArrivalDayOffset must be ≥ 0')
  .max(3, 'inwardArrivalDayOffset must be ≤ 3');

const trainCreateBase = z.object({
  number: nonEmptyString,
  name: nonEmptyString,
  type: trainTypeSchema,
  onwardFromStation: nonEmptyString,
  onwardToStation: nonEmptyString,
  runsOnDays: runsOnDaysSchema,
  departureTimeOfDay: timeOfDaySchema,
  inwardTrainNumber: nonEmptyString,
  inwardFromStation: nonEmptyString,
  inwardToStation: nonEmptyString,
  inwardArrivalTimeOfDay: timeOfDaySchema,
  inwardArrivalDayOffset: inwardArrivalDayOffsetSchema,
});

/**
 * No cross-field refinement here. The "arrival strictly after departure"
 * invariant is checked per-run by `runSchedule.materializeRun` because the
 * absolute UTC window depends on the run date. A schedule like
 * `dep=22:00, arr=06:00, offset=1` is valid even though `06:00 < 22:00`
 * as wall-clock strings.
 */
export const TrainCreateInput = trainCreateBase;
export type TrainCreateInput = z.infer<typeof TrainCreateInput>;

/** All fields optional for PUT. */
export const TrainUpdateInput = trainCreateBase.partial();
export type TrainUpdateInput = z.infer<typeof TrainUpdateInput>;

// ---------------------------------------------------------------------------
// Loco Pilot — create / update
// ---------------------------------------------------------------------------

/**
 * LP `eligibleTrainTypes` is the source of truth for eligibility. Any of the
 * six TrainType values may appear — including `PASSENGER` and `MAIL_EXPRESS`.
 * `category` is a label only and does not constrain this list. See HLD §4.2.
 */
const lpEligibleTrainTypes = z.array(trainTypeSchema);

export const LocoPilotCreateInput = z.object({
  name: nonEmptyString,
  category: lpCategorySchema,
  eligibleTrainTypes: lpEligibleTrainTypes,
});
export type LocoPilotCreateInput = z.infer<typeof LocoPilotCreateInput>;

/**
 * Update accepts everything optional. `lastSignOffTime` is exposed here as
 * the **manual override** path documented in HLD §4.7 — used by the Edit
 * Crew flow. Not present on Create.
 */
export const LocoPilotUpdateInput = z.object({
  name: nonEmptyString.optional(),
  category: lpCategorySchema.optional(),
  eligibleTrainTypes: lpEligibleTrainTypes.optional(),
  lastSignOffTime: isoUtcDate.nullable().optional(),
});
export type LocoPilotUpdateInput = z.infer<typeof LocoPilotUpdateInput>;

// ---------------------------------------------------------------------------
// Assistant Loco Pilot — create / update
// ---------------------------------------------------------------------------

/**
 * ALPs are NEVER assigned to MEMU or DEMU — those types must not appear in
 * `eligibleTrainTypes`. See HLD §4.5 / LLD §6 standard.
 */
const alpEligibleTrainTypes = z
  .array(trainTypeSchema)
  .refine(
    (types) =>
      !types.includes(TrainType.MEMU) && !types.includes(TrainType.DEMU),
    {
      message:
        'eligibleTrainTypes must not include MEMU or DEMU — ALPs are not assigned to those train types',
    },
  );

export const AlpCreateInput = z.object({
  name: nonEmptyString,
  eligibleTrainTypes: alpEligibleTrainTypes,
});
export type AlpCreateInput = z.infer<typeof AlpCreateInput>;

export const AlpUpdateInput = z.object({
  name: nonEmptyString.optional(),
  eligibleTrainTypes: alpEligibleTrainTypes.optional(),
  lastSignOffTime: isoUtcDate.nullable().optional(),
});
export type AlpUpdateInput = z.infer<typeof AlpUpdateInput>;

// ---------------------------------------------------------------------------
// Leave — create / update
// ---------------------------------------------------------------------------

/**
 * `[fromDate, toDate]` is **inclusive** on both ends in IST `YYYY-MM-DD`.
 * The cross-field refinement guarantees `toDate >= fromDate` so the UI
 * cannot silently submit an empty window.
 */
const leaveDateRange = z
  .object({
    fromDate: isoCalendarDate,
    toDate: isoCalendarDate,
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: 'toDate must be on or after fromDate',
    path: ['toDate'],
  });

/**
 * Optional reason note. Trimmed and capped to keep CSV rows readable.
 * Empty string is normalised to `undefined` so the wire shape never
 * carries a meaningless blank.
 */
const reasonField = z
  .string()
  .trim()
  .max(200, 'reason must be ≤ 200 characters')
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const LeaveCreateInput = z
  .object({
    crewId: nonEmptyString,
    crewRole: crewRoleSchema,
    type: leaveTypeSchema,
    reason: reasonField,
  })
  .and(leaveDateRange);
export type LeaveCreateInput = z.infer<typeof LeaveCreateInput>;

/**
 * Update accepts everything optional, including the date window — but if
 * either endpoint is supplied, both must be (and the inclusive-order rule
 * is re-checked). Operators changing only `reason` or `type` skip the
 * date pair entirely.
 */
export const LeaveUpdateInput = z
  .object({
    crewId: nonEmptyString.optional(),
    crewRole: crewRoleSchema.optional(),
    type: leaveTypeSchema.optional(),
    fromDate: isoCalendarDate.optional(),
    toDate: isoCalendarDate.optional(),
    reason: reasonField,
  })
  .refine(
    (v) =>
      (v.fromDate === undefined && v.toDate === undefined) ||
      (v.fromDate !== undefined && v.toDate !== undefined),
    {
      message: 'fromDate and toDate must be supplied together',
      path: ['toDate'],
    },
  )
  .refine(
    (v) =>
      v.fromDate === undefined ||
      v.toDate === undefined ||
      v.toDate >= v.fromDate,
    {
      message: 'toDate must be on or after fromDate',
      path: ['toDate'],
    },
  );
export type LeaveUpdateInput = z.infer<typeof LeaveUpdateInput>;

// ---------------------------------------------------------------------------
// Assignment — create
// ---------------------------------------------------------------------------

/**
 * The orchestrator looks up the train, LP, and (optional) ALP from these IDs,
 * materializes the recurring schedule against `runDate`, and runs
 * `assignCrew`. The body intentionally does NOT carry departure or
 * sign-off times — those are derived server-side from the train schedule
 * per HLD §4.4 and M9 plan §6.
 */
export const AssignCrewInput = z.object({
  trainId: nonEmptyString,
  /** IST calendar date (`YYYY-MM-DD`) selecting which run of the train. */
  runDate: isoCalendarDate,
  lpId: nonEmptyString,
  alpId: nonEmptyString.optional(),
});
export type AssignCrewInput = z.infer<typeof AssignCrewInput>;

// ---------------------------------------------------------------------------
// Assignment — update (PUT)
// ---------------------------------------------------------------------------

/**
 * Edit-an-assignment payload. Only crew slots are mutable through the UI —
 * the train + runDate uniqueness key is intentionally fixed (re-assigning to
 * a different train means archiving the old assignment and creating a new
 * one). All fields optional so an operator can change just the LP or just
 * the ALP. The orchestrator re-runs eligibility / rest / leave / window
 * checks against the existing run window before persisting.
 *
 * `alpId: null` explicitly clears the ALP slot (only valid for MEMU/DEMU
 * mistakes — the orchestrator rejects it for ALP-required trains).
 */
export const AssignmentUpdateInput = z
  .object({
    lpId: nonEmptyString.optional(),
    alpId: nonEmptyString.nullable().optional(),
  })
  .refine((v) => v.lpId !== undefined || v.alpId !== undefined, {
    message: 'at least one of lpId / alpId must be supplied',
  });
export type AssignmentUpdateInput = z.infer<typeof AssignmentUpdateInput>;

// ---------------------------------------------------------------------------
// Assignment Drafts — server-persisted "draft cart" entries.
// ---------------------------------------------------------------------------
//
// The Assignments tab stages every Assign / Edit / Delete action into a
// server-side cart instead of mutating the CSV directly. The toolbar
// "+ Assign (N)" button drains the cart by calling the regular orchestrators.
//
// One row per `(trainId, runDate)`. The wire format is a discriminated union
// on `kind` so the frontend renders without a per-row branch.

/** Materialized UTC departure for the run, ISO-8601 with offset. */
const departureTimeWire = z
  .string()
  .datetime({ offset: true });

/** Display fields every staged op carries — keeps the table renderable
 *  without re-fetching crew/train rows. */
const stagedDisplayFields = {
  trainId: nonEmptyString,
  trainNumber: nonEmptyString,
  trainName: nonEmptyString,
  trainType: trainTypeSchema,
  runDate: isoCalendarDate,
  departureTime: departureTimeWire,
};

const assignmentDraftCreateSchema = z.object({
  kind: z.literal('create'),
  ...stagedDisplayFields,
  lpId: nonEmptyString,
  lpName: nonEmptyString,
  /** Null when the train type doesn't require an ALP (MEMU/DEMU). */
  alpId: nonEmptyString.nullable(),
  alpName: z.string().nullable(),
});

const assignmentDraftUpdateSchema = z.object({
  kind: z.literal('update'),
  ...stagedDisplayFields,
  assignmentId: nonEmptyString,
  /** Snapshot of the row's previously-persisted crew (display-only). */
  originalLpName: z.string(),
  originalAlpName: z.string().nullable(),
  /** New picks. */
  lpId: nonEmptyString,
  lpName: nonEmptyString,
  alpId: nonEmptyString.nullable(),
  alpName: z.string().nullable(),
});

const assignmentDraftDeleteSchema = z.object({
  kind: z.literal('delete'),
  ...stagedDisplayFields,
  assignmentId: nonEmptyString,
  /** Snapshot of the crew about to be archived (display-only). */
  lpName: z.string(),
  alpName: z.string().nullable(),
});

/**
 * Request body for `POST /api/assignment-drafts` and the wire shape of
 * each row in the `GET /api/assignment-drafts?date=...` response. The
 * server upserts by `(trainId, runDate)` so re-staging is idempotent.
 */
export const AssignmentDraftStageInput = z.discriminatedUnion('kind', [
  assignmentDraftCreateSchema,
  assignmentDraftUpdateSchema,
  assignmentDraftDeleteSchema,
]);
export type AssignmentDraftStageInput = z.infer<
  typeof AssignmentDraftStageInput
>;

/** A single row in the GET response — same shape as the input. */
export type AssignmentDraftRow = AssignmentDraftStageInput;

/**
 * Per-draft outcome from the bulk-commit endpoint. Successful drafts are
 * deleted from the cart server-side; failures stay so the operator can fix
 * and retry without re-keying picks.
 */
export type AssignmentDraftCommitResult =
  | { trainId: string; success: true }
  | {
      trainId: string;
      success: false;
      error: ApiErrorResponse;
    };

export interface AssignmentDraftCommitResponse {
  results: AssignmentDraftCommitResult[];
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const DateQuery = z.object({ date: isoCalendarDate });
export type DateQuery = z.infer<typeof DateQuery>;

/**
 * Eligible-crew query. `runDate` is required because rest and window
 * checks anchor on the materialized UTC departure for that specific run
 * of the recurring schedule (M9).
 */
export const TrainIdQuery = z.object({
  trainId: nonEmptyString,
  runDate: isoCalendarDate,
});
export type TrainIdQuery = z.infer<typeof TrainIdQuery>;

// ---------------------------------------------------------------------------
// Response shapes — server → client. Documented here so the SPA imports
// types and never re-derives them.
// ---------------------------------------------------------------------------

export interface TrainRow {
  id: string;
  number: string;
  name: string;
  type: TrainType;
  onwardFromStation: string;
  onwardToStation: string;
  /**
   * The IST run-date this row is materialized against (`YYYY-MM-DD`).
   * The list endpoint produces one row per train per selected date.
   */
  runDate: string;
  /** Days the recurring train operates. Drives the "Runs on" cell (M9). */
  runsOnDays: DayOfWeek[];
  /** Raw IST departure time-of-day, `HH:MM`. The form hydrates from this. */
  departureTimeOfDay: string;
  /** Raw IST inward-arrival time-of-day, `HH:MM`. */
  inwardArrivalTimeOfDay: string;
  /** 0 = same day, 1 = next day, ... */
  inwardArrivalDayOffset: number;
  /** Materialized ISO-8601 UTC departure for `runDate`. */
  departureTime: string;
  inwardTrainNumber: string;
  inwardFromStation: string;
  inwardToStation: string;
  /** Materialized ISO-8601 UTC inward arrival for `runDate`. */
  inwardArrivalTime: string;
}

/**
 * The server-projected row used by the unified Crew table (design.md §9.2).
 * The UI never recomputes any of these fields.
 */
export interface CrewRow {
  id: string;
  kind: 'LP' | 'ALP';
  name: string;
  /**
   * Highest-rank drivable type by the design.md §9.2 hierarchy ordering.
   * `null` only for ALPs with no certifications (a brand-new ALP). The
   * "All types" UX appears in `eligibleForLabel`, not here.
   */
  grade: TrainType | null;
  status: 'available' | 'resting';
  rest: {
    /** Hours remaining until rested; 0 if already available. UI applies `Math.ceil`. */
    hoursRemaining: number;
    /** True if the crew member has never signed off — they're immediately available. */
    neverSignedOff: boolean;
  };
  /** Free-form label for the "Eligible for" column, e.g. "Mail/Express, VB". */
  eligibleForLabel: string;
  /**
   * Raw editable fields. The display columns above are projection-only —
   * the Edit Crew modal hydrates its form from this slice so a separate
   * "fetch single record" endpoint isn't needed (design.md §9.2 actions).
   */
  editable: {
    /** Only present when `kind === 'LP'`. */
    category?: LpCategory;
    /**
     * The raw `eligibleTrainTypes` array from the underlying record —
     * NOT the derived drivable set. For LP this is the specialty certs
     * (no PASSENGER/MAIL_EXPRESS); for ALP, no MEMU/DEMU.
     */
    eligibleTrainTypes: TrainType[];
    /** ISO-8601 UTC; `null` when the crew member has never signed off. */
    lastSignOffTime: string | null;
  };
}

/**
 * The Assignments tab row (components.md §10 / design.md §9.3). Keyed by
 * Train, with the **currently active** assigned crew inlined for display.
 *
 * - `lp: null` → "Not assigned" in red.
 * - `alp: null` → "Not assigned" in red (only on non-MEMU/DEMU trains).
 * - `alp: 'NOT_REQUIRED'` → "Not required" in muted grey (only on MEMU/DEMU).
 * - `isAssignable` is server-computed: `true` only when the train still has
 *   an unfilled slot under the rules.
 */
export interface AssignmentRow {
  trainId: string;
  trainNumber: string;
  trainName: string;
  trainType: TrainType;
  /** IST run-date this row represents (`YYYY-MM-DD`). */
  runDate: string;
  /** Materialized ISO-8601 UTC departure for `runDate`; UI renders IST. */
  departureTime: string;
  lp: { id: string; name: string } | null;
  alp:
    | { id: string; name: string } // assigned
    | null                          // eligible-but-empty → "Not assigned"
    | 'NOT_REQUIRED';               // MEMU/DEMU sentinel
  isAssignable: boolean;
  /**
   * The id of the **currently active** assignment for `(trainId, runDate)`,
   * or `null` if no crew has been assigned yet. Drives the Edit / Delete
   * row actions on the Assignments tab — the SPA uses this to target
   * `PUT /api/assignments/:id` and `POST /api/assignments/:id/archive`.
   */
  assignmentId: string | null;
}

/**
 * The Trains tab row (design.md §9.1). Extends `TrainRow` with the inlined
 * "Currently assigned crew" projection so the table cell never refetches.
 */
export interface TrainWithAssignment extends TrainRow {
  /** Currently active assigned LP, or `null`. */
  lp: { id: string; name: string } | null;
  /**
   * Currently active assigned ALP. `null` for an ALP-eligible train with no
   * ALP yet; `'NOT_REQUIRED'` for MEMU/DEMU.
   */
  alp:
    | { id: string; name: string }
    | null
    | 'NOT_REQUIRED';
}

/** Per-kind aliases keep the SPA's typed-fetch wrappers semantically named. */
export type LpWithRestStatus = CrewRow & { kind: 'LP' };
export type AlpWithRestStatus = CrewRow & { kind: 'ALP' };

/**
 * Server projection for the Leaves tab (HLD §4.4 / design.md §9.5).
 *
 * Crew identity is denormalised onto the row so the table renders without
 * a second fetch. `crewName` is the display name resolved at projection
 * time; if the underlying crew record is later renamed the leave row
 * reflects the new name on the next list call. Archived leaves are
 * excluded by default — the toggle for showing them lives in the page,
 * not the wire shape.
 */
export interface LeaveRow {
  id: string;
  crewId: string;
  crewRole: 'LP' | 'ALP';
  /** Resolved at projection time. `'(unknown)'` if the crew record is missing. */
  crewName: string;
  type: LeaveType;
  /** Inclusive IST `YYYY-MM-DD`. */
  fromDate: string;
  /** Inclusive IST `YYYY-MM-DD`. */
  toDate: string;
  /** Optional free-text note; absent when blank. */
  reason?: string;
  /** ISO-8601 UTC. */
  createdAt: string;
}

/**
 * Bucket counts that drive the "Hidden: 8 not eligible, 2 on leave,
 * 3 still resting, 1 already assigned" footnote (components.md
 * §`HiddenCrewFootnote`). New buckets sit alongside the originals so the
 * footnote can mention any subset without reshaping the wire payload.
 */
export interface HiddenCount {
  notEligible: number;
  onLeave: number;
  resting: number;
  alreadyAssigned: number;
}

/** A crew option as it appears in the AssignCrewModal dropdown. */
export interface LpSummary {
  id: string;
  name: string;
  /** Server-projected highest-rank drivable type, for an inline mini-badge. */
  grade: TrainType | null;
}
export type AlpSummary = LpSummary;

/**
 * Response from `GET /api/eligible-crew?trainId=...`, consumed by
 * `AssignCrewModal` (components.md §`AssignCrewModal`). The
 * `assistant_loco_pilots` field is `null` for MEMU/DEMU — the SPA uses that
 * sentinel to skip the ALP slot entirely.
 */
export interface EligibleCrewResponse {
  train: TrainRow;
  loco_pilots: { eligible: LpSummary[]; hidden: HiddenCount };
  assistant_loco_pilots:
    | { eligible: AlpSummary[]; hidden: HiddenCount }
    | null;
}

/**
 * Summary cards strip rendered on every page (design.md §9.4). All four
 * numbers are scoped to the selected calendar date `D` in IST.
 */
export interface SummaryResponse {
  /** The IST calendar date this summary is scoped to (`YYYY-MM-DD`). */
  date: string;
  /** Active trains whose `departureTime` falls on calendar date `D` IST. */
  totalTrains: number;
  /**
   * Subset of `totalTrains` with **no active assignment** for that train.
   * MEMU/DEMU: counted unassigned iff there is no LP. Others: iff either LP
   * or ALP is missing.
   */
  unassignedTrains: number;
  /**
   * Active crew (LP + ALP combined) whose 16-hour rest is satisfied as of
   * the start of `D` 00:00 IST — i.e., `lastSignOffTime` is null OR
   * `lastSignOffTime + 16h ≤ start_of_D_IST_in_UTC`.
   */
  availableCrew: number;
  /** Active crew (LP + ALP combined) NOT in `availableCrew`. */
  restingCrew: number;
}

/** Unified error response wire format. Mirrors the domain `AssignmentError`. */
export interface ApiErrorResponse {
  code: string;
  // any additional context fields from the discriminated union
  [k: string]: unknown;
}

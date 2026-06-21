// Repository interfaces — declared in the domain layer per HLD §6.
// Implementations live in src/persistence/Csv*Repo.ts and are the only
// adapters in scope. Application/api code depends on these interfaces, never
// on the Csv* classes directly. See techstack.md §7.

import {
  Assignment,
  AssignmentDraft,
  AssistantLocoPilot,
  CrewRole,
  Leave,
  Link,
  LinkMembership,
  LocoPilot,
  PrAssignment,
  Train,
} from './types';

// ---------------------------------------------------------------------------
// Common option shapes
// ---------------------------------------------------------------------------

/** Default behaviour is `includeArchived: false` — list/findById skip archived rows. */
export type ActiveFilter = { includeArchived?: boolean };

/** Half-open UTC range used by date-scoped queries. */
export type DateRange = { fromUtc: Date; toUtcExclusive: Date };

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface LocoPilotRepo {
  findById(id: string, opts?: ActiveFilter): Promise<LocoPilot | null>;
  list(opts?: ActiveFilter): Promise<LocoPilot[]>;
  create(input: Omit<LocoPilot, 'id' | 'archivedAt'>): Promise<LocoPilot>;
  update(id: string, patch: Partial<Omit<LocoPilot, 'id'>>): Promise<LocoPilot>;
  /**
   * Routine sign-off update. The orchestrator calls this after a successful
   * `assignCrew`. Manual operator overrides go through `update` so intent is
   * explicit at the call site (HLD §4.7).
   */
  updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void>;
  archive(id: string): Promise<void>;
}

export interface AssistantLocoPilotRepo {
  findById(id: string, opts?: ActiveFilter): Promise<AssistantLocoPilot | null>;
  list(opts?: ActiveFilter): Promise<AssistantLocoPilot[]>;
  create(input: Omit<AssistantLocoPilot, 'id' | 'archivedAt'>): Promise<AssistantLocoPilot>;
  update(id: string, patch: Partial<Omit<AssistantLocoPilot, 'id'>>): Promise<AssistantLocoPilot>;
  updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void>;
  archive(id: string): Promise<void>;
}

export interface TrainRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Train | null>;
  /**
   * M9: trains carry a recurring weekly schedule, not an absolute departure
   * timestamp. Day-of-week filtering happens in the application layer via
   * `runSchedule.trainRunsOn` — the repo just returns the active set.
   */
  list(opts?: ActiveFilter): Promise<Train[]>;
  /** Train numbers are unique forever (LLD §6); used for collision checks on create/update. */
  findByNumber(number: string, opts?: ActiveFilter): Promise<Train | null>;
  create(input: Omit<Train, 'id' | 'archivedAt'>): Promise<Train>;
  update(id: string, patch: Partial<Omit<Train, 'id'>>): Promise<Train>;
  archive(id: string): Promise<void>;
}

export interface AssignmentRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Assignment | null>;
  create(a: Omit<Assignment, 'id' | 'createdAt' | 'archivedAt'>): Promise<Assignment>;
  /**
   * Patch the crew on an existing active assignment. The (trainId, runDate)
   * uniqueness key and timestamps are immutable through this path — only
   * `lpId` / `alpId` / `alpId2` and the per-crew `previousSignOffTime` snapshots
   * may be modified. `alpId: null` / `alpId2: null` clears the slot;
   * `previousLpSignOffTime: null` / `previousAlpSignOffTime: null` /
   * `previousAlpSignOffTime2: null` clear the snapshot when the prior crew had
   * never signed off. Throws if `id` is not found or already archived.
   */
  update(
    id: string,
    patch: {
      lpId?: string;
      alpId?: string | null;
      alpId2?: string | null;
      previousLpSignOffTime?: Date | null;
      previousAlpSignOffTime?: Date | null;
      previousAlpSignOffTime2?: Date | null;
    },
  ): Promise<Assignment>;
  list(opts?: ActiveFilter & { departingWithin?: DateRange }): Promise<Assignment[]>;
  /** Returns active assignments held by this LP or ALP (used for window-conflict checks). */
  listByCrew(crewId: string, opts?: ActiveFilter): Promise<Assignment[]>;
  listByTrain(trainId: string, opts?: ActiveFilter): Promise<Assignment[]>;
  archive(id: string): Promise<void>;
}

/**
 * Leave windows for a single crew member — see HLD §4.4.
 *
 * The `Leave` record discriminates LP vs. ALP via `crewRole` so a single
 * repo serves both rosters. Reads are typically `listByCrew(crewId)` from
 * the assignment orchestrator and `list()` from the Leaves UI.
 */
export interface LeaveRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Leave | null>;
  list(opts?: ActiveFilter): Promise<Leave[]>;
  /** All non-archived leaves for one crew member, regardless of role. */
  listByCrew(crewId: string, opts?: ActiveFilter): Promise<Leave[]>;
  /**
   * All non-archived leaves whose `[fromDate, toDate]` window includes
   * `runDate` (IST `YYYY-MM-DD`). Optionally narrow by role to avoid
   * cross-roster scans when the caller is projecting LP- or ALP-only.
   */
  listCoveringDate(runDate: string, opts?: ActiveFilter & { crewRole?: CrewRole }): Promise<Leave[]>;
  create(input: Omit<Leave, 'id' | 'createdAt' | 'archivedAt'>): Promise<Leave>;
  update(id: string, patch: Partial<Omit<Leave, 'id' | 'createdAt'>>): Promise<Leave>;
  archive(id: string): Promise<void>;
}

/**
 * Buffered draft cart — see `AssignmentDraft` in `types.ts`. The repo is
 * server-side persistence for the Assignments tab's pending edits. Drafts
 * are deleted (not archived) once committed, since they carry no audit
 * meaning beyond "this op has not yet been applied".
 */
export interface AssignmentDraftRepo {
  /** All drafts, optionally narrowed to a single IST run-date. */
  list(opts?: { runDate?: string }): Promise<AssignmentDraft[]>;
  findByTrainAndDate(trainId: string, runDate: string): Promise<AssignmentDraft | null>;
  /**
   * Insert-or-replace by `(trainId, runDate)`. Reusing an existing slot
   * preserves its `id` and `createdAt`; a fresh slot mints both.
   */
  upsert(input: Omit<AssignmentDraft, 'id' | 'createdAt'>): Promise<AssignmentDraft>;
  /** Hard-delete a single draft row by id. */
  delete(id: string): Promise<void>;

  /** Hard-delete multiple draft rows by id in a single mutation. */
  deleteMany(ids: string[]): Promise<void>;
  /** Hard-delete the (at most one) draft for `(trainId, runDate)`. Returns true if a row was removed. */
  deleteByTrainAndDate(trainId: string, runDate: string): Promise<boolean>;
  /** Hard-delete every draft for an IST run-date. Returns the count removed. */
  deleteAllForDate(runDate: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Links — predefined duty rotations (LLD §5.5).
// ---------------------------------------------------------------------------

/**
 * Repository for `Link` rows. Reads return the full `Link` (positions
 * decoded from the JSON-in-CSV column). Updates re-validate the cycle on
 * write.
 */
export interface LinkRepo {
  findById(id: string, opts?: ActiveFilter): Promise<Link | null>;
  list(opts?: ActiveFilter & { crewRole?: CrewRole }): Promise<Link[]>;
  create(input: Omit<Link, 'id' | 'createdAt' | 'archivedAt'>): Promise<Link>;
  update(id: string, patch: Partial<Omit<Link, 'id' | 'createdAt'>>): Promise<Link>;
  archive(id: string): Promise<void>;
}

/**
 * Repository for `LinkMembership` rows. Phase-1 callers mostly want
 * `listByLink(linkId)` (Memberships panel) and `findActiveByCrew(crewId)`
 * (single-crew schedule lookup, Phase 3). The caller — never the repo —
 * is responsible for cross-validating that `crewRole` matches the parent
 * link's `crewRole`.
 */
export interface LinkMembershipRepo {
  findById(id: string, opts?: ActiveFilter): Promise<LinkMembership | null>;
  list(opts?: ActiveFilter): Promise<LinkMembership[]>;
  listByLink(linkId: string, opts?: ActiveFilter): Promise<LinkMembership[]>;
  /**
   * Returns the active (non-archived) membership for one crew member, or
   * `null` if they are not on any link. A crew member may belong to at
   * most one active link at a time — the API enforces this on create.
   */
  findActiveByCrew(crewId: string): Promise<LinkMembership | null>;
  create(input: Omit<LinkMembership, 'id' | 'createdAt' | 'archivedAt'>): Promise<LinkMembership>;
  update(id: string, patch: Partial<Omit<LinkMembership, 'id' | 'createdAt'>>): Promise<LinkMembership>;
  archive(id: string): Promise<void>;
}

/**
 * Per-day Periodic Rest overrides — see `PrAssignment` in `types.ts`.
 *
 * Rows are addressed by `(linkId, positionNumber, runDate)`. There is no
 * archive concept: overrides are operational state, not audit. `upsert`
 * replaces the matching row in place; `deleteByKey` removes the override
 * entirely so the projection default applies again.
 */
export interface PrAssignmentRepo {
  list(opts?: { runDate?: string; linkId?: string }): Promise<PrAssignment[]>;
  findByKey(linkId: string, positionNumber: number, runDate: string): Promise<PrAssignment | null>;
  upsert(input: Omit<PrAssignment, 'id' | 'createdAt' | 'updatedAt'>): Promise<PrAssignment>;
  deleteByKey(linkId: string, positionNumber: number, runDate: string): Promise<boolean>;
}

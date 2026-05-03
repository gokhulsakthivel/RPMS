// Repository interfaces — declared in the domain layer per HLD §6.
// Implementations live in src/persistence/Csv*Repo.ts and are the only
// adapters in scope. Application/api code depends on these interfaces, never
// on the Csv* classes directly. See techstack.md §7.

import {
  Assignment,
  AssistantLocoPilot,
  CrewRole,
  Leave,
  LocoPilot,
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
  create(a: Omit<Assignment, 'id' | 'createdAt' | 'archivedAt'>): Promise<Assignment>;
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

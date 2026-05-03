// `stagedAssignments` — frontend-only "draft cart" for the Assignments page.
//
// Until the operator clicks the toolbar "+ Assign" button, none of the
// edits performed inside the per-row Assign / Edit / Delete modals touch
// the CSV. Each modal emits a `StagedOp` that the page accumulates in a
// `Map<trainId, StagedOp>` (one in-flight op per train). The toolbar
// "+ Assign" button drains the map by calling the backing REST endpoint
// for every op in turn — only THEN does the persistent CSV change.
//
// Why a single op-per-train? An operator can only have one pending change
// per train. Staging "create" then "edit" on the same train collapses to
// the latest pick, because both produce the same persisted shape (one
// `Assignment` row keyed by `(trainId, runDate)`).
//
// This module is intentionally pure — no React, no API calls. It owns the
// shape of a draft + a couple of pure helpers; the page handles wiring.

import type { AssignmentRow } from '../../../shared/schemas';

/** Reuse the AssignmentRow's train-type field rather than importing the
 *  domain enum from outside the web layer. */
type TrainType = AssignmentRow['trainType'];

// ---------------------------------------------------------------------------
// Shared display copy
// ---------------------------------------------------------------------------

/** Display fields all staged ops keep so the table can render without a re-fetch. */
export interface StagedDisplay {
  trainId: string;
  trainNumber: string;
  trainName: string;
  trainType: TrainType;
  runDate: string;
  /** ISO-8601 instant — used to sort the draft summary chronologically. */
  departureTime: string;
}

// ---------------------------------------------------------------------------
// StagedOp — discriminated union
// ---------------------------------------------------------------------------

export interface StagedCreate extends StagedDisplay {
  kind: 'create';
  lpId: string;
  lpName: string;
  /** Null when the train type doesn't require an ALP (MEMU/DEMU). */
  alpId: string | null;
  alpName: string | null;
}

export interface StagedUpdate extends StagedDisplay {
  kind: 'update';
  /** The persisted assignment row this draft will mutate. */
  assignmentId: string;
  /** Original LP — kept so the table can show "John D. → Mary S." */
  originalLpName: string;
  originalAlpName: string | null;
  /** New picks (post-edit). */
  lpId: string;
  lpName: string;
  alpId: string | null;
  alpName: string | null;
}

export interface StagedDelete extends StagedDisplay {
  kind: 'delete';
  /** The persisted assignment row this draft will archive. */
  assignmentId: string;
  /** Snapshot of the crew that's about to be archived (for display). */
  lpName: string;
  alpName: string | null;
}

export type StagedOp = StagedCreate | StagedUpdate | StagedDelete;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Replace (or insert) an op for `trainId`. Returns a NEW Map. */
export function setStagedOp(
  prev: ReadonlyMap<string, StagedOp>,
  op: StagedOp,
): Map<string, StagedOp> {
  const next = new Map(prev);
  next.set(op.trainId, op);
  return next;
}

/** Remove the op for `trainId`. Returns a NEW Map. */
export function removeStagedOp(
  prev: ReadonlyMap<string, StagedOp>,
  trainId: string,
): Map<string, StagedOp> {
  const next = new Map(prev);
  next.delete(trainId);
  return next;
}

/**
 * Human-friendly verb for the toolbar / banner copy.
 *   create → "assign"
 *   update → "update"
 *   delete → "archive"
 */
export function verbForOp(op: StagedOp): string {
  switch (op.kind) {
    case 'create':
      return 'assign';
    case 'update':
      return 'update';
    case 'delete':
      return 'archive';
  }
}

/** Sort a list of staged ops by departure time (earliest first). */
export function sortByDeparture(ops: ReadonlyArray<StagedOp>): StagedOp[] {
  return [...ops].sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

/**
 * Collect crew IDs already claimed by staged `create` / `update` ops, so
 * the per-train modals can hide them from THEIR dropdowns. An operator
 * who has staged "LP X on Train A" should not be offered LP X again when
 * picking crew for Train B.
 *
 * `excludeTrainId` skips the modal's own staged op, so re-opening the
 * modal on a row that already has a draft does not make its own picks
 * disappear from the dropdown. `delete` ops claim no one — they free
 * the persisted crew, but until commit the server still treats those
 * crew as "already assigned", so we don't need to re-add them here.
 */
export function stagedCrewIds(
  staged: ReadonlyMap<string, StagedOp>,
  excludeTrainId?: string,
): { lpIds: ReadonlySet<string>; alpIds: ReadonlySet<string> } {
  const lpIds = new Set<string>();
  const alpIds = new Set<string>();
  for (const op of staged.values()) {
    if (excludeTrainId !== undefined && op.trainId === excludeTrainId) continue;
    if (op.kind === 'delete') continue;
    lpIds.add(op.lpId);
    if (op.alpId) alpIds.add(op.alpId);
  }
  return { lpIds, alpIds };
}

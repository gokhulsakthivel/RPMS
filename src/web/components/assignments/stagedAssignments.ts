// `stagedAssignments` — frontend types + helpers for the server-backed
// "draft cart" used by the Assignments page.
//
// The cart itself is server-persisted (see `data/assignment_drafts.csv` and
// `/api/assignment-drafts`). The page fetches the list, derives a
// `Map<trainId, StagedOp>` for easy lookup by the per-row table and
// the per-train modals, and round-trips every stage / unstage / commit
// action through the API.
//
// Why a single op-per-train? An operator can only have one pending change
// per train. Staging "create" then "edit" on the same train collapses to
// the latest pick, because both produce the same persisted shape (one
// `Assignment` row keyed by `(trainId, runDate)`). The server enforces
// this with an `(trainId, runDate)` upsert key.
//
// Type policy: the canonical wire shape lives in `src/shared/schemas.ts` as
// `AssignmentDraftStageInput` / `AssignmentDraftRow`. The `StagedOp*`
// aliases below re-export them under the names the SPA already uses, so
// component prop types and the wire format stay in lockstep automatically.

import type {
  AssignmentDraftRow,
  AssignmentDraftStageInput,
} from '../../../shared/schemas';

// ---------------------------------------------------------------------------
// StagedOp — discriminated union (alias of the wire shape)
// ---------------------------------------------------------------------------

/**
 * Display fields every staged op carries — keeps the table renderable
 * without re-fetching crew/train rows. Equivalent to the `StagedDisplay`
 * shape from the wire schema's discriminated union.
 */
export type StagedDisplay = Pick<
  AssignmentDraftRow,
  'trainId' | 'trainNumber' | 'trainName' | 'trainType' | 'runDate' | 'departureTime'
>;

/** Staged "create a new assignment" op. */
export type StagedCreate = Extract<AssignmentDraftStageInput, { kind: 'create' }>;

/** Staged "edit the LP/ALP on an existing assignment" op. */
export type StagedUpdate = Extract<AssignmentDraftStageInput, { kind: 'update' }>;

/** Staged "archive an existing assignment" op. */
export type StagedDelete = Extract<AssignmentDraftStageInput, { kind: 'delete' }>;

/** A single buffered op — discriminated on `kind`. */
export type StagedOp = AssignmentDraftStageInput;

// ---------------------------------------------------------------------------
// Small pure helpers — no React, no API calls.
// ---------------------------------------------------------------------------

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
    if (op.alpId2) alpIds.add(op.alpId2);
  }
  return { lpIds, alpIds };
}

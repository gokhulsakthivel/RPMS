// Csv-backed implementation of `AssignmentDraftRepo`.
//
// Drafts are operational, server-persisted buffer slots for the Assignments
// tab's "+ Assign (N)" cart. Unlike the audit-bearing CSVs (assignments,
// leaves) the draft repo HARD-DELETES rows on commit/reset — there is no
// business reason to retain a record of an op that never landed.
//
// Schema mirrors the other repos: header asserted on every read, atomic
// whole-file rewrites under the file lock via `mutateCsv`. Uniqueness key
// is `(trainId, runDate)` — at most one in-flight op per train per run.
//
// Wire format: every column is a string. The kind-specific invariants
// (e.g. update/delete must carry an `assignmentId`) are enforced by
// `assertValidDraftInput` so the repo never persists nonsensical rows.

import { randomUUID } from 'node:crypto';

import { AssignmentDraftRepo } from '../domain/repositories';
import {
  AssignmentDraft,
  AssignmentDraftKind,
  TrainType,
} from '../domain/types';
import {
  CsvRow,
  decodeDate,
  encodeDate,
} from './csvIo';
import type { TableStore } from './tableStore';

/** Exact column order. Keep in lockstep with `data/assignment_drafts.csv`. */
const DRAFTS_HEADER = [
  'id',
  'kind',
  'trainId',
  'trainNumber',
  'trainName',
  'trainType',
  'runDate',
  'departureTime',
  'assignmentId',
  'lpId',
  'lpName',
  'alpId',
  'alpName',
  'alpId2',
  'alpName2',
  'originalLpName',
  'originalAlpName',
  'originalAlpName2',
  'createdAt',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: ReadonlyArray<AssignmentDraftKind> = [
  'create',
  'update',
  'delete',
];
const TRAIN_TYPES = new Set<string>(Object.values(TrainType));

export class CsvAssignmentDraftRepo implements AssignmentDraftRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'assignment_drafts',
  ) {}

  async list(opts: { runDate?: string } = {}): Promise<AssignmentDraft[]> {
    const all = await this.readAll();
    if (opts.runDate === undefined) return all;
    return all.filter((d) => d.runDate === opts.runDate);
  }

  async findByTrainAndDate(
    trainId: string,
    runDate: string,
  ): Promise<AssignmentDraft | null> {
    const all = await this.readAll();
    return (
      all.find((d) => d.trainId === trainId && d.runDate === runDate) ?? null
    );
  }

  async upsert(
    input: Omit<AssignmentDraft, 'id' | 'createdAt'>,
  ): Promise<AssignmentDraft> {
    assertValidDraftInput(input);
    let resulting: AssignmentDraft | null = null;
    await this.store.mutate(this.table, DRAFTS_HEADER, (rows) => {
      const idx = rows.findIndex(
        (r) =>
          r['trainId'] === input.trainId && r['runDate'] === input.runDate,
      );
      if (idx >= 0) {
        // Reuse existing id + createdAt so the slot's identity is stable
        // across edits ("staged for X, revised to Y" is one row, not two).
        const existing = rows[idx]!;
        const id = existing['id'] ?? '';
        const createdAt = decodeDate(existing['createdAt'] ?? '');
        if (!id || !createdAt) {
          throw new Error(
            'CsvAssignmentDraftRepo.upsert: existing row missing id/createdAt',
          );
        }
        const merged: AssignmentDraft = {
          ...input,
          id,
          createdAt,
        };
        const next = rows.slice();
        next[idx] = encodeDraft(merged);
        resulting = merged;
        return next;
      }
      const created: AssignmentDraft = {
        ...input,
        id: `DRAFT_${randomUUID()}`,
        createdAt: new Date(),
      };
      resulting = created;
      return [...rows, encodeDraft(created)];
    });
    // Narrowing assertion: `mutateCsv` either populated `resulting` or threw.
    return resulting!;
  }

  async delete(id: string): Promise<void> {
    await this.store.mutate(this.table, DRAFTS_HEADER, (rows) =>
      rows.filter((r) => r['id'] !== id),
    );
  }

  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await this.store.mutate(this.table, DRAFTS_HEADER, (rows) =>
      rows.filter((r) => !idSet.has(r['id'] ?? '')),
    );
  }

  async deleteByTrainAndDate(
    trainId: string,
    runDate: string,
  ): Promise<boolean> {
    let removed = false;
    await this.store.mutate(this.table, DRAFTS_HEADER, (rows) =>
      rows.filter((r) => {
        if (r['trainId'] === trainId && r['runDate'] === runDate) {
          removed = true;
          return false;
        }
        return true;
      }),
    );
    return removed;
  }

  async deleteAllForDate(runDate: string): Promise<number> {
    let count = 0;
    await this.store.mutate(this.table, DRAFTS_HEADER, (rows) =>
      rows.filter((r) => {
        if (r['runDate'] === runDate) {
          count++;
          return false;
        }
        return true;
      }),
    );
    return count;
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<AssignmentDraft[]> {
    const rows = await this.store.read(this.table, DRAFTS_HEADER);
    return rows.map(decodeDraft);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeDraft(row: CsvRow): AssignmentDraft {
  const id = row['id'] ?? '';
  const kindRaw = row['kind'] ?? '';
  if (!KINDS.includes(kindRaw as AssignmentDraftKind)) {
    throw new Error(
      `CsvAssignmentDraftRepo: kind must be create|update|delete (got ${JSON.stringify(kindRaw)}, id=${id})`,
    );
  }
  const trainTypeRaw = row['trainType'] ?? '';
  if (!TRAIN_TYPES.has(trainTypeRaw)) {
    throw new Error(
      `CsvAssignmentDraftRepo: trainType invalid (got ${JSON.stringify(trainTypeRaw)}, id=${id})`,
    );
  }
  const runDate = row['runDate'] ?? '';
  if (!DATE_RE.test(runDate)) {
    throw new Error(
      `CsvAssignmentDraftRepo: runDate must be YYYY-MM-DD (got ${JSON.stringify(runDate)}, id=${id})`,
    );
  }
  const departureTime = decodeDate(row['departureTime'] ?? '');
  if (!departureTime) {
    throw new Error(
      `CsvAssignmentDraftRepo: departureTime is required (id=${id})`,
    );
  }
  const createdAt = decodeDate(row['createdAt'] ?? '');
  if (!createdAt) {
    throw new Error(`CsvAssignmentDraftRepo: createdAt is required (id=${id})`);
  }

  const draft: AssignmentDraft = {
    id,
    kind: kindRaw as AssignmentDraftKind,
    trainId: row['trainId'] ?? '',
    trainNumber: row['trainNumber'] ?? '',
    trainName: row['trainName'] ?? '',
    trainType: trainTypeRaw as TrainType,
    runDate,
    departureTime,
    createdAt,
  };

  // Optional cells: empty string ↔ undefined.
  const assignmentId = row['assignmentId'] ?? '';
  if (assignmentId) draft.assignmentId = assignmentId;
  const lpId = row['lpId'] ?? '';
  if (lpId) draft.lpId = lpId;
  const lpName = row['lpName'] ?? '';
  if (lpName) draft.lpName = lpName;
  const alpId = row['alpId'] ?? '';
  if (alpId) draft.alpId = alpId;
  const alpName = row['alpName'] ?? '';
  if (alpName) draft.alpName = alpName;
  const alpId2 = row['alpId2'] ?? '';
  if (alpId2) draft.alpId2 = alpId2;
  const alpName2 = row['alpName2'] ?? '';
  if (alpName2) draft.alpName2 = alpName2;
  const originalLpName = row['originalLpName'] ?? '';
  if (originalLpName) draft.originalLpName = originalLpName;
  const originalAlpName = row['originalAlpName'] ?? '';
  if (originalAlpName) draft.originalAlpName = originalAlpName;
  const originalAlpName2 = row['originalAlpName2'] ?? '';
  if (originalAlpName2) draft.originalAlpName2 = originalAlpName2;

  return draft;
}

function encodeDraft(d: AssignmentDraft): CsvRow {
  return {
    id: d.id,
    kind: d.kind,
    trainId: d.trainId,
    trainNumber: d.trainNumber,
    trainName: d.trainName,
    trainType: d.trainType,
    runDate: d.runDate,
    departureTime: encodeDate(d.departureTime),
    assignmentId: d.assignmentId ?? '',
    lpId: d.lpId ?? '',
    lpName: d.lpName ?? '',
    alpId: d.alpId ?? '',
    alpName: d.alpName ?? '',
    alpId2: d.alpId2 ?? '',
    alpName2: d.alpName2 ?? '',
    originalLpName: d.originalLpName ?? '',
    originalAlpName: d.originalAlpName ?? '',
    originalAlpName2: d.originalAlpName2 ?? '',
    createdAt: encodeDate(d.createdAt),
  };
}

/**
 * Pre-write validation. Mirrors the Zod schema in `src/shared/schemas.ts`
 * but lives here so the repo refuses to persist garbage even when called
 * directly (e.g. from a smoke script). Kind-specific invariants:
 *
 *   - create:  lpId required (alpId optional, set when train requires ALP)
 *   - update:  assignmentId + lpId required
 *   - delete:  assignmentId required (no crew ids — it's an archive op)
 */
function assertValidDraftInput(
  input: Omit<AssignmentDraft, 'id' | 'createdAt'>,
): void {
  if (!input.trainId || input.trainId.trim() === '') {
    throw new Error('CsvAssignmentDraftRepo: trainId required');
  }
  if (!DATE_RE.test(input.runDate)) {
    throw new Error(
      `CsvAssignmentDraftRepo: runDate must be YYYY-MM-DD (got ${JSON.stringify(input.runDate)})`,
    );
  }
  if (!KINDS.includes(input.kind)) {
    throw new Error(
      `CsvAssignmentDraftRepo: invalid kind ${JSON.stringify(input.kind)}`,
    );
  }
  switch (input.kind) {
    case 'create':
      if (!input.lpId) {
        throw new Error('CsvAssignmentDraftRepo: create draft requires lpId');
      }
      break;
    case 'update':
      if (!input.assignmentId) {
        throw new Error(
          'CsvAssignmentDraftRepo: update draft requires assignmentId',
        );
      }
      if (!input.lpId) {
        throw new Error('CsvAssignmentDraftRepo: update draft requires lpId');
      }
      break;
    case 'delete':
      if (!input.assignmentId) {
        throw new Error(
          'CsvAssignmentDraftRepo: delete draft requires assignmentId',
        );
      }
      break;
  }
}

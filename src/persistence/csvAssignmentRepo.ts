// Csv-backed implementation of `AssignmentRepo` (LLD §5.5).
//
// M9 — recurring schedule. The CSV gains a `runDate` column (`YYYY-MM-DD`,
// IST) so a single train number can carry independent assignments for each
// of its weekly runs. `(trainId, runDate)` is the natural uniqueness key for
// active rows.

import { randomUUID } from 'node:crypto';

import {
  ActiveFilter,
  AssignmentRepo,
  DateRange,
} from '../domain/repositories';
import { Assignment } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  encodeDate,
} from './csvIo';
import type { TableStore } from './tableStore';

/**
 * LLD §5.3 — exact column order. M9 adds `runDate` after `trainId`.
 * `previousLpSignOffTime` / `previousAlpSignOffTime` snapshot each crew
 * member's `lastSignOffTime` at the moment THIS assignment stamped a new
 * value, so archive / re-edit can roll the rest clock back. Empty cells mean
 * the crew had never signed off before this row.
 */
const ASSIGNMENTS_HEADER = [
  'id',
  'trainId',
  'runDate',
  'lpId',
  'alpId',
  'alpId2',
  'departureTime',
  'signOffTime',
  'previousLpSignOffTime',
  'previousAlpSignOffTime',
  'previousAlpSignOffTime2',
  'createdAt',
  'archivedAt',
] as const;

const RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CsvAssignmentRepo implements AssignmentRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'assignments',
  ) {}

  async findById(
    id: string,
    opts: ActiveFilter = {},
  ): Promise<Assignment | null> {
    const all = await this.readAll();
    const found = all.find((a) => a.id === id);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  async create(
    a: Omit<Assignment, 'id' | 'createdAt' | 'archivedAt'>,
  ): Promise<Assignment> {
    if (!RUN_DATE_RE.test(a.runDate)) {
      throw new Error(
        `CsvAssignmentRepo.create: runDate must be YYYY-MM-DD (got ${JSON.stringify(a.runDate)})`,
      );
    }
    const row: Assignment = {
      ...a,
      id: `ASN_${randomUUID()}`,
      createdAt: new Date(),
    };
    await this.store.mutate(this.table, ASSIGNMENTS_HEADER, (rows) => [
      ...rows,
      encodeAssignment(row),
    ]);
    return row;
  }

  async update(
    id: string,
    patch: {
      lpId?: string;
      alpId?: string | null;
      alpId2?: string | null;
      previousLpSignOffTime?: Date | null;
      previousAlpSignOffTime?: Date | null;
      previousAlpSignOffTime2?: Date | null;
    },
  ): Promise<Assignment> {
    let updated: Assignment | null = null;
    await this.store.mutate(this.table, ASSIGNMENTS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') {
          throw new Error(
            `CsvAssignmentRepo.update: cannot update archived assignment (id=${id})`,
          );
        }
        const merged: CsvRow = { ...r };
        if (patch.lpId !== undefined) merged['lpId'] = patch.lpId;
        if (patch.alpId !== undefined) {
          merged['alpId'] = patch.alpId === null ? '' : patch.alpId;
        }
        if (patch.alpId2 !== undefined) {
          merged['alpId2'] = patch.alpId2 === null ? '' : patch.alpId2;
        }
        if (patch.previousLpSignOffTime !== undefined) {
          merged['previousLpSignOffTime'] =
            patch.previousLpSignOffTime === null
              ? ''
              : encodeDate(patch.previousLpSignOffTime);
        }
        if (patch.previousAlpSignOffTime !== undefined) {
          merged['previousAlpSignOffTime'] =
            patch.previousAlpSignOffTime === null
              ? ''
              : encodeDate(patch.previousAlpSignOffTime);
        }
        if (patch.previousAlpSignOffTime2 !== undefined) {
          merged['previousAlpSignOffTime2'] =
            patch.previousAlpSignOffTime2 === null
              ? ''
              : encodeDate(patch.previousAlpSignOffTime2);
        }
        updated = decodeAssignment(merged);
        return merged;
      });
      if (!saw) {
        throw new Error(`CsvAssignmentRepo.update: id not found: ${id}`);
      }
      return next;
    });
    // `updated` is set inside the mutator above for the row that matched.
    if (!updated) {
      throw new Error(`CsvAssignmentRepo.update: id not found: ${id}`);
    }
    return updated;
  }

  async list(
    opts: ActiveFilter & { departingWithin?: DateRange } = {},
  ): Promise<Assignment[]> {
    const all = await this.readAll();
    return all.filter((a) => {
      if (!opts.includeArchived && a.archivedAt) return false;
      if (opts.departingWithin) {
        const ms = a.departureTime.getTime();
        if (ms < opts.departingWithin.fromUtc.getTime()) return false;
        if (ms >= opts.departingWithin.toUtcExclusive.getTime()) return false;
      }
      return true;
    });
  }

  async listByCrew(
    crewId: string,
    opts: ActiveFilter = {},
  ): Promise<Assignment[]> {
    const all = await this.readAll();
    return all.filter((a) => {
      if (a.lpId !== crewId && a.alpId !== crewId && a.alpId2 !== crewId) return false;
      if (!opts.includeArchived && a.archivedAt) return false;
      return true;
    });
  }

  async listByTrain(
    trainId: string,
    opts: ActiveFilter = {},
  ): Promise<Assignment[]> {
    const all = await this.readAll();
    return all.filter((a) => {
      if (a.trainId !== trainId) return false;
      if (!opts.includeArchived && a.archivedAt) return false;
      return true;
    });
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, ASSIGNMENTS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvAssignmentRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<Assignment[]> {
    const rows = await this.store.read(this.table, ASSIGNMENTS_HEADER);
    return rows.map(decodeAssignment);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeAssignment(row: CsvRow): Assignment {
  const id = row['id'] ?? '';
  const runDate = row['runDate'] ?? '';
  if (!RUN_DATE_RE.test(runDate)) {
    throw new Error(
      `CsvAssignmentRepo: runDate must be YYYY-MM-DD (got ${JSON.stringify(runDate)}, id=${id})`,
    );
  }
  const departureTime = decodeDate(row['departureTime'] ?? '');
  const signOffTime = decodeDate(row['signOffTime'] ?? '');
  const createdAt = decodeDate(row['createdAt'] ?? '');
  if (!departureTime || !signOffTime || !createdAt) {
    throw new Error(
      `CsvAssignmentRepo: missing required timestamp (id=${id})`,
    );
  }
  if (signOffTime.getTime() <= departureTime.getTime()) {
    throw new Error(
      `CsvAssignmentRepo: signOffTime must be > departureTime (id=${id})`,
    );
  }
  const alpId = row['alpId'] ?? '';
  const alpId2 = row['alpId2'] ?? '';
  const assignment: Assignment = {
    id,
    trainId: row['trainId'] ?? '',
    runDate,
    lpId: row['lpId'] ?? '',
    departureTime,
    signOffTime,
    createdAt,
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
  if (alpId !== '') assignment.alpId = alpId;
  if (alpId2 !== '') assignment.alpId2 = alpId2;
  // The sign-off snapshots are optional: an empty cell means the
  // corresponding crew member had never signed off before this row, so the
  // domain field stays `undefined`. The columns also tolerate legacy rows
  // written before the schema was extended (no cell at all → also `undefined`).
  const prevLp = decodeDate(row['previousLpSignOffTime'] ?? '');
  if (prevLp) assignment.previousLpSignOffTime = prevLp;
  const prevAlp = decodeDate(row['previousAlpSignOffTime'] ?? '');
  if (prevAlp) assignment.previousAlpSignOffTime = prevAlp;
  const prevAlp2 = decodeDate(row['previousAlpSignOffTime2'] ?? '');
  if (prevAlp2) assignment.previousAlpSignOffTime2 = prevAlp2;
  return assignment;
}

function encodeAssignment(a: Assignment): CsvRow {
  return {
    id: a.id,
    trainId: a.trainId,
    runDate: a.runDate,
    lpId: a.lpId,
    alpId: a.alpId ?? '',
    alpId2: a.alpId2 ?? '',
    departureTime: encodeDate(a.departureTime),
    signOffTime: encodeDate(a.signOffTime),
    previousLpSignOffTime: encodeDate(a.previousLpSignOffTime),
    previousAlpSignOffTime: encodeDate(a.previousAlpSignOffTime),
    previousAlpSignOffTime2: encodeDate(a.previousAlpSignOffTime2),
    createdAt: encodeDate(a.createdAt),
    archivedAt: encodeDate(a.archivedAt),
  };
}

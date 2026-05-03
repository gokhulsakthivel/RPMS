// Csv-backed implementation of `AssignmentRepo` (LLD §5.5).
//
// M9 — recurring schedule. The CSV gains a `runDate` column (`YYYY-MM-DD`,
// IST) so a single train number can carry independent assignments for each
// of its weekly runs. `(trainId, runDate)` is the natural uniqueness key for
// active rows.

import path from 'node:path';
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
  mutateCsv,
  readCsvUnlocked,
} from './csvIo';

/** LLD §5.3 — exact column order. M9 adds `runDate` after `trainId`. */
const ASSIGNMENTS_HEADER = [
  'id',
  'trainId',
  'runDate',
  'lpId',
  'alpId',
  'departureTime',
  'signOffTime',
  'createdAt',
  'archivedAt',
] as const;

const RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CsvAssignmentRepo implements AssignmentRepo {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'assignments.csv');
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
    await mutateCsv(this.filePath, ASSIGNMENTS_HEADER, (rows) => [
      ...rows,
      encodeAssignment(row),
    ]);
    return row;
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
      if (a.lpId !== crewId && a.alpId !== crewId) return false;
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
    await mutateCsv(this.filePath, ASSIGNMENTS_HEADER, (rows) => {
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
    const rows = await readCsvUnlocked(this.filePath, ASSIGNMENTS_HEADER);
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
  return assignment;
}

function encodeAssignment(a: Assignment): CsvRow {
  return {
    id: a.id,
    trainId: a.trainId,
    runDate: a.runDate,
    lpId: a.lpId,
    alpId: a.alpId ?? '',
    departureTime: encodeDate(a.departureTime),
    signOffTime: encodeDate(a.signOffTime),
    createdAt: encodeDate(a.createdAt),
    archivedAt: encodeDate(a.archivedAt),
  };
}

// Csv-backed implementation of `PrAssignmentRepo`.
//
// Periodic Rest overrides are operational state, not audit — there is no
// archive column, and committed rows are upserted in place. Uniqueness key
// is `(linkId, positionNumber, runDate)`; an empty `crewId` is a deliberate
// "no PR today" marker rather than a missing value.

import { randomUUID } from 'node:crypto';

import { PrAssignmentRepo } from '../domain/repositories';
import { CrewRole, PrAssignment } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  encodeDate,
} from './csvIo';
import type { TableStore } from './tableStore';

const PR_HEADER = [
  'id',
  'linkId',
  'positionNumber',
  'runDate',
  'crewRole',
  'crewId',
  'createdAt',
  'updatedAt',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CREW_ROLES: ReadonlyArray<CrewRole> = ['LP', 'ALP'];

export class CsvPrAssignmentRepo implements PrAssignmentRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'pr_assignments',
  ) {}

  async list(
    opts: { runDate?: string; linkId?: string } = {},
  ): Promise<PrAssignment[]> {
    const all = await this.readAll();
    return all.filter((r) => {
      if (opts.runDate !== undefined && r.runDate !== opts.runDate) return false;
      if (opts.linkId !== undefined && r.linkId !== opts.linkId) return false;
      return true;
    });
  }

  async findByKey(
    linkId: string,
    positionNumber: number,
    runDate: string,
  ): Promise<PrAssignment | null> {
    const all = await this.readAll();
    return (
      all.find(
        (r) =>
          r.linkId === linkId &&
          r.positionNumber === positionNumber &&
          r.runDate === runDate,
      ) ?? null
    );
  }

  async upsert(
    input: Omit<PrAssignment, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PrAssignment> {
    assertValidInput(input);
    let resulting: PrAssignment | null = null;
    await this.store.mutate(this.table, PR_HEADER, (rows) => {
      const idx = rows.findIndex(
        (r) =>
          r['linkId'] === input.linkId &&
          r['positionNumber'] === String(input.positionNumber) &&
          r['runDate'] === input.runDate,
      );
      const now = new Date();
      if (idx >= 0) {
        const existing = rows[idx]!;
        const id = existing['id'] ?? '';
        const createdAt = decodeDate(existing['createdAt'] ?? '');
        if (!id || !createdAt) {
          throw new Error(
            'CsvPrAssignmentRepo.upsert: existing row missing id/createdAt',
          );
        }
        const merged: PrAssignment = {
          ...input,
          id,
          createdAt,
          updatedAt: now,
        };
        const next = rows.slice();
        next[idx] = encode(merged);
        resulting = merged;
        return next;
      }
      const created: PrAssignment = {
        ...input,
        id: `PRA_${randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      };
      resulting = created;
      return [...rows, encode(created)];
    });
    return resulting!;
  }

  async deleteByKey(
    linkId: string,
    positionNumber: number,
    runDate: string,
  ): Promise<boolean> {
    let removed = false;
    await this.store.mutate(this.table, PR_HEADER, (rows) =>
      rows.filter((r) => {
        if (
          r['linkId'] === linkId &&
          r['positionNumber'] === String(positionNumber) &&
          r['runDate'] === runDate
        ) {
          removed = true;
          return false;
        }
        return true;
      }),
    );
    return removed;
  }

  private async readAll(): Promise<PrAssignment[]> {
    const rows = await this.store.read(this.table, PR_HEADER);
    return rows.map(decode);
  }
}

function decode(row: CsvRow): PrAssignment {
  const positionNumber = Number.parseInt(row['positionNumber'] ?? '', 10);
  if (!Number.isFinite(positionNumber) || positionNumber < 1) {
    throw new Error(
      `CsvPrAssignmentRepo: positionNumber must be a positive integer (got ${JSON.stringify(row['positionNumber'])}, id=${row['id']})`,
    );
  }
  const crewRole = row['crewRole'] ?? '';
  if (!CREW_ROLES.includes(crewRole as CrewRole)) {
    throw new Error(
      `CsvPrAssignmentRepo: crewRole must be LP or ALP (got ${JSON.stringify(crewRole)}, id=${row['id']})`,
    );
  }
  const runDate = row['runDate'] ?? '';
  if (!DATE_RE.test(runDate)) {
    throw new Error(
      `CsvPrAssignmentRepo: runDate must be YYYY-MM-DD (got ${JSON.stringify(runDate)}, id=${row['id']})`,
    );
  }
  const createdAt = decodeDate(row['createdAt'] ?? '');
  const updatedAt = decodeDate(row['updatedAt'] ?? '');
  if (!createdAt || !updatedAt) {
    throw new Error(
      `CsvPrAssignmentRepo: createdAt/updatedAt required (id=${row['id']})`,
    );
  }
  return {
    id: row['id'] ?? '',
    linkId: row['linkId'] ?? '',
    positionNumber,
    runDate,
    crewRole: crewRole as CrewRole,
    crewId: row['crewId'] ?? '',
    createdAt,
    updatedAt,
  };
}

function encode(r: PrAssignment): CsvRow {
  return {
    id: r.id,
    linkId: r.linkId,
    positionNumber: String(r.positionNumber),
    runDate: r.runDate,
    crewRole: r.crewRole,
    crewId: r.crewId,
    createdAt: encodeDate(r.createdAt),
    updatedAt: encodeDate(r.updatedAt),
  };
}

function assertValidInput(
  input: Omit<PrAssignment, 'id' | 'createdAt' | 'updatedAt'>,
): void {
  if (!input.linkId) throw new Error('PrAssignment.linkId required');
  if (!Number.isInteger(input.positionNumber) || input.positionNumber < 1) {
    throw new Error('PrAssignment.positionNumber must be a positive integer');
  }
  if (!DATE_RE.test(input.runDate)) {
    throw new Error('PrAssignment.runDate must be YYYY-MM-DD');
  }
  if (!CREW_ROLES.includes(input.crewRole)) {
    throw new Error('PrAssignment.crewRole must be LP or ALP');
  }
}

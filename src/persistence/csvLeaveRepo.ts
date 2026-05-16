// Csv-backed implementation of `LeaveRepo` (HLD §4.4 / LLD §5.6).
//
// Schema mirrors the other repos: append-friendly, soft-archive only,
// header asserted on every read. `(crewId, fromDate, toDate)` is not a
// hard uniqueness key — operators may legitimately log overlapping leaves
// (e.g. SICK extension while a planned LEAVE existed). The orchestrator
// only cares that AT LEAST ONE non-archived row covers the runDate.

import { randomUUID } from 'node:crypto';

import {
  ActiveFilter,
  LeaveRepo,
} from '../domain/repositories';
import { CrewRole, Leave, LeaveType } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  encodeDate,
} from './csvIo';
import type { TableStore } from './tableStore';

/** LLD §5.3 — exact column order. Keep in lockstep with `data/leaves.csv`. */
const LEAVES_HEADER = [
  'id',
  'crewId',
  'crewRole',
  'type',
  'fromDate',
  'toDate',
  'reason',
  'createdAt',
  'archivedAt',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CREW_ROLES: ReadonlyArray<CrewRole> = ['LP', 'ALP'];
const LEAVE_TYPES: ReadonlyArray<LeaveType> = [
  LeaveType.SICK,
  LeaveType.LEAVE,
  LeaveType.TRAINING,
  LeaveType.PR,
];

export class CsvLeaveRepo implements LeaveRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'leaves',
  ) {}

  async findById(id: string, opts: ActiveFilter = {}): Promise<Leave | null> {
    const all = await this.readAll();
    for (const l of all) {
      if (l.id !== id) continue;
      if (!opts.includeArchived && l.archivedAt) return null;
      return l;
    }
    return null;
  }

  async list(opts: ActiveFilter = {}): Promise<Leave[]> {
    const all = await this.readAll();
    return opts.includeArchived ? all : all.filter((l) => !l.archivedAt);
  }

  async listByCrew(
    crewId: string,
    opts: ActiveFilter = {},
  ): Promise<Leave[]> {
    const all = await this.readAll();
    return all.filter((l) => {
      if (l.crewId !== crewId) return false;
      if (!opts.includeArchived && l.archivedAt) return false;
      return true;
    });
  }

  async listCoveringDate(
    runDate: string,
    opts: ActiveFilter & { crewRole?: CrewRole } = {},
  ): Promise<Leave[]> {
    if (!DATE_RE.test(runDate)) {
      throw new Error(
        `CsvLeaveRepo.listCoveringDate: runDate must be YYYY-MM-DD (got ${JSON.stringify(runDate)})`,
      );
    }
    const all = await this.readAll();
    return all.filter((l) => {
      if (!opts.includeArchived && l.archivedAt) return false;
      if (opts.crewRole && l.crewRole !== opts.crewRole) return false;
      return l.fromDate <= runDate && runDate <= l.toDate;
    });
  }

  async create(
    input: Omit<Leave, 'id' | 'createdAt' | 'archivedAt'>,
  ): Promise<Leave> {
    assertValidLeaveInput(input);
    const row: Leave = {
      ...input,
      id: `LEAVE_${randomUUID()}`,
      createdAt: new Date(),
    };
    await this.store.mutate(this.table, LEAVES_HEADER, (rows) => [
      ...rows,
      encodeLeave(row),
    ]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<Leave, 'id' | 'createdAt'>>,
  ): Promise<Leave> {
    let updated: Leave | null = null;
    await this.store.mutate(this.table, LEAVES_HEADER, (rows) => {
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        const current = decodeLeave(r);
        const merged: Leave = {
          ...current,
          ...patch,
        };
        // Re-validate the resulting record so we never persist a window
        // where `toDate < fromDate` or with an unknown enum value.
        assertValidLeaveInput(merged);
        updated = merged;
        return encodeLeave(merged);
      });
      if (!updated) {
        throw new Error(`CsvLeaveRepo.update: id not found: ${id}`);
      }
      return next;
    });
    // Narrowing assertion: `mutateCsv` either populated `updated` or threw.
    return updated!;
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, LEAVES_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvLeaveRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<Leave[]> {
    const rows = await this.store.read(this.table, LEAVES_HEADER);
    return rows.map(decodeLeave);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeLeave(row: CsvRow): Leave {
  const id = row['id'] ?? '';
  const crewRole = row['crewRole'] ?? '';
  if (!CREW_ROLES.includes(crewRole as CrewRole)) {
    throw new Error(
      `CsvLeaveRepo: crewRole must be LP or ALP (got ${JSON.stringify(crewRole)}, id=${id})`,
    );
  }
  const type = row['type'] ?? '';
  if (!LEAVE_TYPES.includes(type as LeaveType)) {
    throw new Error(
      `CsvLeaveRepo: type must be one of SICK|LEAVE|TRAINING|PR (got ${JSON.stringify(type)}, id=${id})`,
    );
  }
  const fromDate = row['fromDate'] ?? '';
  const toDate = row['toDate'] ?? '';
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    throw new Error(
      `CsvLeaveRepo: fromDate/toDate must be YYYY-MM-DD (got from=${JSON.stringify(fromDate)} to=${JSON.stringify(toDate)}, id=${id})`,
    );
  }
  if (toDate < fromDate) {
    throw new Error(
      `CsvLeaveRepo: toDate must be on or after fromDate (id=${id})`,
    );
  }
  const createdAt = decodeDate(row['createdAt'] ?? '');
  if (!createdAt) {
    throw new Error(`CsvLeaveRepo: createdAt is required (id=${id})`);
  }
  const reason = row['reason'] ?? '';
  const leave: Leave = {
    id,
    crewId: row['crewId'] ?? '',
    crewRole: crewRole as CrewRole,
    type: type as LeaveType,
    fromDate,
    toDate,
    createdAt,
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
  if (reason !== '') leave.reason = reason;
  return leave;
}

function encodeLeave(l: Leave): CsvRow {
  return {
    id: l.id,
    crewId: l.crewId,
    crewRole: l.crewRole,
    type: l.type,
    fromDate: l.fromDate,
    toDate: l.toDate,
    reason: l.reason ?? '',
    createdAt: encodeDate(l.createdAt),
    archivedAt: encodeDate(l.archivedAt),
  };
}

/**
 * Pre-write validation shared by `create` and `update`. Mirrors the Zod
 * schema in `src/shared/schemas.ts` but lives here so the repo refuses to
 * persist garbage even when called directly (e.g. from a smoke script).
 */
function assertValidLeaveInput(
  input: Pick<Leave, 'crewId' | 'crewRole' | 'type' | 'fromDate' | 'toDate'>,
): void {
  if (!input.crewId || input.crewId.trim() === '') {
    throw new Error('CsvLeaveRepo: crewId must be a non-empty string');
  }
  if (!CREW_ROLES.includes(input.crewRole)) {
    throw new Error(`CsvLeaveRepo: crewRole must be LP or ALP (got ${JSON.stringify(input.crewRole)})`);
  }
  if (!LEAVE_TYPES.includes(input.type)) {
    throw new Error(`CsvLeaveRepo: type must be SICK|LEAVE|TRAINING|PR (got ${JSON.stringify(input.type)})`);
  }
  if (!DATE_RE.test(input.fromDate)) {
    throw new Error(`CsvLeaveRepo: fromDate must be YYYY-MM-DD (got ${JSON.stringify(input.fromDate)})`);
  }
  if (!DATE_RE.test(input.toDate)) {
    throw new Error(`CsvLeaveRepo: toDate must be YYYY-MM-DD (got ${JSON.stringify(input.toDate)})`);
  }
  if (input.toDate < input.fromDate) {
    throw new Error('CsvLeaveRepo: toDate must be on or after fromDate');
  }
}

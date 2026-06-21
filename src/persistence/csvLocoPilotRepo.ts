// Storage-backed implementation of `LocoPilotRepo` (LLD §5.5).
//
// Uses the `TableStore` interface so the backing store can be CSV, Google
// Sheets, or any future adapter — the repo doesn't know or care.

import { randomUUID } from 'node:crypto';

import { ActiveFilter, LocoPilotRepo } from '../domain/repositories';
import { LocoPilot, LpCategory, TrainType } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  decodePipeList,
  encodeDate,
  encodePipeList,
} from './csvIo';
import type { TableStore } from './tableStore';

/** LLD §5.3 — exact column order. */
const LP_HEADER = [
  'id',
  'name',
  'category',
  'eligibleTrainTypes',
  'lastSignOffTime',
  'archivedAt',
  'isForeign',
] as const;

const LP_CATEGORIES = new Set<string>(Object.values(LpCategory));
const TRAIN_TYPES = new Set<string>(Object.values(TrainType));

export class CsvLocoPilotRepo implements LocoPilotRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'loco_pilots',
  ) {}

  async findById(id: string, opts: ActiveFilter = {}): Promise<LocoPilot | null> {
    const all = await this.readAll();
    const found = all.find((lp) => lp.id === id);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  async list(opts: ActiveFilter = {}): Promise<LocoPilot[]> {
    const all = await this.readAll();
    if (opts.includeArchived) return all;
    // Foreign staff are treated as inactive by default: excluded from
    // assignable/available enumerations, but still resolvable by id.
    return all.filter((lp) => !lp.archivedAt && !lp.isForeign);
  }

  async create(input: Omit<LocoPilot, 'id' | 'archivedAt'>): Promise<LocoPilot> {
    const row: LocoPilot = { ...input, id: `LP_${randomUUID()}` };
    await this.store.mutate(this.table, LP_HEADER, (rows) => [...rows, encodeLp(row)]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<LocoPilot, 'id'>>,
  ): Promise<LocoPilot> {
    let updated: LocoPilot | null = null;
    await this.store.mutate(this.table, LP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        const current = decodeLp(r);
        // Spread `patch` last so explicit `undefined` clears optional fields
        // (e.g. `lastSignOffTime: undefined` resets a manual override).
        const merged: LocoPilot = { ...current, ...patch, id: current.id };
        updated = merged;
        return encodeLp(merged);
      });
      if (!saw) throw new Error(`CsvLocoPilotRepo.update: id not found: ${id}`);
      return next;
    });
    return updated!;
  }

  async updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void> {
    await this.store.mutate(this.table, LP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        return { ...r, lastSignOffTime: lastSignOffTime.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvLocoPilotRepo.updateLastSignOff: id not found: ${id}`);
      }
      return next;
    });
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, LP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) throw new Error(`CsvLocoPilotRepo.archive: id not found: ${id}`);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<LocoPilot[]> {
    const rows = await this.store.read(this.table, LP_HEADER);
    return rows.map(decodeLp);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeLp(row: CsvRow): LocoPilot {
  const category = row['category'] ?? '';
  if (!LP_CATEGORIES.has(category)) {
    throw new Error(
      `CsvLocoPilotRepo: unknown LpCategory ${JSON.stringify(category)} (id=${row['id']})`,
    );
  }
  const types = decodePipeList(row['eligibleTrainTypes'] ?? '').map((t) => {
    if (!TRAIN_TYPES.has(t)) {
      throw new Error(
        `CsvLocoPilotRepo: unknown TrainType ${JSON.stringify(t)} (id=${row['id']})`,
      );
    }
    return t as TrainType;
  });
  return {
    id: row['id'] ?? '',
    name: row['name'] ?? '',
    category: category as LpCategory,
    eligibleTrainTypes: types,
    lastSignOffTime: decodeDate(row['lastSignOffTime'] ?? ''),
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
    isForeign: (row['isForeign'] ?? '').toLowerCase() === 'true',
  };
}

function encodeLp(lp: LocoPilot): CsvRow {
  return {
    id: lp.id,
    name: lp.name,
    category: lp.category,
    eligibleTrainTypes: encodePipeList(lp.eligibleTrainTypes),
    lastSignOffTime: encodeDate(lp.lastSignOffTime),
    archivedAt: encodeDate(lp.archivedAt),
    isForeign: lp.isForeign ? 'true' : '',
  };
}


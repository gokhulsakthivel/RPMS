// Csv-backed implementation of `LocoPilotRepo` (LLD §5.5).

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ActiveFilter, LocoPilotRepo } from '../domain/repositories';
import { LocoPilot, LpCategory, TrainType } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  decodePipeList,
  encodeDate,
  encodePipeList,
  mutateCsv,
  readCsvUnlocked,
} from './csvIo';

/** LLD §5.3 — exact column order. */
const LP_HEADER = [
  'id',
  'name',
  'category',
  'eligibleTrainTypes',
  'lastSignOffTime',
  'archivedAt',
] as const;

const LP_CATEGORIES = new Set<string>(Object.values(LpCategory));
const TRAIN_TYPES = new Set<string>(Object.values(TrainType));

export class CsvLocoPilotRepo implements LocoPilotRepo {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'loco_pilots.csv');
  }

  async findById(id: string, opts: ActiveFilter = {}): Promise<LocoPilot | null> {
    const all = await this.readAll();
    const found = all.find((lp) => lp.id === id);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  async list(opts: ActiveFilter = {}): Promise<LocoPilot[]> {
    const all = await this.readAll();
    return opts.includeArchived ? all : all.filter((lp) => !lp.archivedAt);
  }

  async create(input: Omit<LocoPilot, 'id' | 'archivedAt'>): Promise<LocoPilot> {
    const row: LocoPilot = { ...input, id: `LP_${randomUUID()}` };
    await mutateCsv(this.filePath, LP_HEADER, (rows) => [...rows, encodeLp(row)]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<LocoPilot, 'id'>>,
  ): Promise<LocoPilot> {
    let updated: LocoPilot | null = null;
    await mutateCsv(this.filePath, LP_HEADER, (rows) => {
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
    await mutateCsv(this.filePath, LP_HEADER, (rows) => {
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
    await mutateCsv(this.filePath, LP_HEADER, (rows) => {
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
    const rows = await readCsvUnlocked(this.filePath, LP_HEADER);
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
  };
}


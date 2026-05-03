// Csv-backed implementation of `AssistantLocoPilotRepo` (LLD §5.5).

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  ActiveFilter,
  AssistantLocoPilotRepo,
} from '../domain/repositories';
import { AssistantLocoPilot, TrainType } from '../domain/types';
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
const ALP_HEADER = [
  'id',
  'name',
  'eligibleTrainTypes',
  'lastSignOffTime',
  'archivedAt',
] as const;

const TRAIN_TYPES = new Set<string>(Object.values(TrainType));

/**
 * ALPs are NEVER assigned to MEMU/DEMU (HLD §4.5 / LLD §6 standard). The
 * loader rejects rows that violate this.
 */
const FORBIDDEN_ALP_TYPES = new Set<TrainType>([
  TrainType.MEMU,
  TrainType.DEMU,
]);

export class CsvAssistantLocoPilotRepo implements AssistantLocoPilotRepo {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'assistant_loco_pilots.csv');
  }

  async findById(id: string, opts: ActiveFilter = {}): Promise<AssistantLocoPilot | null> {
    const all = await this.readAll();
    const found = all.find((alp) => alp.id === id);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  async list(opts: ActiveFilter = {}): Promise<AssistantLocoPilot[]> {
    const all = await this.readAll();
    return opts.includeArchived ? all : all.filter((alp) => !alp.archivedAt);
  }

  async create(
    input: Omit<AssistantLocoPilot, 'id' | 'archivedAt'>,
  ): Promise<AssistantLocoPilot> {
    enforceNoMemuDemu(input.eligibleTrainTypes);
    const row: AssistantLocoPilot = { ...input, id: `ALP_${randomUUID()}` };
    await mutateCsv(this.filePath, ALP_HEADER, (rows) => [...rows, encodeAlp(row)]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<AssistantLocoPilot, 'id'>>,
  ): Promise<AssistantLocoPilot> {
    if (patch.eligibleTrainTypes) enforceNoMemuDemu(patch.eligibleTrainTypes);
    let updated: AssistantLocoPilot | null = null;
    await mutateCsv(this.filePath, ALP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        const current = decodeAlp(r);
        const merged: AssistantLocoPilot = { ...current, ...patch, id: current.id };
        updated = merged;
        return encodeAlp(merged);
      });
      if (!saw) {
        throw new Error(`CsvAssistantLocoPilotRepo.update: id not found: ${id}`);
      }
      return next;
    });
    return updated!;
  }

  async updateLastSignOff(id: string, lastSignOffTime: Date): Promise<void> {
    await mutateCsv(this.filePath, ALP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        return { ...r, lastSignOffTime: lastSignOffTime.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvAssistantLocoPilotRepo.updateLastSignOff: id not found: ${id}`);
      }
      return next;
    });
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await mutateCsv(this.filePath, ALP_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvAssistantLocoPilotRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<AssistantLocoPilot[]> {
    const rows = await readCsvUnlocked(this.filePath, ALP_HEADER);
    return rows.map(decodeAlp);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeAlp(row: CsvRow): AssistantLocoPilot {
  const types = decodePipeList(row['eligibleTrainTypes'] ?? '').map((t) => {
    if (!TRAIN_TYPES.has(t)) {
      throw new Error(
        `CsvAssistantLocoPilotRepo: unknown TrainType ${JSON.stringify(t)} (id=${row['id']})`,
      );
    }
    return t as TrainType;
  });
  enforceNoMemuDemu(types, row['id']);
  return {
    id: row['id'] ?? '',
    name: row['name'] ?? '',
    eligibleTrainTypes: types,
    lastSignOffTime: decodeDate(row['lastSignOffTime'] ?? ''),
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
}

function encodeAlp(alp: AssistantLocoPilot): CsvRow {
  return {
    id: alp.id,
    name: alp.name,
    eligibleTrainTypes: encodePipeList(alp.eligibleTrainTypes),
    lastSignOffTime: encodeDate(alp.lastSignOffTime),
    archivedAt: encodeDate(alp.archivedAt),
  };
}

function enforceNoMemuDemu(
  types: readonly TrainType[],
  id?: string,
): void {
  for (const t of types) {
    if (FORBIDDEN_ALP_TYPES.has(t)) {
      const where = id ? ` (id=${id})` : '';
      throw new Error(
        `CsvAssistantLocoPilotRepo: ${t} must not appear in eligibleTrainTypes — ALPs are not assigned to MEMU/DEMU${where}`,
      );
    }
  }
}

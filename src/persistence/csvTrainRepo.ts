// Csv-backed implementation of `TrainRepo` (LLD §5.5).
//
// Layering: depends on the domain interfaces and types only — no application,
// api, or web imports (techstack.md §7).
//
// M9 — recurring schedule. The CSV no longer stores absolute UTC departure /
// inward-arrival timestamps. It stores the abstract weekly schedule:
//   • `runsOnDays`              — pipe-list of `DayOfWeek` (e.g. `MON|WED|FRI`)
//   • `departureTimeOfDay`      — IST `HH:MM`
//   • `inwardArrivalTimeOfDay`  — IST `HH:MM`
//   • `inwardArrivalDayOffset`  — integer ≥ 0
// The orchestrator materializes a specific run via `runSchedule.materializeRun`.

import { randomUUID } from 'node:crypto';

import {
  ActiveFilter,
  TrainRepo,
} from '../domain/repositories';
import { DayOfWeek, Train, TrainType } from '../domain/types';
import {
  CsvRow,
  decodeDate,
  decodePipeList,
  encodeDate,
  encodePipeList,
} from './csvIo';
import type { TableStore } from './tableStore';

/**
 * LLD §5.3 — exact column order. The CSV loader asserts this on every read.
 *
 * Note (M9): the absolute `departureTime` / `inwardArrivalTime` columns are
 * gone. Trains are stored as a recurring schedule and materialized per run.
 */
const TRAINS_HEADER = [
  'id',
  'number',
  'name',
  'type',
  'onwardFromStation',
  'onwardToStation',
  'runsOnDays',
  'departureTimeOfDay',
  'inwardTrainNumber',
  'inwardFromStation',
  'inwardToStation',
  'inwardArrivalTimeOfDay',
  'inwardArrivalDayOffset',
  'archivedAt',
] as const;

const TRAIN_TYPES = new Set<string>(Object.values(TrainType));
const DAYS_OF_WEEK = new Set<string>(Object.values(DayOfWeek));
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CsvTrainRepo implements TrainRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'trains',
  ) {}

  async findById(id: string, opts: ActiveFilter = {}): Promise<Train | null> {
    const all = await this.readAll();
    const found = all.find((t) => t.id === id);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  async findByNumber(
    number: string,
    opts: ActiveFilter = {},
  ): Promise<Train | null> {
    // Train numbers are unique forever (LLD §6 standard) — we look at every
    // row regardless of archive state. The `includeArchived` flag controls
    // whether we *return* the archived match or hide it from the caller.
    const all = await this.readAll();
    const found = all.find((t) => t.number === number);
    if (!found) return null;
    if (!opts.includeArchived && found.archivedAt) return null;
    return found;
  }

  /**
   * M9: returns active (or all) recurring trains. Day-of-week filtering for
   * a specific calendar run happens in the application layer via
   * `runSchedule.trainRunsOn`.
   */
  async list(opts: ActiveFilter = {}): Promise<Train[]> {
    const all = await this.readAll();
    return opts.includeArchived ? all : all.filter((t) => !t.archivedAt);
  }

  async create(input: Omit<Train, 'id' | 'archivedAt'>): Promise<Train> {
    validateScheduleShape(input);
    const row: Train = { ...input, id: `TRN_${randomUUID()}` };
    await this.store.mutate(this.table, TRAINS_HEADER, (rows) => {
      // Defence-in-depth: reject duplicate `number` (the loader catches this on
      // read, but we surface it earlier on the write path so the caller gets
      // a precise error instead of a corrupt file).
      if (rows.some((r) => r['number'] === input.number)) {
        throw new Error(
          `CsvTrainRepo.create: train number ${JSON.stringify(input.number)} already exists`,
        );
      }
      return [...rows, encodeTrain(row)];
    });
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<Train, 'id'>>,
  ): Promise<Train> {
    let updated: Train | null = null;
    await this.store.mutate(this.table, TRAINS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        const current = decodeTrain(r);
        const merged: Train = { ...current, ...patch, id: current.id };
        validateScheduleShape(merged);
        if (
          patch.number !== undefined &&
          patch.number !== current.number &&
          rows.some((other) => other['id'] !== id && other['number'] === patch.number)
        ) {
          throw new Error(
            `CsvTrainRepo.update: train number ${JSON.stringify(patch.number)} already exists`,
          );
        }
        updated = merged;
        return encodeTrain(merged);
      });
      if (!saw) {
        throw new Error(`CsvTrainRepo.update: id not found: ${id}`);
      }
      return next;
    });
    // After mutateCsv resolves, `updated` is set by the transform above.
    return updated!;
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, TRAINS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r; // idempotent
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvTrainRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<Train[]> {
    const rows = await this.store.read(this.table, TRAINS_HEADER);
    return rows.map(decodeTrain);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping. Kept as pure module-level functions (not methods) so
// they can be unit-tested without instantiating the repo.
// ---------------------------------------------------------------------------

function decodeTrain(row: CsvRow): Train {
  const id = row['id'] ?? '';
  const type = row['type'] as string;
  if (!TRAIN_TYPES.has(type)) {
    throw new Error(`CsvTrainRepo: unknown TrainType ${JSON.stringify(type)} (id=${id})`);
  }

  const runsOnDaysRaw = decodePipeList(row['runsOnDays'] ?? '');
  if (runsOnDaysRaw.length === 0) {
    throw new Error(`CsvTrainRepo: runsOnDays is empty (id=${id})`);
  }
  const runsOnDays = runsOnDaysRaw.map((d) => {
    if (!DAYS_OF_WEEK.has(d)) {
      throw new Error(`CsvTrainRepo: unknown DayOfWeek ${JSON.stringify(d)} (id=${id})`);
    }
    return d as DayOfWeek;
  });
  if (new Set(runsOnDays).size !== runsOnDays.length) {
    throw new Error(`CsvTrainRepo: runsOnDays contains duplicates (id=${id})`);
  }

  const departureTimeOfDay = row['departureTimeOfDay'] ?? '';
  if (!TIME_OF_DAY_RE.test(departureTimeOfDay)) {
    throw new Error(
      `CsvTrainRepo: departureTimeOfDay must be HH:MM (got ${JSON.stringify(departureTimeOfDay)}, id=${id})`,
    );
  }
  const inwardArrivalTimeOfDay = row['inwardArrivalTimeOfDay'] ?? '';
  if (!TIME_OF_DAY_RE.test(inwardArrivalTimeOfDay)) {
    throw new Error(
      `CsvTrainRepo: inwardArrivalTimeOfDay must be HH:MM (got ${JSON.stringify(inwardArrivalTimeOfDay)}, id=${id})`,
    );
  }

  const offsetCell = row['inwardArrivalDayOffset'] ?? '';
  const inwardArrivalDayOffset = Number(offsetCell);
  if (
    offsetCell === '' ||
    !Number.isInteger(inwardArrivalDayOffset) ||
    inwardArrivalDayOffset < 0
  ) {
    throw new Error(
      `CsvTrainRepo: inwardArrivalDayOffset must be a non-negative integer (got ${JSON.stringify(offsetCell)}, id=${id})`,
    );
  }

  return {
    id,
    number: row['number'] ?? '',
    name: row['name'] ?? '',
    type: type as TrainType,
    onwardFromStation: row['onwardFromStation'] ?? '',
    onwardToStation: row['onwardToStation'] ?? '',
    runsOnDays,
    departureTimeOfDay,
    inwardTrainNumber: row['inwardTrainNumber'] ?? '',
    inwardFromStation: row['inwardFromStation'] ?? '',
    inwardToStation: row['inwardToStation'] ?? '',
    inwardArrivalTimeOfDay,
    inwardArrivalDayOffset,
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
}

function encodeTrain(t: Train): CsvRow {
  return {
    id: t.id,
    number: t.number,
    name: t.name,
    type: t.type,
    onwardFromStation: t.onwardFromStation,
    onwardToStation: t.onwardToStation,
    runsOnDays: encodePipeList(t.runsOnDays),
    departureTimeOfDay: t.departureTimeOfDay,
    inwardTrainNumber: t.inwardTrainNumber,
    inwardFromStation: t.inwardFromStation,
    inwardToStation: t.inwardToStation,
    inwardArrivalTimeOfDay: t.inwardArrivalTimeOfDay,
    inwardArrivalDayOffset: String(t.inwardArrivalDayOffset),
    archivedAt: encodeDate(t.archivedAt),
  };
}

/**
 * Defensive shape check on the write path. Mirrors the loader checks but runs
 * BEFORE we touch the file so a bad input fails fast with a clear error
 * instead of corrupting the row.
 */
function validateScheduleShape(t: Omit<Train, 'id' | 'archivedAt'>): void {
  if (!Array.isArray(t.runsOnDays) || t.runsOnDays.length === 0) {
    throw new Error('CsvTrainRepo: runsOnDays must be a non-empty array');
  }
  if (new Set(t.runsOnDays).size !== t.runsOnDays.length) {
    throw new Error('CsvTrainRepo: runsOnDays must not contain duplicates');
  }
  for (const d of t.runsOnDays) {
    if (!DAYS_OF_WEEK.has(d)) {
      throw new Error(`CsvTrainRepo: unknown DayOfWeek ${JSON.stringify(d)}`);
    }
  }
  if (!TIME_OF_DAY_RE.test(t.departureTimeOfDay)) {
    throw new Error(
      `CsvTrainRepo: departureTimeOfDay must be HH:MM (got ${JSON.stringify(t.departureTimeOfDay)})`,
    );
  }
  if (!TIME_OF_DAY_RE.test(t.inwardArrivalTimeOfDay)) {
    throw new Error(
      `CsvTrainRepo: inwardArrivalTimeOfDay must be HH:MM (got ${JSON.stringify(t.inwardArrivalTimeOfDay)})`,
    );
  }
  if (
    !Number.isInteger(t.inwardArrivalDayOffset) ||
    t.inwardArrivalDayOffset < 0
  ) {
    throw new Error(
      `CsvTrainRepo: inwardArrivalDayOffset must be a non-negative integer (got ${t.inwardArrivalDayOffset})`,
    );
  }
}

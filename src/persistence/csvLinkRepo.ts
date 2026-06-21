// Csv-backed implementation of `LinkRepo` (HLD §4.9 / LLD §5.5).
//
// `positions` is a nested structure (1..N entries, each a discriminated
// union with optional segment list). Per LLD §5.3 we serialize it as
// JSON in a single CSV column so the row stays one line and the schema
// stays append-friendly. The decoder re-validates the cycle on every
// read — corrupt rows fail fast rather than poisoning downstream code.

import { randomUUID } from 'node:crypto';

import { ActiveFilter, LinkRepo } from '../domain/repositories';
import {
  CrewRole,
  Link,
  LinkPosition,
  LinkPositionKind,
  LpCategory,
} from '../domain/types';
import { CsvRow, decodeDate, encodeDate } from './csvIo';
import type { TableStore } from './tableStore';

/** LLD §5.3 — exact column order. Keep in lockstep with `data/links.csv`. */
const LINKS_HEADER = [
  'id',
  'name',
  'crewRole',
  'lpCategory',
  'cycleLength',
  'positions',
  'createdAt',
  'archivedAt',
] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CREW_ROLES: ReadonlyArray<CrewRole> = ['LP', 'ALP'];
const LP_CATEGORIES: ReadonlyArray<LpCategory> = [
  LpCategory.MAIL_EXPRESS,
  LpCategory.PASSENGER,
];
const POSITION_KINDS: ReadonlyArray<LinkPositionKind> = [
  LinkPositionKind.DUTY,
  LinkPositionKind.OFF,
  LinkPositionKind.PR,
];

export class CsvLinkRepo implements LinkRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'links',
  ) {}

  async findById(id: string, opts: ActiveFilter = {}): Promise<Link | null> {
    const all = await this.readAll();
    for (const l of all) {
      if (l.id !== id) continue;
      if (!opts.includeArchived && l.archivedAt) return null;
      return l;
    }
    return null;
  }

  async list(
    opts: ActiveFilter & { crewRole?: CrewRole } = {},
  ): Promise<Link[]> {
    const all = await this.readAll();
    return all.filter((l) => {
      if (!opts.includeArchived && l.archivedAt) return false;
      if (opts.crewRole && l.crewRole !== opts.crewRole) return false;
      return true;
    });
  }

  async create(
    input: Omit<Link, 'id' | 'createdAt' | 'archivedAt'>,
  ): Promise<Link> {
    assertValidLinkInput(input);
    const row: Link = {
      ...input,
      id: `LNK_${randomUUID()}`,
      createdAt: new Date(),
    };
    await this.store.mutate(this.table, LINKS_HEADER, (rows) => [
      ...rows,
      encodeLink(row),
    ]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<Link, 'id' | 'createdAt'>>,
  ): Promise<Link> {
    let updated: Link | null = null;
    await this.store.mutate(this.table, LINKS_HEADER, (rows) => {
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        const current = decodeLink(r);
        const merged: Link = {
          ...current,
          ...patch,
        };
        // `lpCategory: undefined` in the patch should clear the field —
        // spread keeps it `undefined` which is what we want.
        assertValidLinkInput(merged);
        updated = merged;
        return encodeLink(merged);
      });
      if (!updated) {
        throw new Error(`CsvLinkRepo.update: id not found: ${id}`);
      }
      return next;
    });
    return updated!;
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, LINKS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvLinkRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<Link[]> {
    const rows = await this.store.read(this.table, LINKS_HEADER);
    return rows.map(decodeLink);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeLink(row: CsvRow): Link {
  const id = row['id'] ?? '';
  const name = row['name'] ?? '';
  if (name.trim() === '') {
    throw new Error(`CsvLinkRepo: name is required (id=${id})`);
  }
  const crewRoleRaw = row['crewRole'] ?? '';
  if (!CREW_ROLES.includes(crewRoleRaw as CrewRole)) {
    throw new Error(
      `CsvLinkRepo: crewRole must be LP or ALP (got ${JSON.stringify(crewRoleRaw)}, id=${id})`,
    );
  }
  const crewRole = crewRoleRaw as CrewRole;

  const lpCategoryRaw = row['lpCategory'] ?? '';
  let lpCategory: LpCategory | undefined;
  if (lpCategoryRaw !== '') {
    if (!LP_CATEGORIES.includes(lpCategoryRaw as LpCategory)) {
      throw new Error(
        `CsvLinkRepo: lpCategory must be MAIL_EXPRESS or PASSENGER (got ${JSON.stringify(lpCategoryRaw)}, id=${id})`,
      );
    }
    if (crewRole !== 'LP') {
      throw new Error(
        `CsvLinkRepo: lpCategory only valid when crewRole is LP (id=${id})`,
      );
    }
    lpCategory = lpCategoryRaw as LpCategory;
  }

  const cycleLengthRaw = row['cycleLength'] ?? '';
  const cycleLength = Number(cycleLengthRaw);
  if (!Number.isInteger(cycleLength) || cycleLength < 1) {
    throw new Error(
      `CsvLinkRepo: cycleLength must be a positive integer (got ${JSON.stringify(cycleLengthRaw)}, id=${id})`,
    );
  }

  const positions = decodePositions(row['positions'] ?? '', cycleLength, id);

  const createdAt = decodeDate(row['createdAt'] ?? '');
  if (!createdAt) {
    throw new Error(`CsvLinkRepo: createdAt is required (id=${id})`);
  }

  const link: Link = {
    id,
    name,
    crewRole,
    cycleLength,
    positions,
    createdAt,
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
  if (lpCategory !== undefined) link.lpCategory = lpCategory;
  return link;
}

function encodeLink(l: Link): CsvRow {
  return {
    id: l.id,
    name: l.name,
    crewRole: l.crewRole,
    lpCategory: l.lpCategory ?? '',
    cycleLength: String(l.cycleLength),
    positions: JSON.stringify(l.positions),
    createdAt: encodeDate(l.createdAt),
    archivedAt: encodeDate(l.archivedAt),
  };
}

function decodePositions(
  json: string,
  cycleLength: number,
  id: string,
): LinkPosition[] {
  if (json.trim() === '') {
    throw new Error(`CsvLinkRepo: positions column is empty (id=${id})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `CsvLinkRepo: positions is not valid JSON (id=${id}): ${(cause as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`CsvLinkRepo: positions must be a JSON array (id=${id})`);
  }
  if (parsed.length !== cycleLength) {
    throw new Error(
      `CsvLinkRepo: positions.length (${parsed.length}) !== cycleLength (${cycleLength}) (id=${id})`,
    );
  }
  return parsed.map((p, i) => decodePosition(p, i, id));
}

function decodePosition(value: unknown, index: number, id: string): LinkPosition {
  if (!value || typeof value !== 'object') {
    throw new Error(
      `CsvLinkRepo: positions[${index}] must be an object (id=${id})`,
    );
  }
  const obj = value as Record<string, unknown>;
  const positionNumber = obj['positionNumber'];
  if (positionNumber !== index + 1) {
    throw new Error(
      `CsvLinkRepo: positions[${index}].positionNumber must be ${index + 1} (got ${JSON.stringify(positionNumber)}, id=${id})`,
    );
  }
  const kindRaw = obj['kind'];
  if (typeof kindRaw !== 'string' || !POSITION_KINDS.includes(kindRaw as LinkPositionKind)) {
    throw new Error(
      `CsvLinkRepo: positions[${index}].kind must be DUTY|OFF|PR (got ${JSON.stringify(kindRaw)}, id=${id})`,
    );
  }
  const kind = kindRaw as LinkPositionKind;

  if (kind === LinkPositionKind.DUTY) {
    const segments = obj['segments'];
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error(
        `CsvLinkRepo: positions[${index}].segments must be a non-empty array (id=${id})`,
      );
    }
    return {
      positionNumber: index + 1,
      kind: LinkPositionKind.DUTY,
      segments: segments.map((s, j) => decodeSegment(s, index, j, id)),
    };
  }
  return { positionNumber: index + 1, kind };
}

function decodeSegment(
  value: unknown,
  posIndex: number,
  segIndex: number,
  id: string,
): {
  trainNumber: string;
  direction?: 'outward' | 'inward' | 'conti';
  fromStation?: string;
  toStation?: string;
  signOnTimeOfDay: string;
  signOffTimeOfDay: string;
  signOffDayOffset: number;
} {
  if (!value || typeof value !== 'object') {
    throw new Error(
      `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}] must be an object (id=${id})`,
    );
  }
  const obj = value as Record<string, unknown>;
  const trainNumber = obj['trainNumber'];
  if (typeof trainNumber !== 'string' || trainNumber.trim() === '') {
    throw new Error(
      `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}].trainNumber required (id=${id})`,
    );
  }
  const signOn = obj['signOnTimeOfDay'];
  const signOff = obj['signOffTimeOfDay'];
  if (typeof signOn !== 'string' || !TIME_RE.test(signOn)) {
    throw new Error(
      `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}].signOnTimeOfDay must be HH:MM (id=${id})`,
    );
  }
  if (typeof signOff !== 'string' || !TIME_RE.test(signOff)) {
    throw new Error(
      `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}].signOffTimeOfDay must be HH:MM (id=${id})`,
    );
  }
  const offset = obj['signOffDayOffset'];
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 3) {
    throw new Error(
      `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}].signOffDayOffset must be integer 0–3 (id=${id})`,
    );
  }
  const dirRaw = obj['direction'];
  let direction: 'outward' | 'inward' | 'conti' | undefined;
  if (dirRaw !== undefined && dirRaw !== null && dirRaw !== '') {
    if (dirRaw !== 'outward' && dirRaw !== 'inward' && dirRaw !== 'conti') {
      throw new Error(
        `CsvLinkRepo: positions[${posIndex}].segments[${segIndex}].direction must be outward|inward|conti (id=${id})`,
      );
    }
    direction = dirRaw;
  }
  const fromRaw = obj['fromStation'];
  const toRaw = obj['toStation'];
  const fromStation =
    typeof fromRaw === 'string' && fromRaw.trim() !== '' ? fromRaw : undefined;
  const toStation =
    typeof toRaw === 'string' && toRaw.trim() !== '' ? toRaw : undefined;
  return {
    trainNumber,
    ...(direction ? { direction } : {}),
    ...(fromStation ? { fromStation } : {}),
    ...(toStation ? { toStation } : {}),
    signOnTimeOfDay: signOn,
    signOffTimeOfDay: signOff,
    signOffDayOffset: offset,
  };
}

/**
 * Pre-write validation shared by `create` and `update`. Mirrors the Zod
 * schema in `src/shared/schemas.ts`.
 */
function assertValidLinkInput(
  input: Pick<Link, 'name' | 'crewRole' | 'lpCategory' | 'cycleLength' | 'positions'>,
): void {
  if (!input.name || input.name.trim() === '') {
    throw new Error('CsvLinkRepo: name must be a non-empty string');
  }
  if (!CREW_ROLES.includes(input.crewRole)) {
    throw new Error(
      `CsvLinkRepo: crewRole must be LP or ALP (got ${JSON.stringify(input.crewRole)})`,
    );
  }
  if (input.lpCategory !== undefined) {
    if (!LP_CATEGORIES.includes(input.lpCategory)) {
      throw new Error(
        `CsvLinkRepo: lpCategory must be MAIL_EXPRESS or PASSENGER (got ${JSON.stringify(input.lpCategory)})`,
      );
    }
    if (input.crewRole !== 'LP') {
      throw new Error('CsvLinkRepo: lpCategory only valid when crewRole is LP');
    }
  }
  if (!Number.isInteger(input.cycleLength) || input.cycleLength < 1) {
    throw new Error(
      `CsvLinkRepo: cycleLength must be a positive integer (got ${input.cycleLength})`,
    );
  }
  if (!Array.isArray(input.positions) || input.positions.length !== input.cycleLength) {
    throw new Error(
      `CsvLinkRepo: positions.length must equal cycleLength (got ${input.positions?.length}/${input.cycleLength})`,
    );
  }
  input.positions.forEach((p, i) => {
    if (p.positionNumber !== i + 1) {
      throw new Error(
        `CsvLinkRepo: positions[${i}].positionNumber must be ${i + 1} (got ${p.positionNumber})`,
      );
    }
    if (!POSITION_KINDS.includes(p.kind)) {
      throw new Error(`CsvLinkRepo: positions[${i}].kind must be DUTY|OFF|PR`);
    }
    if (p.kind === LinkPositionKind.DUTY) {
      if (!Array.isArray(p.segments) || p.segments.length === 0) {
        throw new Error(
          `CsvLinkRepo: positions[${i}].segments must be a non-empty array`,
        );
      }
      p.segments.forEach((s, j) => {
        if (!s.trainNumber || s.trainNumber.trim() === '') {
          throw new Error(
            `CsvLinkRepo: positions[${i}].segments[${j}].trainNumber required`,
          );
        }
        if (!TIME_RE.test(s.signOnTimeOfDay) || !TIME_RE.test(s.signOffTimeOfDay)) {
          throw new Error(
            `CsvLinkRepo: positions[${i}].segments[${j}] times must be HH:MM`,
          );
        }
        if (
          !Number.isInteger(s.signOffDayOffset) ||
          s.signOffDayOffset < 0 ||
          s.signOffDayOffset > 3
        ) {
          throw new Error(
            `CsvLinkRepo: positions[${i}].segments[${j}].signOffDayOffset must be integer 0–3`,
          );
        }
      });
    }
  });
}

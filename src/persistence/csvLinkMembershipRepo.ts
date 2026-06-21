// Csv-backed implementation of `LinkMembershipRepo` (HLD §4.10 / LLD §5.5).

import { randomUUID } from 'node:crypto';

import { ActiveFilter, LinkMembershipRepo } from '../domain/repositories';
import { CrewRole, LinkMembership } from '../domain/types';
import { CsvRow, decodeDate, encodeDate } from './csvIo';
import type { TableStore } from './tableStore';

/** LLD §5.3 — exact column order. Keep in lockstep with `data/link_memberships.csv`. */
const LINK_MEMBERSHIPS_HEADER = [
  'id',
  'linkId',
  'crewId',
  'crewRole',
  'anchorDate',
  'anchorPositionNumber',
  'createdAt',
  'archivedAt',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CREW_ROLES: ReadonlyArray<CrewRole> = ['LP', 'ALP'];

export class CsvLinkMembershipRepo implements LinkMembershipRepo {
  constructor(
    private readonly store: TableStore,
    private readonly table = 'link_memberships',
  ) {}

  async findById(id: string, opts: ActiveFilter = {}): Promise<LinkMembership | null> {
    const all = await this.readAll();
    for (const m of all) {
      if (m.id !== id) continue;
      if (!opts.includeArchived && m.archivedAt) return null;
      return m;
    }
    return null;
  }

  async list(opts: ActiveFilter = {}): Promise<LinkMembership[]> {
    const all = await this.readAll();
    return opts.includeArchived ? all : all.filter((m) => !m.archivedAt);
  }

  async listByLink(
    linkId: string,
    opts: ActiveFilter = {},
  ): Promise<LinkMembership[]> {
    const all = await this.readAll();
    return all.filter((m) => {
      if (m.linkId !== linkId) return false;
      if (!opts.includeArchived && m.archivedAt) return false;
      return true;
    });
  }

  async findActiveByCrew(crewId: string): Promise<LinkMembership | null> {
    const all = await this.readAll();
    for (const m of all) {
      if (m.crewId === crewId && !m.archivedAt) return m;
    }
    return null;
  }

  async create(
    input: Omit<LinkMembership, 'id' | 'createdAt' | 'archivedAt'>,
  ): Promise<LinkMembership> {
    assertValidMembershipInput(input);
    const row: LinkMembership = {
      ...input,
      id: `LMB_${randomUUID()}`,
      createdAt: new Date(),
    };
    await this.store.mutate(this.table, LINK_MEMBERSHIPS_HEADER, (rows) => [
      ...rows,
      encodeMembership(row),
    ]);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<LinkMembership, 'id' | 'createdAt'>>,
  ): Promise<LinkMembership> {
    let updated: LinkMembership | null = null;
    await this.store.mutate(this.table, LINK_MEMBERSHIPS_HEADER, (rows) => {
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        const current = decodeMembership(r);
        const merged: LinkMembership = { ...current, ...patch };
        assertValidMembershipInput(merged);
        updated = merged;
        return encodeMembership(merged);
      });
      if (!updated) {
        throw new Error(`CsvLinkMembershipRepo.update: id not found: ${id}`);
      }
      return next;
    });
    return updated!;
  }

  async archive(id: string): Promise<void> {
    const now = new Date();
    await this.store.mutate(this.table, LINK_MEMBERSHIPS_HEADER, (rows) => {
      let saw = false;
      const next = rows.map((r) => {
        if (r['id'] !== id) return r;
        saw = true;
        if (r['archivedAt'] !== '') return r;
        return { ...r, archivedAt: now.toISOString() };
      });
      if (!saw) {
        throw new Error(`CsvLinkMembershipRepo.archive: id not found: ${id}`);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async readAll(): Promise<LinkMembership[]> {
    const rows = await this.store.read(this.table, LINK_MEMBERSHIPS_HEADER);
    return rows.map(decodeMembership);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ domain mapping
// ---------------------------------------------------------------------------

function decodeMembership(row: CsvRow): LinkMembership {
  const id = row['id'] ?? '';
  const linkId = row['linkId'] ?? '';
  if (linkId === '') {
    throw new Error(`CsvLinkMembershipRepo: linkId is required (id=${id})`);
  }
  const crewId = row['crewId'] ?? '';
  if (crewId === '') {
    throw new Error(`CsvLinkMembershipRepo: crewId is required (id=${id})`);
  }
  const crewRole = row['crewRole'] ?? '';
  if (!CREW_ROLES.includes(crewRole as CrewRole)) {
    throw new Error(
      `CsvLinkMembershipRepo: crewRole must be LP or ALP (got ${JSON.stringify(crewRole)}, id=${id})`,
    );
  }
  const anchorDate = row['anchorDate'] ?? '';
  if (!DATE_RE.test(anchorDate)) {
    throw new Error(
      `CsvLinkMembershipRepo: anchorDate must be YYYY-MM-DD (got ${JSON.stringify(anchorDate)}, id=${id})`,
    );
  }
  const anchorPositionRaw = row['anchorPositionNumber'] ?? '';
  const anchorPositionNumber = Number(anchorPositionRaw);
  if (!Number.isInteger(anchorPositionNumber) || anchorPositionNumber < 1) {
    throw new Error(
      `CsvLinkMembershipRepo: anchorPositionNumber must be positive integer (got ${JSON.stringify(anchorPositionRaw)}, id=${id})`,
    );
  }
  const createdAt = decodeDate(row['createdAt'] ?? '');
  if (!createdAt) {
    throw new Error(`CsvLinkMembershipRepo: createdAt is required (id=${id})`);
  }

  return {
    id,
    linkId,
    crewId,
    crewRole: crewRole as CrewRole,
    anchorDate,
    anchorPositionNumber,
    createdAt,
    archivedAt: decodeDate(row['archivedAt'] ?? ''),
  };
}

function encodeMembership(m: LinkMembership): CsvRow {
  return {
    id: m.id,
    linkId: m.linkId,
    crewId: m.crewId,
    crewRole: m.crewRole,
    anchorDate: m.anchorDate,
    anchorPositionNumber: String(m.anchorPositionNumber),
    createdAt: encodeDate(m.createdAt),
    archivedAt: encodeDate(m.archivedAt),
  };
}

function assertValidMembershipInput(
  input: Pick<LinkMembership, 'linkId' | 'crewId' | 'crewRole' | 'anchorDate' | 'anchorPositionNumber'>,
): void {
  if (!input.linkId || input.linkId.trim() === '') {
    throw new Error('CsvLinkMembershipRepo: linkId must be a non-empty string');
  }
  if (!input.crewId || input.crewId.trim() === '') {
    throw new Error('CsvLinkMembershipRepo: crewId must be a non-empty string');
  }
  if (!CREW_ROLES.includes(input.crewRole)) {
    throw new Error(
      `CsvLinkMembershipRepo: crewRole must be LP or ALP (got ${JSON.stringify(input.crewRole)})`,
    );
  }
  if (!DATE_RE.test(input.anchorDate)) {
    throw new Error(
      `CsvLinkMembershipRepo: anchorDate must be YYYY-MM-DD (got ${JSON.stringify(input.anchorDate)})`,
    );
  }
  if (!Number.isInteger(input.anchorPositionNumber) || input.anchorPositionNumber < 1) {
    throw new Error(
      `CsvLinkMembershipRepo: anchorPositionNumber must be positive integer (got ${input.anchorPositionNumber})`,
    );
  }
}

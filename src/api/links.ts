// `/api/links` router (HLD §4.9 / LLD §5.5).
//
// Routes:
//   GET    /api/links                  → LinkRow[] (active only by default)
//   GET    /api/links/projection?date= → LinkProjectionRow[]  (HLD §4.10 / Phase 2)
//   POST   /api/links                  → LinkRow   (Zod-validated body)
//   PUT    /api/links/:id              → LinkRow   (Zod-validated body)
//   POST   /api/links/:id/archive      → 204
//
// Phase 1 scope: CRUD only. Phase 2 adds the projection endpoint. Auto-Draft
// consumption (Phase 3) lives elsewhere. The list endpoint resolves
// `memberCount` per row so the SPA can show a "16/19 filled" hint without a
// second round-trip.

import { Router } from 'express';

import { resolvePositionForRun } from '../domain/linkSchedule';
import {
  AssistantLocoPilotRepo,
  LinkMembershipRepo,
  LinkRepo,
  LocoPilotRepo,
} from '../domain/repositories';
import { Link, LpCategory } from '../domain/types';
import {
  LinkCreateInput,
  LinkProjectionRow,
  LinkRow,
  LinkPositionRow,
  LinkUpdateInput,
} from '../shared/schemas';
import {
  asyncHandler,
  BadRequestError,
  NotFoundError,
  requireParam,
} from './errorMiddleware';

export interface LinksRouterDeps {
  links: LinkRepo;
  linkMemberships: LinkMembershipRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createLinksRouter(deps: LinksRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/links
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const all = await deps.links.list();
      const memberships = await deps.linkMemberships.list();
      const countByLink = new Map<string, number>();
      for (const m of memberships) {
        countByLink.set(m.linkId, (countByLink.get(m.linkId) ?? 0) + 1);
      }
      const rows: LinkRow[] = all
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((l) => linkToRow(l, countByLink.get(l.id) ?? 0));
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/links/projection?date=YYYY-MM-DD (HLD §4.10 / Phase 2)
  //
  // Returns one row per active membership with the link's resolved position
  // for the requested run date. Archived links are still included if they
  // have active memberships — this surfaces "stale" memberships that need
  // an operator to clean up.
  // -------------------------------------------------------------------------
  router.get(
    '/projection',
    asyncHandler(async (req, res) => {
      const dateQ = req.query['date'];
      if (typeof dateQ !== 'string' || !ISO_DATE_RE.test(dateQ)) {
        throw new BadRequestError('date query param must be YYYY-MM-DD', {
          got: typeof dateQ === 'string' ? dateQ : null,
        });
      }
      const runDate = dateQ;

      const [memberships, allLps, allAlps] = await Promise.all([
        deps.linkMemberships.list(),
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);

      const lpsById = new Map(allLps.map((c) => [c.id, c] as const));
      const alpsById = new Map(allAlps.map((c) => [c.id, c] as const));
      const linkCache = new Map<string, Link>();
      const rows: LinkProjectionRow[] = [];

      for (const m of memberships) {
        let link = linkCache.get(m.linkId);
        if (!link) {
          const fetched = await deps.links.findById(m.linkId, {
            includeArchived: true,
          });
          if (!fetched) continue; // membership references a deleted link
          link = fetched;
          linkCache.set(m.linkId, fetched);
        }
        const lp = m.crewRole === 'LP' ? lpsById.get(m.crewId) : undefined;
        const alp = m.crewRole === 'ALP' ? alpsById.get(m.crewId) : undefined;
        const crewName = lp?.name ?? alp?.name ?? '(unknown)';
        const { positionNumber, position } = resolvePositionForRun(
          link,
          m,
          runDate,
        );
        rows.push({
          membershipId: m.id,
          linkId: link.id,
          linkName: link.name,
          crewId: m.crewId,
          crewRole: m.crewRole,
          crewName,
          ...(lp ? { lpCategory: lp.category } : {}),
          positionNumber,
          position: positionToRow(position),
        });
      }

      // Stable order: link name asc, then positionNumber asc, then crewName asc.
      rows.sort((a, b) => {
        if (a.linkName !== b.linkName) return a.linkName < b.linkName ? -1 : 1;
        if (a.positionNumber !== b.positionNumber)
          return a.positionNumber - b.positionNumber;
        return a.crewName < b.crewName ? -1 : 1;
      });
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/links
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = LinkCreateInput.parse(req.body);
      const created = await deps.links.create({
        name: input.name,
        crewRole: input.crewRole,
        cycleLength: input.cycleLength,
        positions: input.positions,
        ...(input.lpCategory !== undefined ? { lpCategory: input.lpCategory } : {}),
      });
      res.status(201).json(linkToRow(created, 0));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/links/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = LinkUpdateInput.parse(req.body);

      const current = await deps.links.findById(id);
      if (!current) throw new NotFoundError('LINK', id);

      const repoPatch: Parameters<LinkRepo['update']>[1] = {};
      if (patch.name !== undefined) repoPatch.name = patch.name;
      if (patch.crewRole !== undefined) repoPatch.crewRole = patch.crewRole;
      if (patch.cycleLength !== undefined) repoPatch.cycleLength = patch.cycleLength;
      if (patch.positions !== undefined) repoPatch.positions = patch.positions;
      // `null` from the wire clears the optional field; `undefined` leaves it alone.
      if (patch.lpCategory === null) repoPatch.lpCategory = undefined;
      else if (patch.lpCategory !== undefined) repoPatch.lpCategory = patch.lpCategory as LpCategory;

      const updated = await deps.links.update(id, repoPatch);
      const memberships = await deps.linkMemberships.listByLink(updated.id);
      res.json(linkToRow(updated, memberships.length));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/links/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.links.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('LINK', id);
      await deps.links.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function linkToRow(l: Link, memberCount: number): LinkRow {
  const row: LinkRow = {
    id: l.id,
    name: l.name,
    crewRole: l.crewRole,
    cycleLength: l.cycleLength,
    positions: l.positions.map(positionToRow),
    memberCount,
    createdAt: l.createdAt.toISOString(),
  };
  if (l.lpCategory !== undefined) row.lpCategory = l.lpCategory;
  return row;
}

function positionToRow(p: Link['positions'][number]): LinkPositionRow {
  if (p.kind === 'DUTY') {
    return {
      positionNumber: p.positionNumber,
      kind: 'DUTY',
      segments: p.segments.map((s) => ({
        trainNumber: s.trainNumber,
        ...(s.direction ? { direction: s.direction } : {}),
        ...(s.fromStation ? { fromStation: s.fromStation } : {}),
        ...(s.toStation ? { toStation: s.toStation } : {}),
        signOnTimeOfDay: s.signOnTimeOfDay,
        signOffTimeOfDay: s.signOffTimeOfDay,
        signOffDayOffset: s.signOffDayOffset,
      })),
    };
  }
  return { positionNumber: p.positionNumber, kind: p.kind };
}

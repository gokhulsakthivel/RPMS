// `/api/link-memberships` router (HLD §4.10 / LLD §5.5).
//
// Routes:
//   GET    /api/link-memberships?linkId=...&asOfDate=YYYY-MM-DD → LinkMembershipRow[]
//   POST   /api/link-memberships                  → LinkMembershipRow
//   PUT    /api/link-memberships/:id              → LinkMembershipRow
//   POST   /api/link-memberships/:id/archive      → 204
//
// `linkId` query is the primary access pattern (Memberships panel in the
// LinksPage). `asOfDate` opt-in resolves each crew member's current
// position via `linkSchedule.positionOnDate` so the panel can show the
// rotation snapshot for any date.
//
// Cross-validations enforced here (rather than in the repo):
//   - parent link exists and is active
//   - membership.crewRole === parent link's crewRole
//   - anchorPositionNumber ∈ [1..link.cycleLength]
//   - the named crew exists in the matching roster
//   - one ACTIVE membership per crew member at a time

import { Router } from 'express';

import { positionOnDate } from '../domain/linkSchedule';
import {
  AssistantLocoPilotRepo,
  LinkMembershipRepo,
  LinkRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { CrewRole, Link, LinkMembership, TrainType } from '../domain/types';
import {
  LinkMembershipCreateInput,
  LinkMembershipRow,
  LinkMembershipUpdateInput,
} from '../shared/schemas';
import {
  asyncHandler,
  BadRequestError,
  ConflictError,
  NotFoundError,
  requireParam,
} from './errorMiddleware';

export interface LinkMembershipsRouterDeps {
  links: LinkRepo;
  linkMemberships: LinkMembershipRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  trains: TrainRepo;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createLinkMembershipsRouter(
  deps: LinkMembershipsRouterDeps,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/link-memberships
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const linkIdQ = req.query['linkId'];
      const asOfDateQ = req.query['asOfDate'];
      const linkId = typeof linkIdQ === 'string' && linkIdQ !== '' ? linkIdQ : undefined;
      const asOfDate =
        typeof asOfDateQ === 'string' && asOfDateQ !== '' ? asOfDateQ : undefined;
      if (asOfDate !== undefined && !ISO_DATE_RE.test(asOfDate)) {
        throw new BadRequestError('asOfDate must be YYYY-MM-DD');
      }

      const memberships = linkId
        ? await deps.linkMemberships.listByLink(linkId)
        : await deps.linkMemberships.list();

      // Resolve names and (optionally) `positionOnAsOfDate` per row.
      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      const lpsById = indexById(allLps);
      const alpsById = indexById(allAlps);
      const linkCache = new Map<string, Link>();
      const rows: LinkMembershipRow[] = [];
      for (const m of memberships) {
        let positionOnAsOfDate: number | undefined;
        if (asOfDate) {
          let link = linkCache.get(m.linkId);
          if (!link) {
            const fetched = await deps.links.findById(m.linkId, { includeArchived: true });
            if (fetched) {
              link = fetched;
              linkCache.set(m.linkId, fetched);
            }
          }
          if (link) {
            positionOnAsOfDate = positionOnDate(link, m, asOfDate);
          }
        }
        rows.push(membershipToRow(m, lpsById, alpsById, positionOnAsOfDate));
      }
      // Stable order: by anchorDate desc, then createdAt asc.
      rows.sort((a, b) => {
        if (a.anchorDate !== b.anchorDate) return a.anchorDate < b.anchorDate ? 1 : -1;
        return a.createdAt < b.createdAt ? -1 : 1;
      });
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/link-memberships
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = LinkMembershipCreateInput.parse(req.body);

      const link = await deps.links.findById(input.linkId);
      if (!link) throw new NotFoundError('LINK', input.linkId);

      assertCompatibleRole(link, input.crewRole);
      assertAnchorWithinCycle(link, input.anchorPositionNumber);
      await assertCrewExists(deps, input.crewId, input.crewRole);
      await assertCrewEligibleForLink(deps, link, input.crewId, input.crewRole);

      // One active membership per crew member.
      const existing = await deps.linkMemberships.findActiveByCrew(input.crewId);
      if (existing) {
        throw new ConflictError('CREW_ALREADY_ON_LINK', {
          crewId: input.crewId,
          existingMembershipId: existing.id,
        });
      }

      const created = await deps.linkMemberships.create({
        linkId: input.linkId,
        crewId: input.crewId,
        crewRole: input.crewRole,
        anchorDate: input.anchorDate,
        anchorPositionNumber: input.anchorPositionNumber,
      });

      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      res
        .status(201)
        .json(membershipToRow(created, indexById(allLps), indexById(allAlps)));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/link-memberships/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = LinkMembershipUpdateInput.parse(req.body);

      const current = await deps.linkMemberships.findById(id);
      if (!current) throw new NotFoundError('LINK_MEMBERSHIP', id);

      const nextCrewId = patch.crewId ?? current.crewId;
      const nextCrewRole = patch.crewRole ?? current.crewRole;
      const nextAnchorPosition = patch.anchorPositionNumber ?? current.anchorPositionNumber;

      const link = await deps.links.findById(current.linkId, { includeArchived: true });
      if (!link) throw new NotFoundError('LINK', current.linkId);

      assertCompatibleRole(link, nextCrewRole);
      assertAnchorWithinCycle(link, nextAnchorPosition);
      if (patch.crewId !== undefined || patch.crewRole !== undefined) {
        await assertCrewExists(deps, nextCrewId, nextCrewRole);
        await assertCrewEligibleForLink(deps, link, nextCrewId, nextCrewRole);
      }

      const repoPatch: Parameters<LinkMembershipRepo['update']>[1] = {};
      if (patch.crewId !== undefined) repoPatch.crewId = patch.crewId;
      if (patch.crewRole !== undefined) repoPatch.crewRole = patch.crewRole;
      if (patch.anchorDate !== undefined) repoPatch.anchorDate = patch.anchorDate;
      if (patch.anchorPositionNumber !== undefined) {
        repoPatch.anchorPositionNumber = patch.anchorPositionNumber;
      }

      const updated = await deps.linkMemberships.update(id, repoPatch);
      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      res.json(membershipToRow(updated, indexById(allLps), indexById(allAlps)));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/link-memberships/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.linkMemberships.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('LINK_MEMBERSHIP', id);
      await deps.linkMemberships.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function indexById<T extends { id: string; name: string }>(
  entities: T[],
): Map<string, T> {
  const map = new Map<string, T>();
  for (const e of entities) map.set(e.id, e);
  return map;
}

function membershipToRow(
  m: LinkMembership,
  lpsById: ReadonlyMap<string, { name: string }>,
  alpsById: ReadonlyMap<string, { name: string }>,
  positionOnAsOfDate?: number,
): LinkMembershipRow {
  const source = m.crewRole === 'LP' ? lpsById : alpsById;
  const crewName = source.get(m.crewId)?.name ?? '(unknown)';
  const row: LinkMembershipRow = {
    id: m.id,
    linkId: m.linkId,
    crewId: m.crewId,
    crewRole: m.crewRole,
    crewName,
    anchorDate: m.anchorDate,
    anchorPositionNumber: m.anchorPositionNumber,
    createdAt: m.createdAt.toISOString(),
  };
  if (positionOnAsOfDate !== undefined) row.positionOnAsOfDate = positionOnAsOfDate;
  return row;
}

function assertCompatibleRole(link: Link, crewRole: CrewRole): void {
  if (link.crewRole !== crewRole) {
    throw new BadRequestError(
      `crewRole ${crewRole} is incompatible with link.crewRole ${link.crewRole}`,
    );
  }
}

function assertAnchorWithinCycle(link: Link, anchorPositionNumber: number): void {
  if (anchorPositionNumber < 1 || anchorPositionNumber > link.cycleLength) {
    throw new BadRequestError(
      `anchorPositionNumber must be in [1..${link.cycleLength}] (got ${anchorPositionNumber})`,
    );
  }
}

async function assertCrewExists(
  deps: LinkMembershipsRouterDeps,
  crewId: string,
  crewRole: CrewRole,
): Promise<void> {
  if (crewRole === 'LP') {
    const lp = await deps.lps.findById(crewId);
    if (!lp) throw new NotFoundError('LP', crewId);
    return;
  }
  const alp = await deps.alps.findById(crewId);
  if (!alp) throw new NotFoundError('ALP', crewId);
}

// Crew must be certified for every train type this link can route them
// through. Position rotation means every member eventually drives every
// position, so the eligibility check is link-wide, not anchor-local. The
// orchestrator already rejects mismatched picks at draft time — catching
// it here prevents the bad membership in the first place.
async function assertCrewEligibleForLink(
  deps: LinkMembershipsRouterDeps,
  link: Link,
  crewId: string,
  crewRole: CrewRole,
): Promise<void> {
  const trainNumbers = new Set<string>();
  for (const p of link.positions) {
    if (p.kind !== 'DUTY') continue;
    for (const s of p.segments) trainNumbers.add(s.trainNumber);
  }
  if (trainNumbers.size === 0) return;

  const requiredTypes = new Set<TrainType>();
  for (const num of trainNumbers) {
    const train = await deps.trains.findByNumber(num);
    if (train) requiredTypes.add(train.type);
  }
  if (requiredTypes.size === 0) return;

  const crew = crewRole === 'LP'
    ? await deps.lps.findById(crewId)
    : await deps.alps.findById(crewId);
  if (!crew) return; // assertCrewExists already covered this path

  const eligible = new Set(crew.eligibleTrainTypes);
  const missing: TrainType[] = [];
  for (const t of requiredTypes) {
    if (!eligible.has(t)) missing.push(t);
  }
  if (missing.length === 0) return;

  throw new ConflictError('CREW_NOT_ELIGIBLE_FOR_LINK', {
    crewId,
    crewRole,
    linkId: link.id,
    linkName: link.name,
    missingTypes: missing,
  });
}

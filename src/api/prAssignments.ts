// `/api/pr-assignments` router.
//
// One PR slot exists for every PR-kind position on every active link. The
// default crew comes from the standard Links projection (someone whose
// rotation lands on that PR position for the day). The operator can
// override the default with a different crew, or explicitly clear it
// ("no PR today"). Overrides live in `data/pr_assignments.csv` and are
// keyed by `(linkId, positionNumber, runDate)`.
//
// Routes:
//   GET    /api/pr-assignments?date=YYYY-MM-DD                 -> PrAssignmentRow[]
//   PUT    /api/pr-assignments                                 -> PrAssignmentRow (upsert)
//   DELETE /api/pr-assignments?linkId=...&positionNumber=...&runDate=...  -> 204

import { Router } from 'express';
import {
  AssistantLocoPilotRepo,
  LinkMembershipRepo,
  LinkRepo,
  LocoPilotRepo,
  PrAssignmentRepo,
} from '../domain/repositories';
import { LinkPositionKind, LinkPosition } from '../domain/types';
import { resolvePositionForRun } from '../domain/linkSchedule';
import {
  DateQuery,
  PrAssignmentDeleteInput,
  PrAssignmentRow,
  PrAssignmentUpsertInput,
} from '../shared/schemas';
import { BadRequestError, asyncHandler } from './errorMiddleware';

export interface PrAssignmentsRouterDeps {
  prAssignments: PrAssignmentRepo;
  links: LinkRepo;
  linkMemberships: LinkMembershipRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
}

export function createPrAssignmentsRouter(
  deps: PrAssignmentsRouterDeps,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/pr-assignments?date=YYYY-MM-DD
  //
  // Enumerates every PR slot on every active link for `date`, joining each
  // with its rotation-default crew and any per-day override.
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);

      const [links, memberships, overrides, allLps, allAlps] =
        await Promise.all([
          deps.links.list(),
          deps.linkMemberships.list(),
          deps.prAssignments.list({ runDate: date }),
          deps.lps.list({ includeArchived: true }),
          deps.alps.list({ includeArchived: true }),
        ]);

      const lpsById = new Map(allLps.map((c) => [c.id, c] as const));
      const alpsById = new Map(allAlps.map((c) => [c.id, c] as const));
      const overrideByKey = new Map(
        overrides.map(
          (o) =>
            [
              prKey(o.linkId, o.positionNumber),
              o,
            ] as const,
        ),
      );

      // For every link, resolve which member's rotation sits on each PR
      // position on `date`. Pre-bucket memberships by linkId so the lookup
      // is O(members per link) and not O(memberships * positions).
      const membersByLink = new Map<string, typeof memberships>();
      for (const m of memberships) {
        const bucket = membersByLink.get(m.linkId);
        if (bucket) bucket.push(m);
        else membersByLink.set(m.linkId, [m]);
      }

      const rows: PrAssignmentRow[] = [];

      for (const link of links) {
        const prPositions = link.positions.filter(
          (p): p is Extract<LinkPosition, { kind: LinkPositionKind.PR }> =>
            p.kind === LinkPositionKind.PR,
        );
        if (prPositions.length === 0) continue;

        // For each PR position, find the member whose rotation lands here
        // on `date`. We compute every member's position once per link.
        const linkMembers = membersByLink.get(link.id) ?? [];
        const memberPositionByPositionNumber = new Map<
          number,
          { crewId: string; crewRole: 'LP' | 'ALP' }
        >();
        for (const m of linkMembers) {
          const { positionNumber } = resolvePositionForRun(link, m, date);
          // The first member resolved at a given position wins. A correct
          // roster has at most one member per position; this guard makes
          // the surface predictable if the data is inconsistent.
          if (!memberPositionByPositionNumber.has(positionNumber)) {
            memberPositionByPositionNumber.set(positionNumber, {
              crewId: m.crewId,
              crewRole: m.crewRole,
            });
          }
        }

        for (const pos of prPositions) {
          const member = memberPositionByPositionNumber.get(pos.positionNumber);
          const defaultCrew = member
            ? resolveCrewName(member.crewId, member.crewRole, lpsById, alpsById)
            : null;
          const crewRole: 'LP' | 'ALP' = member?.crewRole ?? link.crewRole;

          const override = overrideByKey.get(
            prKey(link.id, pos.positionNumber),
          );
          const overrideOut = override
            ? {
                id: override.id,
                crewId: override.crewId,
                crewName: override.crewId
                  ? resolveCrewName(
                      override.crewId,
                      override.crewRole,
                      lpsById,
                      alpsById,
                    )?.name ?? '(unknown)'
                  : '',
                updatedAt: override.updatedAt.toISOString(),
              }
            : null;

          const resolvedCrew = (() => {
            if (override) {
              if (!override.crewId) return null; // explicit "no PR today"
              const name = overrideOut!.crewName;
              return { id: override.crewId, name };
            }
            return defaultCrew;
          })();

          rows.push({
            linkId: link.id,
            linkName: link.name,
            positionNumber: pos.positionNumber,
            runDate: date,
            crewRole,
            defaultCrew,
            override: overrideOut,
            resolvedCrew,
          });
        }
      }

      rows.sort((a, b) => {
        if (a.linkName !== b.linkName) return a.linkName < b.linkName ? -1 : 1;
        return a.positionNumber - b.positionNumber;
      });

      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/pr-assignments — upsert one override.
  // -------------------------------------------------------------------------
  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const input = PrAssignmentUpsertInput.parse(req.body);

      // Validate the slot actually exists and is a PR position on the link.
      const link = await deps.links.findById(input.linkId, {
        includeArchived: true,
      });
      if (!link) {
        throw new BadRequestError('linkId does not exist', {
          linkId: input.linkId,
        });
      }
      const pos: LinkPosition | undefined = link.positions.find(
        (p) => p.positionNumber === input.positionNumber,
      );
      if (!pos) {
        throw new BadRequestError('positionNumber not found on link', {
          linkId: input.linkId,
          positionNumber: input.positionNumber,
        });
      }
      if (pos.kind !== LinkPositionKind.PR) {
        throw new BadRequestError('position is not a PR slot', {
          linkId: input.linkId,
          positionNumber: input.positionNumber,
          kind: pos.kind,
        });
      }
      if (input.crewRole !== link.crewRole) {
        throw new BadRequestError(
          'crewRole must match link.crewRole',
          { linkRole: link.crewRole, inputRole: input.crewRole },
        );
      }

      // If crewId is set, make sure the referenced crew actually exists.
      if (input.crewId) {
        const exists =
          input.crewRole === 'LP'
            ? await deps.lps.findById(input.crewId, { includeArchived: true })
            : await deps.alps.findById(input.crewId, { includeArchived: true });
        if (!exists) {
          throw new BadRequestError('crewId does not exist', {
            crewId: input.crewId,
            crewRole: input.crewRole,
          });
        }
      }

      const saved = await deps.prAssignments.upsert({
        linkId: input.linkId,
        positionNumber: input.positionNumber,
        runDate: input.runDate,
        crewRole: input.crewRole,
        crewId: input.crewId,
      });

      // Echo back the enriched row by re-running the per-slot projection
      // for just this slot. Cheaper than calling the list handler.
      const [allLps, allAlps, memberships] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
        deps.linkMemberships.list(),
      ]);
      const lpsById = new Map(allLps.map((c) => [c.id, c] as const));
      const alpsById = new Map(allAlps.map((c) => [c.id, c] as const));
      const linkMembers = memberships.filter((m) => m.linkId === link.id);
      let defaultCrew: { id: string; name: string } | null = null;
      let defaultRole: 'LP' | 'ALP' = link.crewRole;
      for (const m of linkMembers) {
        const { positionNumber } = resolvePositionForRun(link, m, input.runDate);
        if (positionNumber === input.positionNumber) {
          defaultRole = m.crewRole;
          defaultCrew = resolveCrewName(m.crewId, m.crewRole, lpsById, alpsById);
          break;
        }
      }
      const overrideCrewName = saved.crewId
        ? resolveCrewName(saved.crewId, saved.crewRole, lpsById, alpsById)?.name ?? '(unknown)'
        : '';
      const resolvedCrew = saved.crewId
        ? { id: saved.crewId, name: overrideCrewName }
        : null;
      const row: PrAssignmentRow = {
        linkId: link.id,
        linkName: link.name,
        positionNumber: input.positionNumber,
        runDate: input.runDate,
        crewRole: defaultRole,
        defaultCrew,
        override: {
          id: saved.id,
          crewId: saved.crewId,
          crewName: overrideCrewName,
          updatedAt: saved.updatedAt.toISOString(),
        },
        resolvedCrew,
      };
      res.status(200).json(row);
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/pr-assignments?linkId=&positionNumber=&runDate=
  //
  // Removes the override entirely; the projection default applies again.
  // -------------------------------------------------------------------------
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const input = PrAssignmentDeleteInput.parse(req.query);
      await deps.prAssignments.deleteByKey(
        input.linkId,
        input.positionNumber,
        input.runDate,
      );
      res.status(204).end();
    }),
  );

  return router;
}

function prKey(linkId: string, positionNumber: number): string {
  return `${linkId}#${positionNumber}`;
}

function resolveCrewName(
  crewId: string,
  crewRole: 'LP' | 'ALP',
  lpsById: ReadonlyMap<string, { id: string; name: string }>,
  alpsById: ReadonlyMap<string, { id: string; name: string }>,
): { id: string; name: string } | null {
  const found = crewRole === 'LP' ? lpsById.get(crewId) : alpsById.get(crewId);
  if (!found) return null;
  return { id: found.id, name: found.name };
}

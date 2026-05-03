// `/api/loco-pilots` router (components.md §11).
//
// Routes:
//   GET    /api/loco-pilots?date=YYYY-MM-DD   → CrewRow[]   (kind: 'LP')
//   POST   /api/loco-pilots                   → LocoPilot
//   PUT    /api/loco-pilots/:id               → LocoPilot
//                  body may include `lastSignOffTime` (HLD §4.7 manual override)
//   POST   /api/loco-pilots/:id/archive       → 204
//
// The `?date=` query is required for GET so the rest projection can be anchored
// to the start of the IST day the operator selected (design.md §9.2).

import { Router } from 'express';
import { LocoPilotRepo } from '../domain/repositories';
import {
  DateQuery,
  LocoPilotCreateInput,
  LocoPilotUpdateInput,
} from '../shared/schemas';
import { startOfDayIstAsUtc } from '../shared/time';
import {
  asyncHandler,
  NotFoundError,
  requireParam,
} from './errorMiddleware';
import { lpToCrewRow } from './projection';

export interface LocoPilotsRouterDeps {
  lps: LocoPilotRepo;
}

export function createLocoPilotsRouter(deps: LocoPilotsRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/loco-pilots?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      const restAnchor = startOfDayIstAsUtc(date);
      const all = await deps.lps.list();
      const rows = all
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((lp) => lpToCrewRow(lp, restAnchor));
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/loco-pilots
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = LocoPilotCreateInput.parse(req.body);
      // `eligibleTrainTypes` exclusion of PASSENGER/MAIL_EXPRESS is enforced by
      // both the Zod schema (defence-in-depth) and the repo loader.
      const created = await deps.lps.create(input);
      res.status(201).json(serialize(created));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/loco-pilots/:id
  // -------------------------------------------------------------------------
  // Accepts a `lastSignOffTime` override per HLD §4.7. The schema allows
  // `null` to clear it back to "never signed off" — useful for crew
  // re-onboarding scenarios.
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = LocoPilotUpdateInput.parse(req.body);

      const current = await deps.lps.findById(id);
      if (!current) throw new NotFoundError('LP', id);

      // Translate the wire-level `null` into the domain-level `undefined`,
      // which the repo treats as "clear the optional field". Distinguishing
      // null vs absent matters here — absent means "don't touch".
      const { lastSignOffTime, ...rest } = patch;
      const repoPatch: Parameters<LocoPilotRepo['update']>[1] = { ...rest };
      if (lastSignOffTime === null) {
        repoPatch.lastSignOffTime = undefined;
      } else if (lastSignOffTime !== undefined) {
        repoPatch.lastSignOffTime = lastSignOffTime;
      }

      const updated = await deps.lps.update(id, repoPatch);
      res.json(serialize(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/loco-pilots/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.lps.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('LP', id);
      await deps.lps.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Wire-form for create/update responses — dates as ISO strings, optional
 * fields preserved. The CrewRow projection is *only* used by GET; for
 * mutations the SPA refetches anyway.
 */
function serialize(lp: import('../domain/types').LocoPilot) {
  return {
    id: lp.id,
    name: lp.name,
    category: lp.category,
    eligibleTrainTypes: lp.eligibleTrainTypes,
    lastSignOffTime: lp.lastSignOffTime?.toISOString(),
    archivedAt: lp.archivedAt?.toISOString(),
  };
}

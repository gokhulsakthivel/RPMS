// `/api/assistant-loco-pilots` router (components.md §11).
//
// Routes:
//   GET    /api/assistant-loco-pilots?date=YYYY-MM-DD   → CrewRow[]   (kind: 'ALP')
//   POST   /api/assistant-loco-pilots                   → AssistantLocoPilot
//   PUT    /api/assistant-loco-pilots/:id               → AssistantLocoPilot
//                  body may include `lastSignOffTime` (HLD §4.7 manual override)
//   POST   /api/assistant-loco-pilots/:id/archive       → 204
//
// Mirror of `/api/loco-pilots`; the only structural differences are no
// `category` field and the eligibleTrainTypes exclusion of MEMU/DEMU
// (enforced by the Zod schema and the repo loader).

import { Router } from 'express';
import { AssistantLocoPilotRepo } from '../domain/repositories';
import {
  AlpCreateInput,
  AlpUpdateInput,
  DateQuery,
} from '../shared/schemas';
import { startOfDayIstAsUtc } from '../shared/time';
import {
  asyncHandler,
  NotFoundError,
  requireParam,
} from './errorMiddleware';
import { alpToCrewRow } from './projection';

export interface AssistantLocoPilotsRouterDeps {
  alps: AssistantLocoPilotRepo;
}

export function createAssistantLocoPilotsRouter(
  deps: AssistantLocoPilotsRouterDeps,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/assistant-loco-pilots?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      const restAnchor = startOfDayIstAsUtc(date);
      const all = await deps.alps.list();
      const rows = all
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((alp) => alpToCrewRow(alp, restAnchor));
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assistant-loco-pilots
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = AlpCreateInput.parse(req.body);
      const created = await deps.alps.create(input);
      res.status(201).json(serialize(created));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/assistant-loco-pilots/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = AlpUpdateInput.parse(req.body);

      const current = await deps.alps.findById(id);
      if (!current) throw new NotFoundError('ALP', id);

      // Same null-vs-absent translation as the LP route — `null` clears the
      // override, omission leaves it untouched.
      const { lastSignOffTime, ...rest } = patch;
      const repoPatch: Parameters<AssistantLocoPilotRepo['update']>[1] = { ...rest };
      if (lastSignOffTime === null) {
        repoPatch.lastSignOffTime = undefined;
      } else if (lastSignOffTime !== undefined) {
        repoPatch.lastSignOffTime = lastSignOffTime;
      }

      const updated = await deps.alps.update(id, repoPatch);
      res.json(serialize(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assistant-loco-pilots/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.alps.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('ALP', id);
      await deps.alps.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function serialize(alp: import('../domain/types').AssistantLocoPilot) {
  return {
    id: alp.id,
    name: alp.name,
    eligibleTrainTypes: alp.eligibleTrainTypes,
    lastSignOffTime: alp.lastSignOffTime?.toISOString(),
    archivedAt: alp.archivedAt?.toISOString(),
  };
}

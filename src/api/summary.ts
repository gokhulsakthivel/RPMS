// `/api/summary` router — feeds the StatCard strip (design.md §9.4).
//
// Route:
//   GET    /api/summary?date=YYYY-MM-DD     → SummaryResponse
//
// All numbers come from the application-layer `buildSummary`, which scopes
// trains and assignments to the given IST calendar day and tallies crew rest
// against the start of that day.

import { Router } from 'express';
import { buildSummary } from '../application/buildSummary';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { DateQuery } from '../shared/schemas';
import { asyncHandler } from './errorMiddleware';

export interface SummaryRouterDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

export function createSummaryRouter(deps: SummaryRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      const summary = await buildSummary(deps, date);
      res.json(summary);
    }),
  );

  return router;
}

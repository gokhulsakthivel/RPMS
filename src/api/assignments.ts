// `/api/assignments` and `/api/eligible-crew` routers.
//
// Routes (components.md §11):
//   GET    /api/assignments?date=YYYY-MM-DD            → AssignmentRow[]
//   POST   /api/assignments                            → Assignment | rule error 422
//   POST   /api/assignments/:id/archive                → 204
//   GET    /api/eligible-crew?trainId=...&runDate=...  → EligibleCrewResponse
//
// All rule decisions are delegated to the application layer:
//   - `assignCrew(...)` for the create flow
//   - `listCrewForAssignment(...)` for the modal dropdown
//
// The router is responsible only for: input validation, repo wiring, and
// translating outputs into wire shapes (via `projection.ts`).
//
// M9 — assignments are keyed by `(trainId, runDate)`. The list endpoint
// filters by IST day-of-week (trains running on `date`) and matches active
// assignments by `runDate === date`.

import { Router } from 'express';
import { assignCrew } from '../application/assignCrew';
import {
  CrewForAssignmentResult,
  FilteredOutReason,
  listCrewForAssignment,
} from '../application/listCrewForAssignment';
import { requiresAlp } from '../domain/requiresAlp';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { istDayOfWeek, materializeRun, trainRunsOn } from '../domain/runSchedule';
import {
  Assignment,
  AssistantLocoPilot,
  LocoPilot,
} from '../domain/types';
import {
  AssignCrewInput,
  DateQuery,
  EligibleCrewResponse,
  HiddenCount,
  LpSummary,
  TrainIdQuery,
} from '../shared/schemas';
import {
  asyncHandler,
  NotFoundError,
  requireParam,
  sendRuleError,
} from './errorMiddleware';
import {
  alpToSummary,
  assignmentRowForTrain,
  lpToSummary,
  trainToRow,
} from './projection';

export interface AssignmentsRouterDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

export function createAssignmentsRouter(deps: AssignmentsRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/assignments?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  // One row per *train running on the IST day*, with the active LP/ALP
  // for that run-date inlined per `AssignmentRow` (components.md §10).
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);

      const allTrains = await deps.trains.list();
      const trainsToday = allTrains.filter((t) => trainRunsOn(t, date));

      const allAssignments = await deps.assignments.list();
      const dayAssignments = allAssignments.filter(
        (a) => a.runDate === date,
      );
      const assignmentsByTrainId = bucketByTrainId(dayAssignments);

      const [allLps, allAlps] = await Promise.all([
        deps.lps.list(),
        deps.alps.list(),
      ]);
      const lpsById = indexById(allLps);
      const alpsById = indexById(allAlps);

      const rows = trainsToday
        .map((t) => ({ train: t, run: materializeRun(t, date) }))
        .sort(
          (a, b) =>
            a.run.departureTimeUtc.getTime() - b.run.departureTimeUtc.getTime(),
        )
        .map(({ train, run }) =>
          assignmentRowForTrain(
            train,
            date,
            run,
            assignmentsByTrainId.get(train.id) ?? [],
            lpsById,
            alpsById,
          ),
        );

      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assignments
  // -------------------------------------------------------------------------
  // The orchestrator returns `Result<Assignment, AssignmentError>`. We map
  // the failure case to HTTP 422 with the structured `{ code, ...ctx }` body
  // (LLD §4) and leave 5xx for unexpected exceptions.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = AssignCrewInput.parse(req.body);

      // Pre-check entity existence so a typo'd id surfaces as a clean 404.
      // The orchestrator THROWS for missing rows (see comment in assignCrew.ts
      // step 0) — that path remains for the "should-never-happen" case where
      // a row vanishes between this check and the orchestrator call.
      const [train, lp, alpEntity] = await Promise.all([
        deps.trains.findById(input.trainId, { includeArchived: true }),
        deps.lps.findById(input.lpId, { includeArchived: true }),
        input.alpId
          ? deps.alps.findById(input.alpId, { includeArchived: true })
          : Promise.resolve(null),
      ]);
      if (!train) throw new NotFoundError('TRAIN', input.trainId);
      if (!lp) throw new NotFoundError('LP', input.lpId);
      if (input.alpId && !alpEntity) throw new NotFoundError('ALP', input.alpId);

      const result = await assignCrew(deps, input);
      if (!result.ok) {
        sendRuleError(res, result.error);
        return;
      }
      res.status(201).json(serializeAssignment(result.value));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assignments/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      // No findById on AssignmentRepo — `archive` will throw if missing,
      // which the error middleware turns into a 500. We do a defensive
      // existence check via list+filter so the operator gets a clean 404.
      const all = await deps.assignments.list({ includeArchived: true });
      if (!all.some((a) => a.id === id)) {
        throw new NotFoundError('ASSIGNMENT', id);
      }
      await deps.assignments.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// /api/eligible-crew (mounted separately — see server.ts)
// ---------------------------------------------------------------------------

export function createEligibleCrewRouter(deps: AssignmentsRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { trainId, runDate } = TrainIdQuery.parse(req.query);

      const train = await deps.trains.findById(trainId);
      if (!train) throw new NotFoundError('TRAIN', trainId);

      // Surface a structured rule error if the operator picked a date the
      // train doesn't run on — same code the orchestrator emits, so the SPA
      // can use one error mapping for both flows.
      if (!trainRunsOn(train, runDate)) {
        sendRuleError(res, {
          code: 'TRAIN_DOES_NOT_RUN_ON_DAY',
          trainId: train.id,
          runDate,
          dayOfWeek: istDayOfWeek(runDate),
        });
        return;
      }

      const run = materializeRun(train, runDate);
      const filtered = await listCrewForAssignment(deps, trainId, runDate);

      // The application layer returned IDs in the filteredOut buckets — we
      // resolve those to LpSummary objects so the SPA can show "John D. (LP)"
      // in the footnote without an extra fetch. We also need names from the
      // repos to upgrade `eligible: CrewOption[]` → `eligible: LpSummary[]`
      // (Summary carries grade; CrewOption only id+name).
      const [allLps, allAlps] = await Promise.all([
        deps.lps.list(),
        deps.alps.list(),
      ]);
      const lpsById = indexById(allLps);
      const alpsById = indexById(allAlps);

      const eligibleLpSummaries: LpSummary[] = filtered.eligibleLps
        .map((c) => lpsById.get(c.id))
        .filter((lp): lp is LocoPilot => !!lp)
        .map(lpToSummary);

      const eligibleAlpSummaries: LpSummary[] = filtered.eligibleAlps
        .map((c) => alpsById.get(c.id))
        .filter((alp): alp is AssistantLocoPilot => !!alp)
        .map(alpToSummary);

      const response: EligibleCrewResponse = {
        train: trainToRow(train, runDate, run),
        loco_pilots: {
          eligible: eligibleLpSummaries,
          hidden: bucketsToHiddenCount(filtered.filteredOutLps),
        },
        assistant_loco_pilots: requiresAlp(train.type)
          ? {
              eligible: eligibleAlpSummaries,
              hidden: bucketsToHiddenCount(filtered.filteredOutAlps),
            }
          : null,
      };

      res.json(response);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bucketByTrainId(assignments: Assignment[]): Map<string, Assignment[]> {
  const out = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const list = out.get(a.trainId) ?? [];
    list.push(a);
    out.set(a.trainId, list);
  }
  return out;
}

function indexById<T extends { id: string }>(entities: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const e of entities) out.set(e.id, e);
  return out;
}

function bucketsToHiddenCount(
  buckets: CrewForAssignmentResult['filteredOutLps'],
): HiddenCount {
  const counts: HiddenCount = { notEligible: 0, resting: 0, alreadyAssigned: 0 };
  for (const b of buckets) {
    const reason: FilteredOutReason = b.reason;
    switch (reason) {
      case 'not_eligible':
        counts.notEligible = b.crewIds.length;
        break;
      case 'still_resting':
        counts.resting = b.crewIds.length;
        break;
      case 'already_assigned':
        counts.alreadyAssigned = b.crewIds.length;
        break;
      // No default — exhaustive on `FilteredOutReason`.
    }
  }
  return counts;
}

function serializeAssignment(a: Assignment) {
  return {
    id: a.id,
    trainId: a.trainId,
    runDate: a.runDate,
    lpId: a.lpId,
    alpId: a.alpId,
    departureTime: a.departureTime.toISOString(),
    signOffTime: a.signOffTime.toISOString(),
    createdAt: a.createdAt.toISOString(),
    archivedAt: a.archivedAt?.toISOString(),
  };
}

// `/api/trains` router.
//
// Routes (components.md §11):
//   GET    /api/trains?date=YYYY-MM-DD     → TrainWithAssignment[]
//   POST   /api/trains                     → TrainRow         (Zod-validated body)
//   PUT    /api/trains/:id                 → TrainRow         (Zod-validated body)
//   POST   /api/trains/:id/archive         → 204
//
// The list response is the **enriched** Trains tab row (`TrainWithAssignment`)
// because design.md §9.1 mandates inline "currently assigned crew" cells —
// the SPA never refetches per row.
//
// M9 — trains carry a recurring weekly schedule. The list endpoint filters
// by IST day-of-week and materializes each train's UTC departure / sign-off
// for the selected `runDate`. The single-train POST/PUT paths return a row
// that is materialized against today's IST date (best-effort preview), but
// the SPA refetches via the list endpoint after a successful mutation so
// the per-date row shape is always authoritative.

import { Router } from 'express';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { materializeRun, trainRunsOn } from '../domain/runSchedule';
import { Assignment, Train } from '../domain/types';
import {
  DateQuery,
  TrainCreateInput,
  TrainUpdateInput,
} from '../shared/schemas';
import {
  asyncHandler,
  ConflictError,
  NotFoundError,
  requireParam,
} from './errorMiddleware';
import {
  trainToRow,
  trainWithAssignment,
} from './projection';

export interface TrainsRouterDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

export function createTrainsRouter(deps: TrainsRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/trains?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  // Returns active trains whose `runsOnDays` includes the IST day-of-week
  // of `date`, each enriched with the **currently active** assigned LP/ALP
  // for that specific run-date.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);

      const allTrains = await deps.trains.list();
      const trainsToday = allTrains.filter((t) => trainRunsOn(t, date));

      // Pre-load the assignments for this run-date and bucket by trainId so
      // each row is a constant-time map lookup. We also load every active
      // LP / ALP up front (cheap — workforce is small) so the projection
      // helper can resolve names without per-row I/O.
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
          trainWithAssignment(
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
  // POST /api/trains
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = TrainCreateInput.parse(req.body);

      // Train number is unique forever (LLD §6) — collision check looks at
      // archived rows too. We surface this as a 409 Conflict so the operator
      // can correct the form rather than seeing a 500.
      const existing = await deps.trains.findByNumber(input.number, {
        includeArchived: true,
      });
      if (existing) {
        throw new ConflictError('TRAIN_NUMBER_TAKEN', {
          number: input.number,
          existingId: existing.id,
          archived: !!existing.archivedAt,
        });
      }

      const created = await deps.trains.create(input);
      res.status(201).json(toPreviewRow(created));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/trains/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = TrainUpdateInput.parse(req.body);

      const current = await deps.trains.findById(id);
      if (!current) throw new NotFoundError('TRAIN', id);

      // If the patch attempts to change `number`, perform the same uniqueness
      // check as create. Skip when unchanged so the same edit is idempotent.
      if (patch.number !== undefined && patch.number !== current.number) {
        const collision = await deps.trains.findByNumber(patch.number, {
          includeArchived: true,
        });
        if (collision && collision.id !== id) {
          throw new ConflictError('TRAIN_NUMBER_TAKEN', {
            number: patch.number,
            existingId: collision.id,
            archived: !!collision.archivedAt,
          });
        }
      }

      const updated = await deps.trains.update(id, patch);
      res.json(toPreviewRow(updated));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/trains/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.trains.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('TRAIN', id);
      // Archive is idempotent in the repo — calling it twice is a no-op.
      await deps.trains.archive(id);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers — module-private
// ---------------------------------------------------------------------------

/**
 * The single-train preview returned by POST/PUT. We pick the next IST date
 * on which the train actually runs (or today, if it runs today) so the
 * preview row carries a coherent materialized window. The SPA refetches the
 * list after each mutation, so this preview is best-effort, not canonical.
 */
function toPreviewRow(t: Train) {
  const runDate = nextRunDateIst(t);
  const run = materializeRun(t, runDate);
  return trainToRow(t, runDate, run);
}

function nextRunDateIst(t: Train): string {
  // Use the IST day boundary indirectly: take "now" in UTC, round to that
  // day's IST date string, then walk forward up to 7 days until we hit one
  // of the train's `runsOnDays`. The short walk avoids any DST-style edge
  // case (IST has none, but the algorithm is robust regardless).
  const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  let cursor = todayIst;
  for (let i = 0; i < 7; i++) {
    if (trainRunsOn(t, cursor)) return cursor;
    cursor = addDaysIso(cursor, 1);
  }
  // Should be unreachable: schema guarantees `runsOnDays.length >= 1`.
  return todayIst;
}

function addDaysIso(isoDate: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`addDaysIso: bad isoDate ${JSON.stringify(isoDate)}`);
  const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(utcMs + days * 24 * 60 * 60 * 1000);
  const y = next.getUTCFullYear();
  const mo = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

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

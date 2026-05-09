// `/api/crew-diary` router — per-crew month-wise assignment listing.
//
// Powers the Crew Diary tab (design.md §9.6). The operator picks one crew
// member and a month; the server returns every active assignment that
// crew member held in that month, with train identity inlined so the
// table renders without a join.
//
// Routes:
//   GET /api/crew-diary?crewId=...&month=YYYY-MM
//     → CrewDiaryResponse
//
// Layering: this is a pure projection endpoint — no domain rules apply
// (we are just reading what already happened). The router fans out to
// `assignments.listByCrew` and resolves each to its train via
// `trains.findById({ includeArchived: true })` so a run on a now-archived
// train still renders. Archived assignments are excluded by default
// because a cancelled run was never actually worked.
//
// Drafts are excluded by construction: this endpoint reads from the
// committed-assignments repo (`AssignmentRepo`), never from the separate
// `CsvAssignmentDraftRepo`. There is no path by which an in-progress
// draft could leak into a diary row.

import { Router } from 'express';
import {
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { Assignment, Train, TrainType } from '../domain/types';
import {
  CrewDiaryEntry,
  CrewDiaryPerson,
  CrewDiaryQuery,
  CrewDiaryResponse,
} from '../shared/schemas';
import { asyncHandler, NotFoundError } from './errorMiddleware';

export interface CrewDiaryRouterDeps {
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
}

export function createCrewDiaryRouter(deps: CrewDiaryRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/crew-diary?crewId=...&month=YYYY-MM
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { crewId, month } = CrewDiaryQuery.parse(req.query);

      // Resolve crew identity. We probe LP first then ALP — ids are
      // disjoint per LLD §6 so at most one can match. `includeArchived`
      // is true on lookup so a tab pointed at a since-archived crew
      // member still renders their historical runs (the Crew Diary tab is
      // primarily a backwards-looking view).
      const crew = await resolveCrew(deps, crewId);
      if (!crew) throw new NotFoundError('LP', crewId);

      // Active assignments only — a cancelled run was never worked.
      const all = await deps.assignments.listByCrew(crew.id);
      const inMonth = all
        .filter((a) => a.runDate.startsWith(`${month}-`))
        .sort(
          (a, b) =>
            a.departureTime.getTime() - b.departureTime.getTime(),
        );

      // Batch-load trains so the join is one read per train, not per row.
      // Some assignments may reference an archived train (the LP genuinely
      // ran it before the train was retired) so we always pass
      // `includeArchived: true`.
      const trainIds = new Set(inMonth.map((a) => a.trainId));
      const trainEntries = await Promise.all(
        Array.from(trainIds).map(async (id) => {
          const t = await deps.trains.findById(id, { includeArchived: true });
          return [id, t] as const;
        }),
      );
      const trainsById = new Map<string, Train>();
      for (const [id, t] of trainEntries) {
        if (t) trainsById.set(id, t);
      }

      const entries: CrewDiaryEntry[] = inMonth.map((a) =>
        toDiaryEntry(a, crew, trainsById),
      );

      const response: CrewDiaryResponse = {
        crew,
        month,
        entries,
      };
      res.json(response);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function resolveCrew(
  deps: CrewDiaryRouterDeps,
  crewId: string,
): Promise<CrewDiaryPerson | null> {
  const lp = await deps.lps.findById(crewId, { includeArchived: true });
  if (lp) return { id: lp.id, name: lp.name, kind: 'LP' };
  const alp = await deps.alps.findById(crewId, { includeArchived: true });
  if (alp) return { id: alp.id, name: alp.name, kind: 'ALP' };
  return null;
}

/**
 * Project one Assignment into the wire row. `servedAs` is derived by
 * comparing the assignment's `lpId` / `alpId` against the requested
 * crew member's id — the same crew member can never be both on the
 * same row (the orchestrator forbids it via window-conflict checks).
 *
 * `fromStation` / `toStation` come from the Train's onward-leg endpoints,
 * matching the operator's mental model: "he signed on at A and signed
 * off at B for that run". When the underlying train was hard-deleted
 * (should never happen, but the CSV is hand-editable) we surface a
 * placeholder so the row remains rendered.
 */
function toDiaryEntry(
  a: Assignment,
  crew: CrewDiaryPerson,
  trainsById: ReadonlyMap<string, Train>,
): CrewDiaryEntry {
  const train = trainsById.get(a.trainId);
  const servedAs: 'LP' | 'ALP' = a.lpId === crew.id ? 'LP' : 'ALP';
  return {
    assignmentId: a.id,
    trainId: a.trainId,
    trainNumber: train?.number ?? '«missing»',
    trainName: train?.name ?? '«missing»',
    trainType: train?.type ?? TrainType.PASSENGER,
    runDate: a.runDate,
    departureTime: a.departureTime.toISOString(),
    signOffTime: a.signOffTime.toISOString(),
    fromStation: train?.onwardFromStation ?? '—',
    toStation: train?.onwardToStation ?? '—',
    servedAs,
  };
}

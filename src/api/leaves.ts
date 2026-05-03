// `/api/leaves` router (HLD §4.4 / design.md §9.5).
//
// Routes:
//   GET    /api/leaves                  → LeaveRow[] (active only)
//   POST   /api/leaves                  → LeaveRow   (Zod-validated body)
//   PUT    /api/leaves/:id              → LeaveRow   (Zod-validated body)
//   POST   /api/leaves/:id/archive      → 204
//
// Leaves are crew-scoped windows that block assignments on any covered
// IST date. The list endpoint is **unfiltered by date** — the operator
// sees the full active register and applies their own filtering in the
// UI. Archived rows are excluded by default; the toggle for showing them
// can be added later via a `?includeArchived` query if required.
//
// The router resolves crew names so the response is self-contained and
// the table never has to join on the client side. Crew identity is
// validated against either the LP or ALP roster depending on `crewRole`.

import { Router } from 'express';
import {
  AssistantLocoPilotRepo,
  LeaveRepo,
  LocoPilotRepo,
} from '../domain/repositories';
import { CrewRole, Leave } from '../domain/types';
import {
  LeaveCreateInput,
  LeaveRow,
  LeaveUpdateInput,
} from '../shared/schemas';
import {
  asyncHandler,
  NotFoundError,
  requireParam,
} from './errorMiddleware';

export interface LeavesRouterDeps {
  leaves: LeaveRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
}

export function createLeavesRouter(deps: LeavesRouterDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/leaves
  // -------------------------------------------------------------------------
  // Returns active leaves sorted by `fromDate` descending so the most
  // recently-relevant windows appear at the top. Crew names are resolved
  // from a single batched lookup per role.
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const all = await deps.leaves.list();
      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      const lpsById = indexById(allLps);
      const alpsById = indexById(allAlps);

      const rows: LeaveRow[] = all
        .slice()
        .sort((a, b) => {
          if (a.fromDate !== b.fromDate) return a.fromDate < b.fromDate ? 1 : -1;
          return a.createdAt.getTime() - b.createdAt.getTime();
        })
        .map((l) => leaveToRow(l, lpsById, alpsById));
      res.json(rows);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/leaves
  // -------------------------------------------------------------------------
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = LeaveCreateInput.parse(req.body);
      // Cross-roster existence check: a SICK leave for a non-existent ALP
      // should never land in the CSV. Reject with 404 so the form can
      // highlight the offending field rather than persisting noise.
      await assertCrewExists(deps, input.crewId, input.crewRole);

      const created = await deps.leaves.create({
        crewId: input.crewId,
        crewRole: input.crewRole,
        type: input.type,
        fromDate: input.fromDate,
        toDate: input.toDate,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      res
        .status(201)
        .json(leaveToRow(created, indexById(allLps), indexById(allAlps)));
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /api/leaves/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const patch = LeaveUpdateInput.parse(req.body);

      const current = await deps.leaves.findById(id);
      if (!current) throw new NotFoundError('LEAVE', id);

      // If the patch reassigns the row to a different crew, validate that
      // the new identity exists in the matching roster. We use the patch's
      // role+id pair when both are present, falling back to the existing
      // values otherwise.
      const nextCrewId = patch.crewId ?? current.crewId;
      const nextCrewRole = patch.crewRole ?? current.crewRole;
      if (patch.crewId !== undefined || patch.crewRole !== undefined) {
        await assertCrewExists(deps, nextCrewId, nextCrewRole);
      }

      // Build the repo patch carefully: empty `reason` from the schema
      // becomes `undefined` (clear the field), which matches `Partial`'s
      // "absent = leave alone" only because we *always* set the key when
      // the operator submitted the form field. The schema transform makes
      // this safe — if the field wasn't on the wire, `patch.reason` is
      // absent and we skip it entirely.
      const repoPatch: Parameters<LeaveRepo['update']>[1] = {};
      if (patch.crewId !== undefined) repoPatch.crewId = patch.crewId;
      if (patch.crewRole !== undefined) repoPatch.crewRole = patch.crewRole;
      if (patch.type !== undefined) repoPatch.type = patch.type;
      if (patch.fromDate !== undefined) repoPatch.fromDate = patch.fromDate;
      if (patch.toDate !== undefined) repoPatch.toDate = patch.toDate;
      if ('reason' in patch) repoPatch.reason = patch.reason;

      const updated = await deps.leaves.update(id, repoPatch);
      const [allLps, allAlps] = await Promise.all([
        deps.lps.list({ includeArchived: true }),
        deps.alps.list({ includeArchived: true }),
      ]);
      res.json(leaveToRow(updated, indexById(allLps), indexById(allAlps)));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/leaves/:id/archive
  // -------------------------------------------------------------------------
  router.post(
    '/:id/archive',
    asyncHandler(async (req, res) => {
      const id = requireParam(req, 'id');
      const current = await deps.leaves.findById(id, { includeArchived: true });
      if (!current) throw new NotFoundError('LEAVE', id);
      await deps.leaves.archive(id);
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

function leaveToRow(
  l: Leave,
  lpsById: ReadonlyMap<string, { name: string }>,
  alpsById: ReadonlyMap<string, { name: string }>,
): LeaveRow {
  const source = l.crewRole === 'LP' ? lpsById : alpsById;
  const crewName = source.get(l.crewId)?.name ?? '(unknown)';
  const row: LeaveRow = {
    id: l.id,
    crewId: l.crewId,
    crewRole: l.crewRole,
    crewName,
    type: l.type,
    fromDate: l.fromDate,
    toDate: l.toDate,
    createdAt: l.createdAt.toISOString(),
  };
  if (l.reason) row.reason = l.reason;
  return row;
}

/**
 * Throws `NotFoundError` when the (`crewId`, `crewRole`) pair does not
 * resolve to a non-archived crew member. Archived crew are also rejected
 * — recording a leave against a retired person is almost certainly a
 * stale form submission. If the operator genuinely wants to log historical
 * leave they can revive the crew first.
 */
async function assertCrewExists(
  deps: LeavesRouterDeps,
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

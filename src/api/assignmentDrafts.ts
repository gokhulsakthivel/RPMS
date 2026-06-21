// `/api/assignment-drafts` router.
//
// The Assignments tab buffers every per-row Assign / Edit / Delete action
// into a server-side draft cart instead of touching the assignments CSV
// directly. Operators (or a second tab, or a second operator) all see the
// same in-flight changes because the cart is the CSV, not browser state.
// The toolbar "+ Assign (N)" button drains the cart by calling this
// router's `commit` endpoint, which delegates each draft to the regular
// orchestrators (`assignCrew`, `updateAssignment`, `archive`).
//
// Routes:
//   GET    /api/assignment-drafts?date=YYYY-MM-DD            → AssignmentDraftRow[]
//   POST   /api/assignment-drafts                            → AssignmentDraftRow (upsert)
//   DELETE /api/assignment-drafts/:trainId?date=YYYY-MM-DD   → 204 (unstage one)
//   DELETE /api/assignment-drafts?date=YYYY-MM-DD            → 204 (reset all)
//   POST   /api/assignment-drafts/commit?date=YYYY-MM-DD     → AssignmentDraftCommitResponse
//
// Layering: the router validates input + maps to the repo. Rule decisions
// for `commit` belong to the orchestrators — the router never inlines
// eligibility/rest/leave checks.

import { Router } from 'express';
import { archiveAssignment } from '../application/archiveAssignment';
import { assignCrew } from '../application/assignCrew';
import { autoDraftFromLinks } from '../application/autoDraftFromLinks';
import { updateAssignment } from '../application/updateAssignment';
import {
  AssignmentDraftRepo,
  AssignmentRepo,
  AssistantLocoPilotRepo,
  LeaveRepo,
  LinkMembershipRepo,
  LinkRepo,
  LocoPilotRepo,
  TrainRepo,
} from '../domain/repositories';
import { AssignmentDraft, AssignmentError } from '../domain/types';
import {
  AssignmentDraftCommitResponse,
  AssignmentDraftCommitResult,
  AssignmentDraftRow,
  AssignmentDraftStageInput,
  AutoDraftMatchedRow,
  AutoDraftResponse,
  AutoDraftSkippedRow,
  DateQuery,
} from '../shared/schemas';
import { asyncHandler, requireParam } from './errorMiddleware';

export interface AssignmentDraftsRouterDeps {
  drafts: AssignmentDraftRepo;
  trains: TrainRepo;
  lps: LocoPilotRepo;
  alps: AssistantLocoPilotRepo;
  assignments: AssignmentRepo;
  leaves: LeaveRepo;
  links: LinkRepo;
  linkMemberships: LinkMembershipRepo;
}

export function createAssignmentDraftsRouter(
  deps: AssignmentDraftsRouterDeps,
): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/assignment-drafts?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      const list = await deps.drafts.list({ runDate: date });
      // Sort by departureTime so the cart renders chronologically.
      const sorted = list
        .slice()
        .sort(
          (a, b) =>
            a.departureTime.getTime() - b.departureTime.getTime(),
        );
      res.json(sorted.map(draftToWire));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assignment-drafts
  // -------------------------------------------------------------------------
  // Upserts by `(trainId, runDate)` — re-staging the same train collapses
  // to one row, matching the frontend's "one in-flight op per train" rule.
  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = AssignmentDraftStageInput.parse(req.body);
      const draft = await deps.drafts.upsert(stageInputToRepoInput(input));
      res.status(201).json(draftToWire(draft));
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assignment-drafts/commit?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  // Drains the cart for a date. Each draft is delegated to the regular
  // orchestrator. Successful drafts are deleted from the cart; failures
  // remain so the operator can fix and retry without re-keying picks.
  //
  // NOTE: must be registered BEFORE `DELETE /:trainId` to avoid Express
  //       binding `commit` to the parametric route on the wrong method.
  //       (They're different verbs so no conflict, but ordering keeps the
  //        file readable as a top-down spec.)

  router.post(
    '/commit',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      const drafts = await deps.drafts.list({ runDate: date });
      // Sort by departureTime so commit order is stable and predictable.
      drafts.sort(
        (a, b) => a.departureTime.getTime() - b.departureTime.getTime(),
      );

      const results: AssignmentDraftCommitResult[] = [];
      const successfulDraftIds: string[] = [];
      for (const d of drafts) {
        const result = await commitOne(deps, d);
        results.push(result);
        if (result.success) {
          successfulDraftIds.push(d.id);
        }
      }

      // Batch-delete all successful drafts in a single mutation instead of
      // deleting one at a time inside commitOne. This reduces Sheets API
      // round-trips from N to 1 for the assignment_drafts table.
      if (successfulDraftIds.length > 0) {
        await deps.drafts.deleteMany(successfulDraftIds);
      }

      const body: AssignmentDraftCommitResponse = { results };
      res.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/assignment-drafts/auto?date=YYYY-MM-DD   (HLD §4.12 / Phase 3)
  //
  // For every train running on `date` that does NOT already have an active
  // assignment or staged draft, propose an LP (and ALP if the train type
  // requires one) sourced from active link memberships. Validated against
  // the same eligibility / leave / window rules that `assignCrew` enforces,
  // then upserted into the draft cart. Operators commit through the
  // existing `+ Assign (N)` flow — Auto-Draft never touches the live
  // assignments table.
  // -------------------------------------------------------------------------
  router.post(
    '/auto',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);

      const existingDrafts = await deps.drafts.list({ runDate: date });
      const existingDraftTrainIds = new Set(existingDrafts.map((d) => d.trainId));

      const { proposals, skipped } = await autoDraftFromLinks(
        {
          trains: deps.trains,
          lps: deps.lps,
          alps: deps.alps,
          assignments: deps.assignments,
          drafts: deps.drafts,
          leaves: deps.leaves,
          links: deps.links,
          linkMemberships: deps.linkMemberships,
        },
        { runDate: date, existingDraftTrainIds },
      );

      const matched: AutoDraftMatchedRow[] = [];
      for (const p of proposals) {
        await deps.drafts.upsert({
          kind: 'create',
          trainId: p.train.id,
          trainNumber: p.train.number,
          trainName: p.train.name,
          trainType: p.train.type,
          runDate: p.runDate,
          departureTime: p.departureTime,
          lpId: p.lp.id,
          lpName: p.lp.name,
          ...(p.alp ? { alpId: p.alp.id, alpName: p.alp.name } : {}),
        });
        const row: AutoDraftMatchedRow = {
          trainId: p.train.id,
          trainNumber: p.train.number,
          trainName: p.train.name,
          lpId: p.lp.id,
          lpName: p.lp.name,
          lpLinkName: p.lpLinkName,
          positionNumber: p.positionNumber,
        };
        if (p.alp) {
          row.alpId = p.alp.id;
          row.alpName = p.alp.name;
        }
        if (p.alpLinkName) row.alpLinkName = p.alpLinkName;
        matched.push(row);
      }

      const skippedWire: AutoDraftSkippedRow[] = skipped.map((s) => ({
        trainId: s.trainId,
        trainNumber: s.trainNumber,
        reason: s.reason,
      }));

      const body: AutoDraftResponse = { matched, skipped: skippedWire };
      res.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/assignment-drafts?date=YYYY-MM-DD     (reset all for date)
  // -------------------------------------------------------------------------
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const { date } = DateQuery.parse(req.query);
      await deps.drafts.deleteAllForDate(date);
      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/assignment-drafts/:trainId?date=YYYY-MM-DD    (unstage one)
  // -------------------------------------------------------------------------
  // Idempotent — no row found is still a 204 because the operator's intent
  // ("there should be no draft for this train") is already satisfied.
  router.delete(
    '/:trainId',
    asyncHandler(async (req, res) => {
      const trainId = requireParam(req, 'trainId');
      const { date } = DateQuery.parse(req.query);
      await deps.drafts.deleteByTrainAndDate(trainId, date);
      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Apply one draft to its persistent assignment via the regular orchestrator.
 * On success the draft row is deleted from the cart; on a rule violation
 * the draft remains so the operator can revise their pick.
 *
 * Errors are translated to the same `{ code, ...ctx }` wire shape used by
 * the rest of the API so the SPA can re-use its existing error mapping.
 */
async function commitOne(
  deps: AssignmentDraftsRouterDeps,
  d: AssignmentDraft,
): Promise<AssignmentDraftCommitResult> {
  try {
    if (d.kind === 'create') {
      if (!d.lpId) {
        return failure(d.trainId, {
          code: 'VALIDATION_FAILED',
          message: 'create draft missing lpId',
        });
      }
      const r = await assignCrew(deps, {
        trainId: d.trainId,
        runDate: d.runDate,
        lpId: d.lpId,
        ...(d.alpId ? { alpId: d.alpId } : {}),
        ...(d.alpId2 ? { alpId2: d.alpId2 } : {}),
      });
      return persistOnSuccess(d, r);
    }
    if (d.kind === 'update') {
      if (!d.assignmentId) {
        return failure(d.trainId, {
          code: 'VALIDATION_FAILED',
          message: 'update draft missing assignmentId',
        });
      }
      // Pre-flight: a stale draft against an already-archived assignment
      // produces a clean error code instead of an orchestrator throw.
      const existing = await deps.assignments.findById(d.assignmentId, {
        includeArchived: true,
      });
      if (!existing) {
        return failure(d.trainId, {
          code: 'NOT_FOUND',
          entity: 'ASSIGNMENT',
          id: d.assignmentId,
        });
      }
      if (existing.archivedAt) {
        return failure(d.trainId, {
          code: 'ASSIGNMENT_ARCHIVED',
          assignmentId: d.assignmentId,
        });
      }
      const r = await updateAssignment(deps, {
        assignmentId: d.assignmentId,
        ...(d.lpId !== undefined ? { lpId: d.lpId } : {}),
        // `alpId: null` clears the slot (only valid on MEMU/DEMU — the
        // orchestrator rejects otherwise). `alpId: undefined` leaves it.
        alpId: d.alpId ?? null,
        alpId2: d.alpId2 ?? null,
      });
      return persistOnSuccess(d, r);
    }
    // delete
    if (!d.assignmentId) {
      return failure(d.trainId, {
        code: 'VALIDATION_FAILED',
        message: 'delete draft missing assignmentId',
      });
    }
    const existing = await deps.assignments.findById(d.assignmentId, {
      includeArchived: true,
    });
    if (!existing) {
      return failure(d.trainId, {
        code: 'NOT_FOUND',
        entity: 'ASSIGNMENT',
        id: d.assignmentId,
      });
    }
    // Delegate to the orchestrator — it rolls the LP/ALP rest clocks back
    // to the snapshot captured at create-time before archiving the row.
    // The orchestrator is idempotent on already-archived assignments, so a
    // stale draft against a row another operator has already archived
    // succeeds without double-rolling the rest clocks.
    await archiveAssignment(deps, d.assignmentId);
    return { trainId: d.trainId, success: true };
  } catch (e) {
    return failure(d.trainId, {
      code: 'INTERNAL_ERROR',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

async function persistOnSuccess(
  d: AssignmentDraft,
  r: { ok: true } | { ok: false; error: AssignmentError },
): Promise<AssignmentDraftCommitResult> {
  if (r.ok) {
    // Draft deletion is batched at the end of the commit loop.
    return { trainId: d.trainId, success: true };
  }
  return failure(d.trainId, { ...r.error });
}

function failure(
  trainId: string,
  error: { code: string; [k: string]: unknown },
): AssignmentDraftCommitResult {
  return { trainId, success: false, error };
}

/**
 * Wire ↔ domain mapping. The wire format mirrors the frontend's StagedOp
 * discriminated union; the domain `AssignmentDraft` is a flat shape with
 * optional fields. The mappers below are the only place these two
 * representations meet.
 */
function draftToWire(d: AssignmentDraft): AssignmentDraftRow {
  const departureTime = d.departureTime.toISOString();
  const display = {
    trainId: d.trainId,
    trainNumber: d.trainNumber,
    trainName: d.trainName,
    trainType: d.trainType,
    runDate: d.runDate,
    departureTime,
  };
  switch (d.kind) {
    case 'create':
      return {
        kind: 'create',
        ...display,
        lpId: d.lpId ?? '',
        lpName: d.lpName ?? '',
        alpId: d.alpId ?? null,
        alpName: d.alpName ?? null,
        alpId2: d.alpId2 ?? null,
        alpName2: d.alpName2 ?? null,
      };
    case 'update':
      return {
        kind: 'update',
        ...display,
        assignmentId: d.assignmentId ?? '',
        originalLpName: d.originalLpName ?? '',
        originalAlpName: d.originalAlpName ?? null,
        originalAlpName2: d.originalAlpName2 ?? null,
        lpId: d.lpId ?? '',
        lpName: d.lpName ?? '',
        alpId: d.alpId ?? null,
        alpName: d.alpName ?? null,
        alpId2: d.alpId2 ?? null,
        alpName2: d.alpName2 ?? null,
      };
    case 'delete':
      return {
        kind: 'delete',
        ...display,
        assignmentId: d.assignmentId ?? '',
        lpName: d.lpName ?? '',
        alpName: d.alpName ?? null,
        alpName2: d.alpName2 ?? null,
      };
  }
}

function stageInputToRepoInput(
  input: AssignmentDraftStageInput,
): Omit<AssignmentDraft, 'id' | 'createdAt'> {
  const departureTime = new Date(input.departureTime);
  const base = {
    trainId: input.trainId,
    trainNumber: input.trainNumber,
    trainName: input.trainName,
    trainType: input.trainType,
    runDate: input.runDate,
    departureTime,
  };
  switch (input.kind) {
    case 'create':
      return {
        ...base,
        kind: 'create',
        lpId: input.lpId,
        lpName: input.lpName,
        ...(input.alpId ? { alpId: input.alpId } : {}),
        ...(input.alpName ? { alpName: input.alpName } : {}),
        ...(input.alpId2 ? { alpId2: input.alpId2 } : {}),
        ...(input.alpName2 ? { alpName2: input.alpName2 } : {}),
      };
    case 'update':
      return {
        ...base,
        kind: 'update',
        assignmentId: input.assignmentId,
        lpId: input.lpId,
        lpName: input.lpName,
        ...(input.alpId ? { alpId: input.alpId } : {}),
        ...(input.alpName ? { alpName: input.alpName } : {}),
        ...(input.alpId2 ? { alpId2: input.alpId2 } : {}),
        ...(input.alpName2 ? { alpName2: input.alpName2 } : {}),
        originalLpName: input.originalLpName,
        ...(input.originalAlpName
          ? { originalAlpName: input.originalAlpName }
          : {}),
        ...(input.originalAlpName2
          ? { originalAlpName2: input.originalAlpName2 }
          : {}),
      };
    case 'delete':
      return {
        ...base,
        kind: 'delete',
        assignmentId: input.assignmentId,
        ...(input.lpName ? { lpName: input.lpName } : {}),
        ...(input.alpName ? { alpName: input.alpName } : {}),
        ...(input.alpName2 ? { alpName2: input.alpName2 } : {}),
      };
  }
}

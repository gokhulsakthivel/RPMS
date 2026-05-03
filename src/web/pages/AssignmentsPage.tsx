// `AssignmentsPage` — per-train assignments view (design.md §9.3).
//
// Staging model (server-backed):
//   The page maintains a SERVER-PERSISTED draft cart — `data/assignment_drafts.csv`
//   exposed via `/api/assignment-drafts`. The per-row Assign / Edit / Delete
//   modals call `POST /api/assignment-drafts` to upsert one draft per train,
//   and the toolbar drives the cart as a whole:
//
//   - "+ Assign (N)" → `POST /api/assignment-drafts/commit?date=...`. The
//     server iterates each draft, calls the regular orchestrators, and
//     hard-deletes successful drafts. Returns a per-draft result array.
//   - "Reset draft"  → `DELETE /api/assignment-drafts?date=...`. Drops every
//     draft for the selected date.
//
// Per-row affordances on rows with a staged op:
//   - Edit ✎  — re-opens the appropriate modal with the staged values
//                pre-filled, so the operator can revise the draft.
//   - Remove ✕ — `DELETE /api/assignment-drafts/:trainId?date=...`.
//
// Why server-backed? A page reload, second tab, or second operator all see
// the same in-flight changes. The CSV is the source of truth — including
// for "what hasn't been committed yet".

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assignmentDrafts as assignmentDraftsApi,
  assignments as assignmentsApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type {
  AssignmentDraftRow,
  AssignmentRow,
} from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AssignCrewModal } from '../components/assignments/AssignCrewModal';
import { AssignmentTable } from '../components/assignments/AssignmentTable';
import { EditAssignmentModal } from '../components/assignments/EditAssignmentModal';
import type { StagedOp } from '../components/assignments/stagedAssignments';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';
import { ConfirmDialog } from '../components/overlay/ConfirmDialog';
import { Button } from '../components/primitives/Button';

export function AssignmentsPage() {
  const { selectedDate } = useSelectedDate();
  const toast = useToast();

  const [rows, setRows] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Modal/dialog targets — each holds the AssignmentRow the modal is
  // anchored to (or null when closed).
  const [target, setTarget] = useState<AssignmentRow | null>(null);
  const [editing, setEditing] = useState<AssignmentRow | null>(null);
  const [deleting, setDeleting] = useState<AssignmentRow | null>(null);

  // Server-backed draft cart. The list comes from the API; the `staged` Map
  // is derived for the table/modals (which expect a Map<trainId, StagedOp>).
  const [drafts, setDrafts] = useState<AssignmentDraftRow[] | null>(null);
  const [draftTick, setDraftTick] = useState(0);
  const [committing, setCommitting] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);
  const refetchDrafts = useCallback(() => setDraftTick((n) => n + 1), []);

  // -------------------------------------------------------------------------
  // Fetch effects — assignments and drafts both reload on date change.
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    assignmentsApi
      .list(selectedDate)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, tick]);

  useEffect(() => {
    let cancelled = false;
    assignmentDraftsApi
      .list(selectedDate)
      .then((data) => {
        if (!cancelled) setDrafts(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Don't blow away the page UI for a transient draft-list failure —
        // the draft cart degrades to "empty" but the assignments list still
        // renders. A retry happens on the next staging action.
        // eslint-disable-next-line no-console
        console.error('failed to load drafts:', e);
        setDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, draftTick]);

  // -------------------------------------------------------------------------
  // Derived: Map<trainId, StagedOp> — what the table + modals consume.
  // The wire shape `AssignmentDraftRow` is structurally identical to
  // `StagedOp`, so the cast is just a type-system convenience.
  // -------------------------------------------------------------------------

  const staged = useMemo<ReadonlyMap<string, StagedOp>>(() => {
    const m = new Map<string, StagedOp>();
    if (!drafts) return m;
    for (const d of drafts) m.set(d.trainId, d as StagedOp);
    return m;
  }, [drafts]);

  // -------------------------------------------------------------------------
  // Stage handlers — each modal/dialog calls one of these on Save / confirm.
  // Every action round-trips through the API; a failure is surfaced via
  // toast and leaves the cart untouched.
  // -------------------------------------------------------------------------

  const stageOp = useCallback(
    async (op: StagedOp) => {
      try {
        await assignmentDraftsApi.upsert(op);
        refetchDrafts();
      } catch (e) {
        toast.error(
          `Couldn't save draft — ${
            e instanceof ApiError
              ? describeApiError(e)
              : (e as Error).message
          }`,
        );
      }
    },
    [refetchDrafts, toast],
  );

  const unstage = useCallback(
    async (trainId: string) => {
      try {
        await assignmentDraftsApi.remove(trainId, selectedDate);
        refetchDrafts();
      } catch (e) {
        toast.error(
          `Couldn't remove draft — ${
            e instanceof ApiError
              ? describeApiError(e)
              : (e as Error).message
          }`,
        );
      }
    },
    [refetchDrafts, selectedDate, toast],
  );

  async function confirmStageDelete() {
    if (!deleting || !deleting.assignmentId) return;
    await stageOp({
      kind: 'delete',
      assignmentId: deleting.assignmentId,
      trainId: deleting.trainId,
      trainNumber: deleting.trainNumber,
      trainName: deleting.trainName,
      trainType: deleting.trainType,
      runDate: deleting.runDate,
      departureTime: deleting.departureTime,
      lpName: deleting.lp ? deleting.lp.name : '',
      alpName:
        deleting.alp && deleting.alp !== 'NOT_REQUIRED'
          ? deleting.alp.name
          : null,
    });
    setDeleting(null);
  }

  // -------------------------------------------------------------------------
  // Bulk commit — drains the server-side cart. Successful drafts are
  // deleted by the server; failures stay so the operator can fix and retry.
  // -------------------------------------------------------------------------

  async function commitAll() {
    if (!drafts || drafts.length === 0) return;
    setCommitting(true);
    try {
      const { results } = await assignmentDraftsApi.commit(selectedDate);
      const successes = results.filter((r) => r.success).length;
      const failures = results.filter((r) => !r.success);
      if (failures.length === 0) {
        toast.success(
          `Saved ${successes} change${successes === 1 ? '' : 's'}`,
        );
      } else {
        const head = failures[0];
        const draft = head
          ? drafts.find((d) => d.trainId === head.trainId)
          : undefined;
        const trainNumber = draft ? draft.trainNumber : '?';
        const message =
          head && !head.success
            ? typeof head.error['message'] === 'string'
              ? (head.error['message'] as string)
              : head.error.code
            : '';
        toast.error(
          `${successes} saved, ${failures.length} failed — ${trainNumber}: ${message}`,
        );
      }
    } catch (e) {
      toast.error(
        `Commit failed — ${
          e instanceof ApiError ? describeApiError(e) : (e as Error).message
        }`,
      );
    } finally {
      setCommitting(false);
      refetchDrafts();
      refetch();
      refreshSummary();
    }
  }

  async function resetDraft() {
    try {
      await assignmentDraftsApi.reset(selectedDate);
      refetchDrafts();
      toast.info('Draft cleared');
    } catch (e) {
      toast.error(
        `Couldn't reset draft — ${
          e instanceof ApiError ? describeApiError(e) : (e as Error).message
        }`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pre-fill values when re-opening a modal on a row that already has a
  // staged op — keeps Edit-the-draft seamless.
  // -------------------------------------------------------------------------

  const targetStagedOp = target ? staged.get(target.trainId) : undefined;
  const editingStagedOp = editing ? staged.get(editing.trainId) : undefined;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const draftCount = staged.size;

  return (
    <>
      <PageHeader
        title="Assignments"
        subtitle={`Trains departing on ${selectedDate}.`}
        action={
          <div className="page-header__actions">
            <Button
              variant="text"
              onClick={resetDraft}
              disabled={committing || draftCount === 0}
            >
              Reset draft
            </Button>
            <Button
              variant="primary"
              onClick={commitAll}
              disabled={committing || draftCount === 0}
            >
              {committing
                ? 'Saving…'
                : draftCount === 0
                  ? '+ Assign'
                  : `+ Assign (${draftCount})`}
            </Button>
          </div>
        }
      />

      {draftCount > 0 ? (
        <Banner tone="info" title={`${draftCount} change${draftCount === 1 ? '' : 's'} pending`}>
          These changes are buffered on the server — nothing has been written to the
          assignments CSV yet. Click <strong>+ Assign</strong> to commit, or
          <strong> Reset draft</strong> to discard.
        </Banner>
      ) : null}

      {error ? (
        <Banner
          tone="error"
          title="Couldn't load assignments"
          action={{ label: 'Retry', onClick: refetch }}
        >
          {error}
        </Banner>
      ) : null}

      {rows === null && !error ? (
        <SkeletonRows rows={5} columns={6} />
      ) : rows && rows.length === 0 ? (
        <EmptyState
          icon="📋"
          title="Nothing scheduled for this date"
          description="Trains scheduled to depart on this day will appear here."
        />
      ) : rows ? (
        <AssignmentTable
          rows={rows}
          staged={staged}
          onAssign={setTarget}
          onEdit={setEditing}
          onDelete={setDeleting}
          onUnstage={(trainId) => {
            void unstage(trainId);
          }}
        />
      ) : null}

      <AssignCrewModal
        target={target}
        // Pre-fill from the staged 'create' op if the operator is
        // re-opening to revise their draft.
        initialLpId={
          targetStagedOp && targetStagedOp.kind === 'create'
            ? targetStagedOp.lpId
            : null
        }
        initialAlpId={
          targetStagedOp && targetStagedOp.kind === 'create'
            ? targetStagedOp.alpId
            : null
        }
        // Hide crew already claimed by drafts on OTHER trains so the
        // operator never offers the same person twice.
        staged={staged}
        onClose={() => setTarget(null)}
        onStage={(op) => {
          void stageOp(op).then(() => {
            setTarget(null);
            toast.success(`Draft saved for ${op.trainNumber}`);
          });
        }}
      />

      <EditAssignmentModal
        target={editing}
        // Pre-fill from the staged 'update' op if one exists for this row.
        initialLpId={
          editingStagedOp && editingStagedOp.kind === 'update'
            ? editingStagedOp.lpId
            : null
        }
        initialAlpId={
          editingStagedOp && editingStagedOp.kind === 'update'
            ? editingStagedOp.alpId
            : null
        }
        // Hide crew already claimed by drafts on OTHER trains so the
        // operator never offers the same person twice.
        staged={staged}
        onClose={() => setEditing(null)}
        onStage={(op) => {
          void stageOp(op).then(() => {
            setEditing(null);
            toast.success(`Draft saved for ${op.trainNumber}`);
          });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Stage this assignment for archive?"
        body={
          deleting
            ? `The active assignment for ${deleting.trainNumber} · ${deleting.trainName} will be staged for archive. Nothing is written to the assignments CSV until you click + Assign.`
            : ''
        }
        confirmLabel="Stage archive"
        destructive
        onConfirm={() => {
          void confirmStageDelete();
        }}
        onCancel={() => setDeleting(null)}
      />

    </>
  );
}

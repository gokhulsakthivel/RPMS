// `AssignmentsPage` — per-train assignments view (design.md §9.3).
//
// Staging model:
//   The page owns a frontend-only "draft cart" — `Map<trainId, StagedOp>` —
//   that buffers every assignment change the operator makes. The per-row
//   modals (Assign / Edit) and the per-row Delete confirmation all
//   STAGE an op into the cart instead of touching the CSV directly. Two
//   toolbar buttons let the operator manage the draft as a whole:
//
//   - "+ Assign (N)" — drains the cart by POST/PUT/archive-ing every op
//     in turn. This is the ONLY moment the CSV is modified.
//   - "Reset draft"  — clears the cart without persisting anything.
//
// Per-row affordances on rows with a staged op:
//   - Edit ✎  — re-opens the appropriate modal with the staged values
//                pre-filled, so the operator can revise the draft.
//   - Remove ✕ — drops the op from the cart (no API call).
//
// Successful bulk commits clear the cart, refetch the list, and bump the
// summary cards. Partial failures keep the failed ops in the cart with a
// toast summary so the operator can fix and retry.

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  assignments as assignmentsApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type { AssignmentRow } from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AssignCrewModal } from '../components/assignments/AssignCrewModal';
import { AssignmentTable } from '../components/assignments/AssignmentTable';
import { EditAssignmentModal } from '../components/assignments/EditAssignmentModal';
import {
  type StagedOp,
  removeStagedOp,
  setStagedOp,
} from '../components/assignments/stagedAssignments';
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

  // Frontend-only draft cart. Keyed by trainId — one staged op per train.
  const [staged, setStaged] = useState<ReadonlyMap<string, StagedOp>>(
    new Map(),
  );
  const [committing, setCommitting] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  // Clear staged drafts when the operator switches dates — drafts from
  // 2024-08-12 don't make sense once we're looking at 2024-08-13.
  useEffect(() => {
    setStaged(new Map());
  }, [selectedDate]);

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

  // -------------------------------------------------------------------------
  // Stage handlers — each modal/dialog calls one of these on Save / confirm.
  // -------------------------------------------------------------------------

  const stageOp = useCallback((op: StagedOp) => {
    setStaged((prev) => setStagedOp(prev, op));
  }, []);

  const unstage = useCallback((trainId: string) => {
    setStaged((prev) => removeStagedOp(prev, trainId));
  }, []);

  function confirmStageDelete() {
    if (!deleting || !deleting.assignmentId) return;
    stageOp({
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
  // Bulk commit — drains the cart into the REST API. The ONLY place this
  // page touches the CSV.
  // -------------------------------------------------------------------------

  async function commitAll() {
    if (staged.size === 0) return;
    setCommitting(true);
    const successfulTrainIds: string[] = [];
    const failures: Array<{ op: StagedOp; message: string }> = [];

    // Sequential — keeps error attribution straightforward and avoids
    // the API needing to handle concurrent writes from one operator.
    for (const op of staged.values()) {
      try {
        if (op.kind === 'create') {
          await assignmentsApi.create({
            trainId: op.trainId,
            runDate: op.runDate,
            lpId: op.lpId,
            ...(op.alpId ? { alpId: op.alpId } : {}),
          });
        } else if (op.kind === 'update') {
          await assignmentsApi.update(op.assignmentId, {
            lpId: op.lpId,
            ...(op.alpId ? { alpId: op.alpId } : {}),
          });
        } else {
          await assignmentsApi.archive(op.assignmentId);
        }
        successfulTrainIds.push(op.trainId);
      } catch (e) {
        failures.push({
          op,
          message:
            e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        });
      }
    }

    // Drop the successful ops from the cart; keep failures so the
    // operator can fix and retry.
    setStaged((prev) => {
      const next = new Map(prev);
      for (const id of successfulTrainIds) next.delete(id);
      return next;
    });
    setCommitting(false);

    if (failures.length === 0) {
      toast.success(
        `Saved ${successfulTrainIds.length} change${
          successfulTrainIds.length === 1 ? '' : 's'
        }`,
      );
    } else {
      const head = failures[0];
      toast.error(
        `${successfulTrainIds.length} saved, ${failures.length} failed — ${
          head ? `${head.op.trainNumber}: ${head.message}` : ''
        }`,
      );
    }

    refetch();
    refreshSummary();
  }

  function resetDraft() {
    setStaged(new Map());
    toast.info('Draft cleared');
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
          These changes are buffered locally — nothing has been written to the CSV yet.
          Click <strong>+ Assign</strong> to commit, or <strong>Reset draft</strong> to discard.
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
          onUnstage={unstage}
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
          stageOp(op);
          setTarget(null);
          toast.success(`Draft saved for ${op.trainNumber}`);
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
          stageOp(op);
          setEditing(null);
          toast.success(`Draft saved for ${op.trainNumber}`);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Stage this assignment for archive?"
        body={
          deleting
            ? `The active assignment for ${deleting.trainNumber} · ${deleting.trainName} will be staged for archive. Nothing is written to the CSV until you click + Assign.`
            : ''
        }
        confirmLabel="Stage archive"
        destructive
        onConfirm={confirmStageDelete}
        onCancel={() => setDeleting(null)}
      />

    </>
  );
}

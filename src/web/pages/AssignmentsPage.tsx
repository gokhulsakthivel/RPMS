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
  links as linksApi,
  prAssignments as prAssignmentsApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type {
  AssignmentDraftRow,
  AssignmentRow,
  LinkProjectionRow,
  LinkRow,
  PrAssignmentRow,
} from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AssignCrewModal } from '../components/assignments/AssignCrewModal';
import { AssignmentTable } from '../components/assignments/AssignmentTable';
import { EditAssignmentModal } from '../components/assignments/EditAssignmentModal';
import { EditPrAssignmentModal } from '../components/assignments/EditPrAssignmentModal';
import { PrAssignmentTable } from '../components/assignments/PrAssignmentTable';
import {
  buildSuggestionByTrainNumber,
  type LinkSuggestion,
} from '../components/assignments/linkSuggestions';
import {
  buildLinkContextByTrainNumber,
  type LinkContext,
} from '../components/assignments/linkContext';
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
  const [autoDrafting, setAutoDrafting] = useState(false);

  // Phase 4 — link projection for the selected date, used to derive
  // pre-fill suggestions for AssignCrewModal / EditAssignmentModal. Loaded
  // best-effort: a fetch failure simply means "no suggestions today".
  const [projection, setProjection] = useState<LinkProjectionRow[] | null>(
    null,
  );

  // Full link records (with positions arrays) — used by the Plan-table
  // hint to walk to position N-1 of the same link and surface the
  // previous-day outward leg when a train is an overnight return run.
  // Best-effort: a failure simply means no "↩ from…" badges.
  const [links, setLinks] = useState<LinkRow[] | null>(null);

  // Previous-day assignments — needed by both `linkContext` (to print
  // the outward leg's actual crew names) and `linkSuggestions` (to
  // pre-fill the modal for INWARD trains from the paired outward's
  // already-committed assignment instead of the rotation guess).
  const [prevDayAssignments, setPrevDayAssignments] = useState<
    AssignmentRow[] | null
  >(null);

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

  // Prefetch eligible crew for every train on this date as soon as the row
  // list arrives. The responses land in the 30 s client-side cache, so any
  // subsequent modal open (Assign or Edit) is served instantly from cache
  // instead of making a blocking round-trip to the Sheets-backed API.
  useEffect(() => {
    if (!rows) return;
    for (const row of rows) {
      // Fire-and-forget — errors are swallowed; the modal will retry on open.
      assignmentsApi.eligibleCrew(row.trainId, row.runDate).catch(() => {});
    }
  }, [rows]);

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

  // Phase 4 — best-effort projection fetch. Suggestions are a nice-to-have:
  // a failure (or empty result) just means the modals get no pre-fill.
  useEffect(() => {
    let cancelled = false;
    setProjection(null);
    linksApi
      .projection(selectedDate)
      .then((data) => {
        if (!cancelled) setProjection(data);
      })
      .catch(() => {
        if (!cancelled) setProjection([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  // Full link list — re-used by the Plan-table row hint. Doesn't change
  // with the selected date, but we re-fetch on date change to stay in
  // step with any links the operator added between renders.
  useEffect(() => {
    let cancelled = false;
    linksApi
      .list()
      .then((data) => {
        if (!cancelled) setLinks(data);
      })
      .catch(() => {
        if (!cancelled) setLinks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  // Previous-day assignments — best-effort fetch.
  useEffect(() => {
    let cancelled = false;
    setPrevDayAssignments(null);
    const prev = previousIsoDate(selectedDate);
    assignmentsApi
      .list(prev)
      .then((data) => {
        if (!cancelled) setPrevDayAssignments(data);
      })
      .catch(() => {
        if (!cancelled) setPrevDayAssignments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  // PR slots for the selected date — best-effort. Direct-save (no draft cart).
  const [prRows, setPrRows] = useState<PrAssignmentRow[] | null>(null);
  const [prTick, setPrTick] = useState(0);
  const [editingPr, setEditingPr] = useState<PrAssignmentRow | null>(null);
  const refetchPr = useCallback(() => setPrTick((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setPrRows(null);
    prAssignmentsApi
      .list(selectedDate)
      .then((data) => {
        if (!cancelled) setPrRows(data);
      })
      .catch(() => {
        if (!cancelled) setPrRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, prTick]);

  // trainNumber → AssignmentRow for the selected date (same-day) and the
  // day before. These power the inward→outward chain in both the modal
  // pre-fill and the row hint.
  const sameDayAssignmentsByTrain = useMemo<ReadonlyMap<string, AssignmentRow>>(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of rows ?? []) m.set(a.trainNumber, a);
    return m;
  }, [rows]);

  const prevDayAssignmentsByTrain = useMemo<ReadonlyMap<string, AssignmentRow>>(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of prevDayAssignments ?? []) m.set(a.trainNumber, a);
    return m;
  }, [prevDayAssignments]);

  const linksById = useMemo<ReadonlyMap<string, LinkRow>>(
    () => new Map((links ?? []).map((l) => [l.id, l] as const)),
    [links],
  );

  const suggestionByTrainNumber = useMemo<
    ReadonlyMap<string, LinkSuggestion>
  >(() => {
    if (!projection) return new Map();
    return buildSuggestionByTrainNumber(projection, {
      linksById,
      sameDayAssignmentsByTrain,
      prevDayAssignmentsByTrain,
    });
  }, [projection, linksById, sameDayAssignmentsByTrain, prevDayAssignmentsByTrain]);

  const linkContextByTrainNumber = useMemo<
    ReadonlyMap<string, LinkContext>
  >(() => {
    if (!projection || !links) return new Map();
    return buildLinkContextByTrainNumber(projection, linksById, selectedDate, {
      sameDayAssignmentsByTrain,
      prevDayAssignmentsByTrain,
    });
  }, [projection, links, linksById, selectedDate, sameDayAssignmentsByTrain, prevDayAssignmentsByTrain]);

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
      alpName2:
        deleting.alp2 && deleting.alp2 !== 'NOT_REQUIRED'
          ? deleting.alp2.name
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
  // Auto-Draft — stage one draft per train running today from active links
  // (HLD §4.12 / Phase 3). The server skips trains that already have an
  // assignment or a draft; the toast summarises matched vs skipped counts.
  // -------------------------------------------------------------------------
  async function autoDraft() {
    setAutoDrafting(true);
    try {
      const { matched, skipped } = await assignmentDraftsApi.auto(selectedDate);
      refetchDrafts();

      // Surface per-train skip reasons so operators can see exactly why
      // a train was missed (NO_LINK_FOR_TRAIN, NO_LP_MEMBER_AT_POSITION,
      // LP_ON_LEAVE, etc.). Grouped log keeps the console scannable.
      const groups = new Map<string, Array<{ trainNumber: string; detail: unknown }>>();
      for (const s of skipped) {
        const code = s.reason.code;
        const detail: Record<string, unknown> = { ...s.reason };
        delete detail['code'];
        const bucket = groups.get(code) ?? [];
        bucket.push({ trainNumber: s.trainNumber, detail });
        groups.set(code, bucket);
      }
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[AutoDraft] ${selectedDate} — staged ${matched.length}, skipped ${skipped.length}`,
      );
      // eslint-disable-next-line no-console
      console.info('matched', matched);
      for (const [code, rows] of groups) {
        // eslint-disable-next-line no-console
        console.info(`skipped · ${code} (${rows.length})`, rows);
      }
      // eslint-disable-next-line no-console
      console.groupEnd();

      if (matched.length === 0 && skipped.length === 0) {
        toast.info('No trains running on this date.');
      } else if (matched.length === 0) {
        toast.info(
          `Auto-Draft staged nothing (${skipped.length} skipped — see console).`,
        );
      } else {
        const breakdown = Array.from(groups)
          .map(([code, rows]) => `${rows.length} ${code}`)
          .join(', ');
        toast.success(
          `Auto-Drafted ${matched.length} train${matched.length === 1 ? '' : 's'}${
            skipped.length > 0 ? ` · ${skipped.length} skipped (${breakdown})` : ''
          }`,
        );
      }
    } catch (e) {
      toast.error(
        `Auto-Draft failed — ${
          e instanceof ApiError ? describeApiError(e) : (e as Error).message
        }`,
      );
    } finally {
      setAutoDrafting(false);
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
              variant="secondary"
              onClick={autoDraft}
              disabled={committing || autoDrafting}
              title="Stage a draft for every train running today, sourced from active links."
            >
              {autoDrafting ? 'Auto-Drafting…' : 'Auto-Draft from links'}
            </Button>
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
          linkContextByTrainNumber={linkContextByTrainNumber}
          onAssign={setTarget}
          onEdit={setEditing}
          onDelete={setDeleting}
          onUnstage={(trainId) => {
            void unstage(trainId);
          }}
        />
      ) : null}

      {prRows && prRows.length > 0 ? (
        <section className="assignments__pr-section">
          <h3 className="assignments__pr-heading">Periodic Rest</h3>
          <p className="assignments__pr-sub">
            Default crew comes from the link rotation. Override per day if
            someone else is taking the PR slot, or clear it for the day.
          </p>
          <PrAssignmentTable rows={prRows} onEdit={setEditingPr} />
        </section>
      ) : null}

      <EditPrAssignmentModal
        target={editingPr}
        runDate={selectedDate}
        onClose={() => setEditingPr(null)}
        onSaved={() => {
          refetchPr();
          toast.success('PR updated');
        }}
      />

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
        initialAlpId2={
          targetStagedOp && targetStagedOp.kind === 'create'
            ? targetStagedOp.alpId2
            : null
        }
        // Hide crew already claimed by drafts on OTHER trains so the
        // operator never offers the same person twice.
        staged={staged}
        linkSuggestion={
          target ? suggestionByTrainNumber.get(target.trainNumber) ?? null : null
        }
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
        initialAlpId2={
          editingStagedOp && editingStagedOp.kind === 'update'
            ? editingStagedOp.alpId2
            : null
        }
        // Hide crew already claimed by drafts on OTHER trains so the
        // operator never offers the same person twice.
        staged={staged}
        linkSuggestion={
          editing
            ? suggestionByTrainNumber.get(editing.trainNumber) ?? null
            : null
        }
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

/** `YYYY-MM-DD` (IST) minus one day. Pure: parses via `Date.UTC`. */
function previousIsoDate(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d) - 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

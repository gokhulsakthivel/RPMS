// `LinksPage` — the Links tab (HLD §4.9).
//
// Layout (board-first, admin-collapsed):
//   ┌────────────────────────────────────────────────────────────────┐
//   │ Header  + Manage links                                         │
//   ├────────────────────────────────────────────────────────────────┤
//   │ LinksBoard (board-style, paired LP+ALP per cycle)              │
//   ├────────────────────────────────────────────────────────────────┤
//   │ Manage panel (disclosure): LinkTable + MembershipsPanel        │
//   └────────────────────────────────────────────────────────────────┘

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assignmentDrafts as assignmentDraftsApi,
  assignments as assignmentsApi,
  assistantLocoPilots as alpApi,
  links as linksApi,
  locoPilots as lpApi,
  trains as trainsApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type {
  AssignmentDraftRow,
  AssignmentRow,
  LinkRow,
} from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { AddLinkModal } from '../components/links/AddLinkModal';
import { EditLinkModal } from '../components/links/EditLinkModal';
import { LinkTable } from '../components/links/LinkTable';
import { LinksBoard } from '../components/links/LinksBoard';
import { MembershipsPanel } from '../components/links/MembershipsPanel';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';
import { ConfirmDialog } from '../components/overlay/ConfirmDialog';
import { Button } from '../components/primitives/Button';
import {
  diffPlanVsServer,
  useLinksPlan,
  type LinksPlanSlot,
  type TrainMeta,
} from '../lib/linksPlan';

export function LinksPage() {
  const toast = useToast();
  const { selectedDate } = useSelectedDate();
  const asOfDate = selectedDate;

  const [rows, setRows] = useState<LinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<LinkRow | null>(null);
  const [archiving, setArchiving] = useState<LinkRow | null>(null);
  const [archivePending, setArchivePending] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  // Browser-local plan for the Links scratchpad. Lives here so the Sync
  // and Reset buttons sit in the page-level toolbar with direct access.
  const {
    plan,
    isDirty,
    setSlot,
    removeSlot,
    vacateCrewFromPlan,
    hidePrCrew,
    setPrSlot,
    removePrSlot,
    resetPlan,
  } = useLinksPlan(asOfDate);
  const [syncing, setSyncing] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    linksApi
      .list()
      .then((data) => {
        if (cancelled) return;
        setRows(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const sorted = useMemo<LinkRow[] | null>(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [rows]);

  const selectedLink = useMemo<LinkRow | null>(
    () => sorted?.find((r) => r.id === selectedId) ?? null,
    [sorted, selectedId],
  );

  async function confirmArchive() {
    if (!archiving) return;
    setArchivePending(true);
    try {
      await linksApi.archive(archiving.id);
      toast.success(`Archived ${archiving.name}`);
      if (selectedId === archiving.id) setSelectedId(null);
      setArchiving(null);
      refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
    } finally {
      setArchivePending(false);
    }
  }

  /**
   * "Auto-Draft from links" — runs the server orchestrator to seed
   * drafts for every train running today from active link memberships,
   * then overlays any local plan edits on top via the existing diff /
   * upsert path. After a successful run the local plan is cleared
   * (server drafts now hold the same edits).
   */
  async function syncPlanToDrafts() {
    setSyncing(true);
    try {
      // 1. Orchestrator first — stages drafts for every train running
      //    today that isn't already assigned or drafted. Surface failure
      //    but keep going so the operator's local edits still try to sync.
      let autoMatched = 0;
      let autoSkipped = 0;
      let skipBreakdown = '';
      try {
        const auto = await assignmentDraftsApi.auto(asOfDate);
        autoMatched = auto.matched.length;
        autoSkipped = auto.skipped.length;
        const groups = new Map<string, Array<{ trainNumber: string; detail: unknown }>>();
        for (const s of auto.skipped) {
          const code = s.reason.code;
          const detail: Record<string, unknown> = { ...s.reason };
          delete detail['code'];
          const bucket = groups.get(code) ?? [];
          bucket.push({ trainNumber: s.trainNumber, detail });
          groups.set(code, bucket);
        }
        if (auto.skipped.length > 0) {
          // eslint-disable-next-line no-console
          console.groupCollapsed(
            `[AutoDraft] ${asOfDate} — staged ${auto.matched.length}, skipped ${auto.skipped.length}`,
          );
          // eslint-disable-next-line no-console
          console.info('matched', auto.matched);
          for (const [code, rows] of groups) {
            // eslint-disable-next-line no-console
            console.info(`skipped · ${code} (${rows.length})`, rows);
          }
          // eslint-disable-next-line no-console
          console.groupEnd();
        }
        skipBreakdown = Array.from(groups)
          .map(([code, rows]) => `${rows.length} ${code}`)
          .join(', ');
      } catch (e) {
        toast.error(
          `Auto-Draft from links failed — ${e instanceof ApiError ? describeApiError(e) : (e as Error).message}`,
        );
      }

      // 2. Load the post-orchestrator state and overlay local plan edits.
      const [assignments, drafts, lps, alps, trains] = await Promise.all([
        assignmentsApi.list(asOfDate),
        assignmentDraftsApi.list(asOfDate).catch(() => [] as AssignmentDraftRow[]),
        lpApi.list(asOfDate),
        alpApi.list(asOfDate),
        trainsApi.list(asOfDate),
      ]);

      const assignmentsByTrainId = new Map<string, AssignmentRow>();
      for (const a of assignments) assignmentsByTrainId.set(a.trainId, a);
      const draftsByTrainId = new Map(drafts.map((d) => [d.trainId, d] as const));
      const lpById = new Map(lps.map((l) => [l.id, l] as const));
      const alpById = new Map(alps.map((a) => [a.id, a] as const));
      const trainById = new Map<string, TrainMeta>();
      for (const t of trains) {
        trainById.set(t.id, {
          id: t.id,
          number: t.number,
          name: t.name,
          type: t.type,
          departureTime: t.departureTime,
        });
      }

      // The effective view: rotation/live overlaid with plan overrides,
      // restricted to trains that have a plan slot OR a server draft (so
      // we don't accidentally clean up untouched rows).
      const effectiveSlots = new Map<string, LinksPlanSlot>();
      function readEffective(trainId: string): LinksPlanSlot | null {
        const planned = plan.slots[trainId];
        if (planned) return planned;
        const live = assignmentsByTrainId.get(trainId);
        const draft = draftsByTrainId.get(trainId);
        if (draft && draft.kind !== 'delete') {
          return {
            lpId: draft.lpId,
            alpId: draft.alpId ?? null,
            alpId2: draft.alpId2 ?? null,
            origin: 'auto',
          };
        }
        if (live) {
          return {
            lpId: live.lp?.id ?? null,
            alpId: live.alp && live.alp !== 'NOT_REQUIRED' ? live.alp.id : null,
            alpId2: live.alp2 && live.alp2 !== 'NOT_REQUIRED' ? live.alp2.id : null,
            origin: 'auto',
          };
        }
        return null;
      }
      for (const trainId of Object.keys(plan.slots)) {
        const e = readEffective(trainId);
        if (e) effectiveSlots.set(trainId, e);
      }

      const ops = diffPlanVsServer({
        runDate: asOfDate,
        effectiveSlots,
        assignmentsByTrainId,
        draftsByTrainId,
        trainById,
        lpById,
        alpById,
      });

      const skipSuffix =
        autoSkipped > 0
          ? ` · ${autoSkipped} skipped${skipBreakdown ? ` (${skipBreakdown})` : ''}`
          : '';

      if (ops.length === 0) {
        if (autoMatched > 0) {
          toast.success(
            `Auto-Drafted ${autoMatched} train${autoMatched === 1 ? '' : 's'} from links${skipSuffix} — review on the Assignments page`,
          );
        } else {
          toast.info(
            `Nothing to draft — every train is already assigned or drafted${skipSuffix}`,
          );
        }
        resetPlan();
        return;
      }

      const results = await Promise.allSettled(
        ops.map((op) => {
          if (op.kind === 'upsert') return assignmentDraftsApi.upsert(op.draft);
          return assignmentDraftsApi.remove(op.trainId, op.runDate);
        }),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      const autoPrefix =
        autoMatched > 0
          ? `Auto-Drafted ${autoMatched} from links · `
          : '';
      if (failed === 0) {
        toast.success(
          `${autoPrefix}${ok} edit${ok === 1 ? '' : 's'} synced${skipSuffix} — review on the Assignments page`,
        );
        resetPlan();
        refetch();
      } else {
        // eslint-disable-next-line no-console
        console.error('[LinksPage] sync had failures', { results, ops });
        toast.error(`${autoPrefix}${ok} synced, ${failed} failed — see console for details`);
        refetch();
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? describeApiError(e) : (e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Links"
        subtitle="Duty rotations resolved for the selected operator date."
        action={
          <div className="links-page__head-actions">
            <Button
              variant="primary"
              onClick={syncPlanToDrafts}
              disabled={syncing}
              title="Stage drafts for every train running today from active links, then apply any local edits on top."
            >
              {syncing
                ? 'Auto-drafting…'
                : `Auto-Draft from links${isDirty ? ` (+${Object.keys(plan.slots).length})` : ''}`}
            </Button>
            <Button
              variant="secondary"
              onClick={resetPlan}
              disabled={syncing || !isDirty}
            >
              Reset to rotation
            </Button>
            <Button
              variant="secondary"
              onClick={() => setManageOpen((v) => !v)}
              aria-expanded={manageOpen}
            >
              {manageOpen ? 'Hide manage' : 'Manage links'}
            </Button>
            <Button variant="secondary" onClick={() => setAddOpen(true)}>
              + Add link
            </Button>
          </div>
        }
      />

      {error ? (
        <Banner tone="error" title="Couldn't load links" action={{ label: 'Retry', onClick: refetch }}>
          {error}
        </Banner>
      ) : null}

      {sorted === null && !error ? (
        <SkeletonRows rows={6} columns={4} />
      ) : sorted && sorted.length === 0 ? (
        <EmptyState
          icon="🔗"
          title="No links yet"
          description="Define your first duty rotation to seed the auto-draft workflow."
          action={{ label: '+ Add link', onClick: () => setAddOpen(true) }}
        />
      ) : sorted ? (
        <LinksBoard
          date={asOfDate}
          links={sorted}
          refreshTick={tick}
          plan={plan}
          setSlot={setSlot}
          removeSlot={removeSlot}
          vacateCrewFromPlan={vacateCrewFromPlan}
          hidePrCrew={hidePrCrew}
          setPrSlot={setPrSlot}
          removePrSlot={removePrSlot}
        />
      ) : null}

      {manageOpen && sorted ? (
        <div className="links-page__body">
          <div className="links-page__list">
            <LinkTable
              rows={sorted}
              selectedId={selectedId}
              onSelect={(r) => setSelectedId(r.id === selectedId ? null : r.id)}
              onEdit={setEditing}
              onArchive={setArchiving}
            />
          </div>

          {selectedLink ? (
            <MembershipsPanel
              link={selectedLink}
              asOfDate={asOfDate}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      ) : null}

      <AddLinkModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          toast.success('Link added');
          refetch();
        }}
      />

      <EditLinkModal
        row={editing}
        onClose={() => setEditing(null)}
        onUpdated={() => {
          setEditing(null);
          toast.success('Link updated');
          refetch();
        }}
      />

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this link?"
        body={
          archiving
            ? `${archiving.name} will be hidden from the list. Existing memberships remain archived too. This action is reversible only by re-creating.`
            : ''
        }
        confirmLabel="Archive"
        destructive
        pending={archivePending}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
    </>
  );
}

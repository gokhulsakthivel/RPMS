// `LeavesPage` — the Leaves tab (design.md §9.5).
//
// Shows every active (non-archived) leave window as one row. Sorted by
// `fromDate` descending so the newest entries surface first; ties broken
// by crew name. Add/Edit modals + Archive confirm dialog mirror the
// Trains/Crew pages.
//
// Important: the page is **date-independent** — leaves are calendar-day
// windows, not anchored to any single selected date. The shell's
// DatePicker remains visible (it drives the Summary cards strip), but
// this page ignores it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, leaves as leavesApi } from '../lib/api';
import { describeApiError } from '../lib/errors';
import type { LeaveRow } from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AddLeaveModal } from '../components/leaves/AddLeaveModal';
import { EditLeaveModal } from '../components/leaves/EditLeaveModal';
import { LeaveTable } from '../components/leaves/LeaveTable';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';
import { ConfirmDialog } from '../components/overlay/ConfirmDialog';
import { Button } from '../components/primitives/Button';

export function LeavesPage() {
  const toast = useToast();

  const [rows, setRows] = useState<LeaveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveRow | null>(null);
  const [archiving, setArchiving] = useState<LeaveRow | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    leavesApi
      .list()
      .then((data) => {
        if (cancelled) return;
        setRows(data);
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
  }, [tick]);

  // Sort: newest fromDate first, then by crew name (case-insensitive).
  // Lex compare on YYYY-MM-DD is timezone-safe.
  const sorted = useMemo<LeaveRow[] | null>(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) => {
      if (a.fromDate !== b.fromDate) return a.fromDate < b.fromDate ? 1 : -1;
      return a.crewName.localeCompare(b.crewName, undefined, {
        sensitivity: 'base',
      });
    });
  }, [rows]);

  async function confirmArchive() {
    if (!archiving) return;
    setArchivePending(true);
    try {
      await leavesApi.archive(archiving.id);
      toast.success(`Archived leave for ${archiving.crewName}`);
      setArchiving(null);
      refetch();
      refreshSummary();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? describeApiError(e) : (e as Error).message,
      );
    } finally {
      setArchivePending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Leaves"
        subtitle="Sick, planned leave, and training windows. Crew on leave for a date are blocked from assignments on that date."
        action={
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            + Add leave
          </Button>
        }
      />

      {error ? (
        <Banner
          tone="error"
          title="Couldn't load leaves"
          action={{ label: 'Retry', onClick: refetch }}
        >
          {error}
        </Banner>
      ) : null}

      {sorted === null && !error ? (
        <SkeletonRows rows={6} columns={6} />
      ) : sorted && sorted.length === 0 ? (
        <EmptyState
          icon="🌴"
          title="No active leaves"
          description="Click + Add leave to record a sick, planned-leave, or training window for a crew member."
          action={{ label: '+ Add leave', onClick: () => setAddOpen(true) }}
        />
      ) : sorted ? (
        <LeaveTable
          rows={sorted}
          onEdit={setEditing}
          onArchive={setArchiving}
        />
      ) : null}

      <AddLeaveModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          toast.success('Leave added');
          refetch();
          refreshSummary();
        }}
      />

      <EditLeaveModal
        row={editing}
        onClose={() => setEditing(null)}
        onUpdated={() => {
          setEditing(null);
          toast.success('Leave updated');
          refetch();
          refreshSummary();
        }}
      />

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this leave?"
        body={
          archiving
            ? `Leave for ${archiving.crewRole} · ${archiving.crewName} (${archiving.fromDate} → ${archiving.toDate}) will be hidden. Past records remain visible for audit.`
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

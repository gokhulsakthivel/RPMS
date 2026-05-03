// `TrainsPage` — list of trains for the selected date (design.md §9.1).
//
// Wires:
//   - `trains.list(selectedDate)` for the table.
//   - `AddTrainModal` / `EditTrainModal` for create / update.
//   - `ConfirmDialog` for archive (HLD §4.8 — soft, never hard).
//
// After every successful mutation we (a) refetch the list, (b) bump the
// summary strip via `refreshSummary()`, and (c) toast the result.

import { useCallback, useEffect, useState } from 'react';
import { ApiError, trains as trainsApi } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type { TrainWithAssignment } from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';
import { ConfirmDialog } from '../components/overlay/ConfirmDialog';
import { Button } from '../components/primitives/Button';
import { AddTrainModal } from '../components/trains/AddTrainModal';
import { EditTrainModal } from '../components/trains/EditTrainModal';
import { TrainTable } from '../components/trains/TrainTable';

export function TrainsPage() {
  const { selectedDate } = useSelectedDate();
  const toast = useToast();

  const [rows, setRows] = useState<TrainWithAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<TrainWithAssignment | null>(null);
  const [archiving, setArchiving] = useState<TrainWithAssignment | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows(null);
    trainsApi
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

  async function confirmArchive() {
    if (!archiving) return;
    setArchivePending(true);
    try {
      await trainsApi.archive(archiving.id);
      toast.success(`Archived ${archiving.number} · ${archiving.name}`);
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
        title="Trains"
        subtitle={`Departing on the selected date (${selectedDate}).`}
        action={
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            + Add train
          </Button>
        }
      />

      {error ? (
        <Banner
          tone="error"
          title="Couldn't load trains"
          action={{ label: 'Retry', onClick: refetch }}
        >
          {error}
        </Banner>
      ) : null}

      {rows === null && !error ? (
        <SkeletonRows rows={5} columns={9} />
      ) : rows && rows.length === 0 ? (
        <EmptyState
          icon="🚂"
          title="No trains for this date yet"
          description="Click + Add train to schedule the first one."
          action={{ label: '+ Add train', onClick: () => setAddOpen(true) }}
        />
      ) : rows ? (
        <TrainTable
          rows={rows}
          onEdit={setEditing}
          onArchive={setArchiving}
        />
      ) : null}

      <AddTrainModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          toast.success('Train created');
          refetch();
          refreshSummary();
        }}
      />

      <EditTrainModal
        train={editing}
        onClose={() => setEditing(null)}
        onUpdated={() => {
          setEditing(null);
          toast.success('Train updated');
          refetch();
          refreshSummary();
        }}
      />

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this train?"
        body={
          archiving
            ? `${archiving.number} · ${archiving.name} will be hidden from the active lists. Past assignments referencing it remain visible for audit.`
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

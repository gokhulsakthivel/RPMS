// `CrewPage` — unified LP + ALP roster table (design.md §9.2).
//
// Wires:
//   - `locoPilots.list` + `assistantLocoPilots.list` concurrently for rows.
//   - Sorts the combined list by name (case-insensitive) so LPs and ALPs
//     interleave per design.md §9.2.
//   - `AddCrewModal` / `EditCrewModal` for create / update (the latter
//     exposes the `lastSignOffTime` manual override).
//   - `ConfirmDialog` for archive — soft, copy reads "Archive".

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpApi,
  locoPilots as lpApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type { CrewRow } from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AddCrewModal } from '../components/crew/AddCrewModal';
import { CrewTable } from '../components/crew/CrewTable';
import { EditCrewModal } from '../components/crew/EditCrewModal';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';
import { ConfirmDialog } from '../components/overlay/ConfirmDialog';
import { Button } from '../components/primitives/Button';

export function CrewPage() {
  const { selectedDate } = useSelectedDate();
  const toast = useToast();

  const [lps, setLps] = useState<CrewRow[] | null>(null);
  const [alps, setAlps] = useState<CrewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CrewRow | null>(null);
  const [archiving, setArchiving] = useState<CrewRow | null>(null);
  const [archivePending, setArchivePending] = useState(false);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLps(null);
    setAlps(null);
    Promise.all([
      lpApi.list(selectedDate),
      alpApi.list(selectedDate),
    ])
      .then(([lpRows, alpRows]) => {
        if (cancelled) return;
        setLps(lpRows);
        setAlps(alpRows);
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

  // Combined + alphabetised view (design.md §9.2).
  const rows = useMemo<CrewRow[] | null>(() => {
    if (!lps || !alps) return null;
    return [...lps, ...alps].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [lps, alps]);

  async function confirmArchive() {
    if (!archiving) return;
    setArchivePending(true);
    try {
      if (archiving.kind === 'LP') {
        await lpApi.archive(archiving.id);
      } else {
        await alpApi.archive(archiving.id);
      }
      toast.success(`Archived ${archiving.kind} · ${archiving.name}`);
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
        title="Crew roster"
        subtitle="Status and rest are computed against the start of the selected day in IST."
        action={
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            + Add crew
          </Button>
        }
      />

      {error ? (
        <Banner
          tone="error"
          title="Couldn't load crew"
          action={{ label: 'Retry', onClick: refetch }}
        >
          {error}
        </Banner>
      ) : null}

      {rows === null && !error ? (
        <SkeletonRows rows={6} columns={7} />
      ) : rows && rows.length === 0 ? (
        <EmptyState
          icon="🧑‍✈️"
          title="No crew on the roster yet"
          description="Click + Add crew to add your first Loco Pilot or Assistant."
          action={{ label: '+ Add crew', onClick: () => setAddOpen(true) }}
        />
      ) : rows ? (
        <CrewTable
          rows={rows}
          onEdit={setEditing}
          onArchive={setArchiving}
        />
      ) : null}

      <AddCrewModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          toast.success('Crew member added');
          refetch();
          refreshSummary();
        }}
      />

      <EditCrewModal
        row={editing}
        onClose={() => setEditing(null)}
        onUpdated={() => {
          setEditing(null);
          toast.success('Crew updated');
          refetch();
          refreshSummary();
        }}
      />

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this crew member?"
        body={
          archiving
            ? `${archiving.kind} · ${archiving.name} will be hidden from active assignments. Past records remain visible for audit.`
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

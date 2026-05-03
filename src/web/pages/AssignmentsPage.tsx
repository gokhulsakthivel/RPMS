// `AssignmentsPage` — per-train assignments view (design.md §9.3).
//
// Wires:
//   - `assignments.list(selectedDate)` for the table.
//   - `AssignCrewModal` (the heart of the app) for the assign action.
//   - Each successful assign refetches the list and bumps the summary.

import { useCallback, useEffect, useState } from 'react';
import { ApiError, assignments as assignmentsApi } from '../lib/api';
import { describeApiError } from '../lib/errors';
import { useSelectedDate } from '../lib/useSelectedDate';
import type { AssignmentRow } from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { refreshSummary } from '../components/chrome/SummaryCards';
import { AssignCrewModal } from '../components/assignments/AssignCrewModal';
import { AssignmentTable } from '../components/assignments/AssignmentTable';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { useToast } from '../components/feedback/Toast';

export function AssignmentsPage() {
  const { selectedDate } = useSelectedDate();
  const toast = useToast();

  const [rows, setRows] = useState<AssignmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<AssignmentRow | null>(null);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

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

  return (
    <>
      <PageHeader
        title="Assignments"
        subtitle={`Trains departing on ${selectedDate}.`}
      />

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
        <AssignmentTable rows={rows} onAssign={setTarget} />
      ) : null}

      <AssignCrewModal
        target={target}
        onClose={() => setTarget(null)}
        onAssigned={() => {
          const t = target;
          setTarget(null);
          if (t) {
            toast.success(`Crew assigned to ${t.trainNumber}`);
          }
          refetch();
          refreshSummary();
        }}
      />
    </>
  );
}

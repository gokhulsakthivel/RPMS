// `SummaryCards` — strip of four StatCards under the header
// (components.md §3 / design.md §2.1, §9.4).
//
// Owns its own data fetch. Re-fetches whenever the selected date changes
// or when any caller fires `refreshSummary()` after a mutation.

import { useEffect, useState } from 'react';
import { ApiError, summary as summaryApi } from '../../lib/api';
import { useSelectedDate } from '../../lib/useSelectedDate';
import { StatCard } from './StatCard';

interface Snapshot {
  totalTrains: number;
  unassignedTrains: number;
  availableCrew: number;
  restingCrew: number;
}

const REFRESH_EVENT = 'rpms:summary:refresh';

/**
 * Fire from anywhere to make the strip refetch (e.g., after a successful
 * Add Train, Assign Crew, etc.). A window event is used instead of a
 * Context bus so call sites don't need to import a hook.
 */
export function refreshSummary(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
  }
}

export function SummaryCards() {
  const { selectedDate } = useSelectedDate();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Bumps when refreshSummary() fires; combined with selectedDate to
  // re-trigger the fetch effect.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const handler = () => setTick((n) => n + 1);
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    summaryApi
      .get(selectedDate)
      .then((s) => {
        if (cancelled) return;
        setSnap({
          totalTrains: s.totalTrains,
          unassignedTrains: s.unassignedTrains,
          availableCrew: s.availableCrew,
          restingCrew: s.restingCrew,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.code : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, tick]);

  return (
    <section className="summary-cards" aria-label="Summary">
      <StatCard label="Total trains" value={snap?.totalTrains ?? null} />
      <StatCard
        label="Unassigned trains"
        value={snap?.unassignedTrains ?? null}
        emphasis={snap && snap.unassignedTrains > 0 ? 'warning' : 'default'}
      />
      <StatCard label="Available crew" value={snap?.availableCrew ?? null} />
      <StatCard label="Resting crew" value={snap?.restingCrew ?? null} />
      {err ? (
        <p className="summary-cards__err" role="alert">
          Couldn't load summary: {err}
        </p>
      ) : null}
    </section>
  );
}

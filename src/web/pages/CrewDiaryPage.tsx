// `CrewDiaryPage` — per-crew month-wise assignment listing (design.md §9.6).
//
// Layout:
//   ┌──────────────── PageHeader ───────────────────────────────────┐
//   │  Crew Diary                                                   │
//   ├──────────────── 240px sidebar ───┬─────── main pane ──────────┤
//   │  Crew roster (LP + ALP combined) │  Month picker (◂ May 2026 ▸)│
//   │  ─ search box                    │  Calendar grid (clickable)  │
//   │  ─ scrollable list               │  Diary entry table          │
//   └──────────────────────────────────┴────────────────────────────┘
//
// Every interaction issues a single `crewDiary.get(crewId, month)` call.
// The roster itself comes from the existing `loco-pilots` and
// `assistant-loco-pilots` endpoints — we deliberately re-use those rather
// than introducing a fourth roster endpoint.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  assistantLocoPilots as alpApi,
  crewDiary as diaryApi,
  locoPilots as lpApi,
} from '../lib/api';
import { describeApiError } from '../lib/errors';
import { formatIstDate, formatIstTime } from '../lib/time';
import type {
  CrewDiaryEntry,
  CrewDiaryResponse,
  CrewRow,
} from '../../shared/schemas';
import { PageHeader } from '../components/PageHeader';
import { Banner } from '../components/feedback/Banner';
import { EmptyState } from '../components/feedback/EmptyState';
import { SkeletonRows } from '../components/feedback/SkeletonRows';
import { Button } from '../components/primitives/Button';

// ---------------------------------------------------------------------------
// Date helpers (IST month math)
// ---------------------------------------------------------------------------

/** Returns the IST `YYYY-MM` containing today. */
function currentMonthIst(): string {
  // `Intl.DateTimeFormat` with the IST timezone — same approach as
  // `todayIstIsoDate` in src/shared/time.ts. We assemble the parts ourselves
  // to keep the helper tiny and dependency-free.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  });
  // en-CA renders "2026-05" — exactly the wire shape we want.
  return fmt.format(new Date());
}

/** Step a `YYYY-MM` string forward (or backward) by `delta` whole months. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((s) => parseInt(s, 10));
  if (!y || !m || Number.isNaN(y) || Number.isNaN(m)) return month;
  // JS Date math handles wrap-around for us.
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  const ny = date.getUTCFullYear();
  const nm = date.getUTCMonth() + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Pretty-printer for the month chip — "May 2026". */
function formatMonthLabel(month: string): string {
  const [y, m] = month.split('-').map((s) => parseInt(s, 10));
  if (!y || !m) return month;
  const date = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'long',
  }).format(date);
}

/**
 * One cell in the month calendar grid. `null` slots in the surrounding array
 * are leading/trailing pad cells (prev/next month) so the 7-column weekday
 * alignment stays correct.
 */
interface CalendarCell {
  isoDate: string;
  /** 1–31 — used as the cell label. */
  dayOfMonth: number;
}

/**
 * Build the month grid for `YYYY-MM`. Always 6 weeks (42 cells) so the grid
 * doesn't reflow between 4-/5-/6-week months. Pad cells are `null`; real
 * days carry their `YYYY-MM-DD` so the page can look them up directly in
 * `entriesByDate`.
 */
function buildCalendar(month: string): Array<CalendarCell | null> {
  const [y, m] = month.split('-').map((s) => parseInt(s, 10));
  if (!y || !m) return Array(42).fill(null);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstWeekday = first.getUTCDay(); // 0 = Sunday
  const last = new Date(Date.UTC(y, m, 0));
  const daysInMonth = last.getUTCDate();

  const cells: Array<CalendarCell | null> = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push({
      isoDate: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      dayOfMonth: d,
    });
  }
  while (cells.length < 42) cells.push(null);
  return cells;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CrewDiaryPage() {
  // ----- crew roster (combined LP + ALP) ----------------------------------
  const [crewList, setCrewList] = useState<CrewRow[] | null>(null);
  const [crewError, setCrewError] = useState<string | null>(null);
  const [rosterTick, setRosterTick] = useState(0);

  const refetchRoster = useCallback(() => setRosterTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setCrewError(null);
    setCrewList(null);
    Promise.all([lpApi.list(currentDateIst()), alpApi.list(currentDateIst())])
      .then(([lps, alps]) => {
        if (cancelled) return;
        const merged = [...lps, ...alps].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
        setCrewList(merged);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCrewError(
          e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [rosterTick]);

  // ----- selection state ---------------------------------------------------
  const [selectedCrewId, setSelectedCrewId] = useState<string | null>(null);
  const [month, setMonth] = useState<string>(() => currentMonthIst());
  const [search, setSearch] = useState('');

  // Auto-select the first crew member once the roster lands so the right
  // pane has something to render on first paint.
  useEffect(() => {
    if (selectedCrewId === null && crewList && crewList.length > 0) {
      const first = crewList[0];
      if (first) setSelectedCrewId(first.id);
    }
  }, [crewList, selectedCrewId]);

  // ----- diary fetch (per crew + month) -----------------------------------
  const [diary, setDiary] = useState<CrewDiaryResponse | null>(null);
  const [diaryError, setDiaryError] = useState<string | null>(null);
  const [diaryTick, setDiaryTick] = useState(0);

  const refetchDiary = useCallback(
    () => setDiaryTick((n) => n + 1),
    [],
  );

  useEffect(() => {
    if (!selectedCrewId) {
      setDiary(null);
      return;
    }
    let cancelled = false;
    setDiaryError(null);
    setDiary(null);
    diaryApi
      .get(selectedCrewId, month)
      .then((data) => {
        if (!cancelled) setDiary(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDiaryError(
          e instanceof ApiError ? describeApiError(e) : (e as Error).message,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCrewId, month, diaryTick]);

  // ----- derived: filter the roster against the search box ----------------
  const filteredCrew = useMemo<CrewRow[] | null>(() => {
    if (!crewList) return null;
    const q = search.trim().toLowerCase();
    if (!q) return crewList;
    return crewList.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.kind.toLowerCase().includes(q),
    );
  }, [crewList, search]);

  // ----- derived: index entries by run-date for the calendar grid ---------
  const entriesByDate = useMemo<Map<string, CrewDiaryEntry[]>>(() => {
    const map = new Map<string, CrewDiaryEntry[]>();
    if (!diary) return map;
    for (const a of diary.entries) {
      const list = map.get(a.runDate) ?? [];
      list.push(a);
      map.set(a.runDate, list);
    }
    return map;
  }, [diary]);

  const calendarCells = useMemo(() => buildCalendar(month), [month]);

  return (
    <>
      <PageHeader
        title="Crew Diary"
        subtitle="Pick a crew member and a month to see every run they worked."
      />

      <div className="crew-diary-layout">
        {/* ----- Sidebar: crew roster ---------------------------------- */}
        <aside className="crew-diary-sidebar" aria-label="Crew roster">
          <div className="crew-diary-sidebar__header">
            <input
              className="crew-diary-sidebar__search"
              type="search"
              placeholder="Search crew…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Filter crew by name or role"
            />
          </div>

          {crewError ? (
            <Banner
              tone="error"
              title="Couldn't load crew"
              action={{ label: 'Retry', onClick: refetchRoster }}
            >
              {crewError}
            </Banner>
          ) : crewList === null ? (
            <SkeletonRows rows={8} columns={1} />
          ) : filteredCrew && filteredCrew.length === 0 ? (
            <p className="crew-diary-sidebar__empty">
              No crew match “{search}”.
            </p>
          ) : (
            <ul className="crew-diary-sidebar__list" role="listbox">
              {(filteredCrew ?? []).map((c) => {
                const isSelected = c.id === selectedCrewId;
                return (
                  <li key={`${c.kind}-${c.id}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={
                        'crew-diary-sidebar__item' +
                        (isSelected ? ' crew-diary-sidebar__item--selected' : '')
                      }
                      onClick={() => setSelectedCrewId(c.id)}
                    >
                      <span className="crew-diary-sidebar__name">{c.name}</span>
                      <span
                        className={`crew-diary-sidebar__kind crew-diary-sidebar__kind--${c.kind.toLowerCase()}`}
                      >
                        {c.kind}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* ----- Main pane: month nav, calendar, entry list ------------ */}
        <section className="crew-diary-main">
          <div className="crew-diary-month-nav" role="group" aria-label="Month">
            <Button
              variant="secondary"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              aria-label="Previous month"
            >
              ◂
            </Button>
            <div className="crew-diary-month-nav__label" aria-live="polite">
              {formatMonthLabel(month)}
            </div>
            <Button
              variant="secondary"
              onClick={() => setMonth((m) => shiftMonth(m, +1))}
              aria-label="Next month"
            >
              ▸
            </Button>
            <Button
              variant="secondary"
              onClick={() => setMonth(currentMonthIst())}
            >
              Today
            </Button>
          </div>

          {!selectedCrewId ? (
            <EmptyState
              icon="📅"
              title="Pick a crew member"
              description="Select someone from the list to see their month."
            />
          ) : diaryError ? (
            <Banner
              tone="error"
              title="Couldn't load diary"
              action={{ label: 'Retry', onClick: refetchDiary }}
            >
              {diaryError}
            </Banner>
          ) : diary === null ? (
            <SkeletonRows rows={6} columns={5} />
          ) : (
            <>
              <CalendarGrid
                cells={calendarCells}
                entriesByDate={entriesByDate}
              />
              <EntryList diary={diary} />
            </>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// CalendarGrid — 6×7 month view. Renders every day so weekday alignment
// stays correct, but only days with committed assignments carry a badge.
// Drafts never appear here: the wire payload from `/api/crew-diary` is
// sourced from the assignments repo, not the drafts cart, so a staged-but-
// not-committed pick is invisible to this view by construction.
// ---------------------------------------------------------------------------

function CalendarGrid({
  cells,
  entriesByDate,
}: {
  cells: Array<CalendarCell | null>;
  entriesByDate: ReadonlyMap<string, CrewDiaryEntry[]>;
}) {
  const weekdayLabels: ReadonlyArray<string> = [
    'Sun',
    'Mon',
    'Tue',
    'Wed',
    'Thu',
    'Fri',
    'Sat',
  ];
  return (
    <div className="crew-diary-calendar" role="grid" aria-label="Month calendar">
      <div className="crew-diary-calendar__weekdays" role="row">
        {weekdayLabels.map((label) => (
          <div
            key={label}
            className="crew-diary-calendar__weekday"
            role="columnheader"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="crew-diary-calendar__grid">
        {cells.map((cell, idx) => {
          if (!cell) {
            return (
              <div
                key={`pad-${idx}`}
                className="crew-diary-calendar__cell crew-diary-calendar__cell--pad"
                aria-hidden="true"
              />
            );
          }
          const entries = entriesByDate.get(cell.isoDate) ?? [];
          const hasEntries = entries.length > 0;
          return (
            <div
              key={cell.isoDate}
              className={
                'crew-diary-calendar__cell' +
                (hasEntries
                  ? ' crew-diary-calendar__cell--has'
                  : '')
              }
              role="gridcell"
              aria-label={`${cell.isoDate}${hasEntries ? `, ${entries.length} assignment(s)` : ''}`}
            >
              <div className="crew-diary-calendar__day">{cell.dayOfMonth}</div>
              {entries.map((a) => (
                <div
                  key={a.assignmentId}
                  className="crew-diary-calendar__badge"
                  title={`${a.trainNumber} · ${a.trainName}\n${a.fromStation} → ${a.toStation}`}
                >
                  <span className="crew-diary-calendar__badge-num">
                    #{a.trainNumber}
                  </span>
                  <span className="crew-diary-calendar__badge-route">
                    {a.fromStation} → {a.toStation}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntryList — full table beneath the calendar
// ---------------------------------------------------------------------------

function EntryList({ diary }: { diary: CrewDiaryResponse }) {
  if (diary.entries.length === 0) {
    return (
      <EmptyState
        icon="🪧"
        title={`No runs for ${diary.crew.name} this month`}
        description="They were either off-duty, on leave, or assigned in another month."
      />
    );
  }
  return (
    <div className="data-table crew-diary-table">
      <table>
        <caption className="data-table__caption">
          {diary.entries.length} run
          {diary.entries.length === 1 ? '' : 's'} —{' '}
          {diary.crew.name} ({diary.crew.kind})
        </caption>
        <thead>
          <tr>
            <th className="data-table__th data-table__th--left">Date</th>
            <th className="data-table__th data-table__th--left">Train</th>
            <th className="data-table__th data-table__th--left">From</th>
            <th className="data-table__th data-table__th--left">To</th>
            <th className="data-table__th data-table__th--left">Departure</th>
            <th className="data-table__th data-table__th--left">Sign-off</th>
            <th className="data-table__th data-table__th--left">Role</th>
          </tr>
        </thead>
        <tbody>
          {diary.entries.map((a) => (
            <tr key={a.assignmentId}>
              <td className="data-table__td data-table__td--left">
                {formatIstDate(new Date(`${a.runDate}T00:00:00+05:30`))}
              </td>
              <td className="data-table__td data-table__td--left">
                <div className="crew-diary-table__train-num">
                  #{a.trainNumber}
                </div>
                <div className="crew-diary-table__train-name">
                  {a.trainName}
                </div>
              </td>
              <td className="data-table__td data-table__td--left">
                {a.fromStation}
              </td>
              <td className="data-table__td data-table__td--left">
                {a.toStation}
              </td>
              <td className="data-table__td data-table__td--left">
                {formatIstTime(new Date(a.departureTime))}
              </td>
              <td className="data-table__td data-table__td--left">
                {formatIstTime(new Date(a.signOffTime))}
              </td>
              <td className="data-table__td data-table__td--left">
                <span
                  className={`crew-diary-sidebar__kind crew-diary-sidebar__kind--${a.servedAs.toLowerCase()}`}
                >
                  {a.servedAs}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny helper: fetch the crew lists with *some* date — they don't change with
// the date param, but the existing list endpoints require one. We pass
// today's IST date so the rest projection on the wire is sensible if anyone
// inspects the response.
// ---------------------------------------------------------------------------

function currentDateIst(): string {
  // Same shape as `todayIstIsoDate` from shared/time, computed inline so this
  // page doesn't need to import the helper just for its date-string form.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

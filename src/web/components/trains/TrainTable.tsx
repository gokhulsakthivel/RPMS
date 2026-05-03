// `TrainTable` — the table on the Trains tab (components.md §8 / design.md §9.1).
//
// 9 columns: Train (number + onward route) · Name · Type · Runs on
// · Departure (IST) · Inward (number + route) · Inward arrival (IST)
// · Currently assigned crew · Actions.
//
// "Train" and "Inward" are stacked cells — the prominent train number sits on
// top, the muted from→to route sits below. This keeps the header row narrow
// without losing either piece of information at a glance.
//
// M9 — trains carry a recurring weekly schedule. The page passes rows for one
// selected IST date, so each row's `departureTime` / `inwardArrivalTime` are
// already the materialized UTC instants for that date. The "Runs on" column
// renders the abstract weekly pattern (S M T W T F S) so the operator can see
// at a glance which other days the train also runs.
//
// MEMU/DEMU rows hide the ALP chip entirely (design.md §9.1) — the cell
// renders only the LP chip. ALP-eligible trains with no ALP show a muted
// "—" placeholder so the column stays aligned.

import type { TrainWithAssignment } from '../../../shared/schemas';
import { DayOfWeek, TrainType } from '../../../domain/types';
import { formatIstDate, formatIstTime } from '../../lib/time';
import { Chip } from '../primitives/Chip';
import { IconButton } from '../primitives/IconButton';
import { Column, DataTable } from '../data/DataTable';
import { TrainTypeBadge } from './TrainTypeBadge';

export interface TrainTableProps {
  rows: ReadonlyArray<TrainWithAssignment>;
  onEdit: (row: TrainWithAssignment) => void;
  onArchive: (row: TrainWithAssignment) => void;
  /** Optional empty-state node from the page. */
  emptyState?: React.ReactNode;
}

export function TrainTable({
  rows,
  onEdit,
  onArchive,
  emptyState,
}: TrainTableProps) {
  const columns: ReadonlyArray<Column<TrainWithAssignment>> = [
    {
      key: 'train',
      header: 'Train',
      cell: (r) => (
        <StackedNumberRoute
          number={r.number}
          fromStation={r.onwardFromStation}
          toStation={r.onwardToStation}
        />
      ),
    },
    {
      key: 'name',
      header: 'Name',
      cell: (r) => <span className="train-table__name">{r.name}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (r) => <TrainTypeBadge type={r.type} />,
    },
    {
      key: 'runsOn',
      header: 'Runs on',
      cell: (r) => <RunsOnCell runsOnDays={r.runsOnDays} />,
    },
    {
      key: 'departure',
      header: 'Departure',
      cell: (r) => <StackedTime iso={r.departureTime} />,
    },
    {
      key: 'inward',
      header: 'Inward',
      cell: (r) => (
        <StackedNumberRoute
          number={r.inwardTrainNumber}
          fromStation={r.inwardFromStation}
          toStation={r.inwardToStation}
        />
      ),
    },
    {
      key: 'inwardArrival',
      header: 'Inward arrival',
      cell: (r) => <StackedTime iso={r.inwardArrivalTime} />,
    },
    {
      key: 'crew',
      header: 'Currently assigned crew',
      cell: (r) => <CrewCell row={r} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (r) => (
        <div className="train-table__actions">
          <IconButton
            aria-label={`Edit train ${r.number}`}
            onClick={() => onEdit(r)}
          >
            ✎
          </IconButton>
          <IconButton
            aria-label={`Archive train ${r.number}`}
            onClick={() => onArchive(r)}
          >
            🗑
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      emptyState={emptyState}
    />
  );
}

// ---------------------------------------------------------------------------
// Stacked date+time cell — date on top, time on a second muted line. Improves
// vertical rhythm in the Departure / Inward arrival columns when rows are
// dense. The semantic `<time>` element keeps a single ISO `datetime` attr
// for screen readers and copy-paste.
// ---------------------------------------------------------------------------

function StackedTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <time className="train-table__time" dateTime={iso}>
      <span className="train-table__time-date">{formatIstDate(d)}</span>
      <span className="train-table__time-clock">{formatIstTime(d)}</span>
    </time>
  );
}

// ---------------------------------------------------------------------------
// Stacked train-number + route cell — used for both the onward (Train) and
// the return (Inward) columns so they share visual rhythm. Train number on
// top in full-strength text; from→to route on a muted second line.
// ---------------------------------------------------------------------------

function StackedNumberRoute({
  number,
  fromStation,
  toStation,
}: {
  number: string;
  fromStation: string;
  toStation: string;
}) {
  return (
    <span className="train-table__num-route">
      <span className="train-table__num">{number}</span>
      <span className="train-table__num-route-route">
        {fromStation} <span className="train-table__arrow">→</span> {toStation}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Runs-on chip row — Sun..Sat. Days the train runs are highlighted; off days
// render as a muted dot so the row width stays constant across rows.
// ---------------------------------------------------------------------------

const DAY_ORDER: ReadonlyArray<DayOfWeek> = [
  DayOfWeek.SUN,
  DayOfWeek.MON,
  DayOfWeek.TUE,
  DayOfWeek.WED,
  DayOfWeek.THU,
  DayOfWeek.FRI,
  DayOfWeek.SAT,
];

const DAY_INITIAL: Record<DayOfWeek, string> = {
  [DayOfWeek.SUN]: 'S',
  [DayOfWeek.MON]: 'M',
  [DayOfWeek.TUE]: 'T',
  [DayOfWeek.WED]: 'W',
  [DayOfWeek.THU]: 'T',
  [DayOfWeek.FRI]: 'F',
  [DayOfWeek.SAT]: 'S',
};

const DAY_LABEL_FULL: Record<DayOfWeek, string> = {
  [DayOfWeek.SUN]: 'Sunday',
  [DayOfWeek.MON]: 'Monday',
  [DayOfWeek.TUE]: 'Tuesday',
  [DayOfWeek.WED]: 'Wednesday',
  [DayOfWeek.THU]: 'Thursday',
  [DayOfWeek.FRI]: 'Friday',
  [DayOfWeek.SAT]: 'Saturday',
};

function RunsOnCell({ runsOnDays }: { runsOnDays: ReadonlyArray<DayOfWeek> }) {
  const set = new Set(runsOnDays);
  const aria = runsOnDays.length === 7
    ? 'Runs daily'
    : `Runs on ${runsOnDays.map((d) => DAY_LABEL_FULL[d]).join(', ')}`;
  return (
    <span className="train-table__runs-on" aria-label={aria}>
      {DAY_ORDER.map((d) => {
        const on = set.has(d);
        return (
          <span
            key={d}
            className={
              on
                ? 'train-table__runs-on-day train-table__runs-on-day--on'
                : 'train-table__runs-on-day train-table__runs-on-day--off'
            }
            aria-hidden="true"
          >
            {on ? DAY_INITIAL[d] : '·'}
          </span>
        );
      })}
    </span>
  );
}

/**
 * "Currently assigned crew" cell. Hides the ALP slot for MEMU/DEMU per
 * design.md §9.1 — not greyed out, _gone_ — so the operator never sees an
 * empty slot they'd be tempted to fill.
 */
function CrewCell({ row }: { row: TrainWithAssignment }) {
  const isMemuOrDemu = row.type === TrainType.MEMU || row.type === TrainType.DEMU;
  return (
    <div className="train-table__crew">
      {row.lp ? (
        <Chip role="LP">{row.lp.name}</Chip>
      ) : (
        <span className="train-table__crew-empty">— LP not assigned</span>
      )}
      {isMemuOrDemu ? null : row.alp && row.alp !== 'NOT_REQUIRED' ? (
        <Chip role="ALP">{row.alp.name}</Chip>
      ) : (
        <span className="train-table__crew-empty">— ALP not assigned</span>
      )}
    </div>
  );
}

// `AssignmentTable` — per-train rows on the Assignments tab
// (components.md §10 / design.md §9.3).
//
// Columns: Train · Type · Departure · LP · ALP · Action.
//
// LP cell:  assigned name, or "Not assigned" in --color-danger.
// ALP cell: assigned name, "Not assigned" red, or "Not required" muted
//           (only on MEMU/DEMU per HLD §4.5).
//
// The "Assign" button only appears when `isAssignable === true` —
// server-computed via the window-overlap rule (HLD §4.6).

import type { AssignmentRow } from '../../../shared/schemas';
import { formatIst } from '../../lib/time';
import { Button } from '../primitives/Button';
import { Column, DataTable } from '../data/DataTable';
import { TrainTypeBadge } from '../trains/TrainTypeBadge';

export interface AssignmentTableProps {
  rows: ReadonlyArray<AssignmentRow>;
  onAssign: (row: AssignmentRow) => void;
  emptyState?: React.ReactNode;
}

export function AssignmentTable({
  rows,
  onAssign,
  emptyState,
}: AssignmentTableProps) {
  const columns: ReadonlyArray<Column<AssignmentRow>> = [
    {
      key: 'train',
      header: 'Train',
      cell: (r) => (
        <div className="assign-table__train">
          <span className="assign-table__num">{r.trainNumber}</span>
          <span className="assign-table__name">{r.trainName}</span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (r) => <TrainTypeBadge type={r.trainType} />,
    },
    {
      key: 'departure',
      header: 'Departure',
      cell: (r) => (
        <time dateTime={r.departureTime} className="assign-table__time">
          {formatIst(new Date(r.departureTime))}
        </time>
      ),
    },
    {
      key: 'lp',
      header: 'LP',
      cell: (r) =>
        r.lp ? (
          <span className="assign-table__crew">{r.lp.name}</span>
        ) : (
          <span className="assign-table__crew assign-table__crew--missing">
            Not assigned
          </span>
        ),
    },
    {
      key: 'alp',
      header: 'ALP',
      cell: (r) => {
        if (r.alp === 'NOT_REQUIRED') {
          return (
            <span className="assign-table__crew assign-table__crew--na">
              Not required
            </span>
          );
        }
        if (r.alp === null) {
          return (
            <span className="assign-table__crew assign-table__crew--missing">
              Not assigned
            </span>
          );
        }
        return <span className="assign-table__crew">{r.alp.name}</span>;
      },
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (r) =>
        r.isAssignable ? (
          <Button variant="secondary" onClick={() => onAssign(r)}>
            Assign
          </Button>
        ) : null,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.trainId}
      emptyState={emptyState}
    />
  );
}

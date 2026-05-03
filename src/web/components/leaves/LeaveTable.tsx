// `LeaveTable` — the table on the Leaves tab (components.md §11 /
// design.md §9.5).
//
// 6 columns: Crew (name + LP/ALP role chip) · Type · From · To · Reason ·
// Actions. Dates are rendered verbatim (`YYYY-MM-DD` IST) — no timezone
// math needed because leaves are calendar-day windows, not instants.
//
// The page filters and sorts the rows; this component is purely a
// projection of `LeaveRow[]` into JSX.

import type { LeaveRow } from '../../../shared/schemas';
import { Chip } from '../primitives/Chip';
import { IconButton } from '../primitives/IconButton';
import { Column, DataTable } from '../data/DataTable';
import { LeaveTypeBadge } from './LeaveTypeBadge';

export interface LeaveTableProps {
  rows: ReadonlyArray<LeaveRow>;
  onEdit: (row: LeaveRow) => void;
  onArchive: (row: LeaveRow) => void;
  /** Optional empty-state node from the page. */
  emptyState?: React.ReactNode;
}

export function LeaveTable({
  rows,
  onEdit,
  onArchive,
  emptyState,
}: LeaveTableProps) {
  const columns: ReadonlyArray<Column<LeaveRow>> = [
    {
      key: 'crew',
      header: 'Crew',
      cell: (r) => (
        <span className="leave-table__crew">
          <Chip role={r.crewRole}>{r.crewName}</Chip>
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (r) => <LeaveTypeBadge type={r.type} />,
    },
    {
      key: 'fromDate',
      header: 'From',
      cell: (r) => (
        <time className="leave-table__date" dateTime={r.fromDate}>
          {r.fromDate}
        </time>
      ),
    },
    {
      key: 'toDate',
      header: 'To',
      cell: (r) => (
        <time className="leave-table__date" dateTime={r.toDate}>
          {r.toDate}
        </time>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (r) =>
        r.reason ? (
          <span className="leave-table__reason">{r.reason}</span>
        ) : (
          <span className="leave-table__reason leave-table__reason--empty">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (r) => (
        <div className="leave-table__actions">
          <IconButton
            aria-label={`Edit leave for ${r.crewName}`}
            onClick={() => onEdit(r)}
          >
            ✎
          </IconButton>
          <IconButton
            aria-label={`Archive leave for ${r.crewName}`}
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

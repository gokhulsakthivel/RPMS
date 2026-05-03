// `CrewTable` — unified LP+ALP table on the Crew tab
// (components.md §9 / design.md §9.2).
//
// 7 columns: Name · Role · Grade · Status · Rest remaining · Eligible for · Actions.
//
// **Employee ID is NOT displayed** (design.md §9.2) — operators identify
// crew by name. The Role column carries the LP/ALP distinction.

import type { CrewRow } from '../../../shared/schemas';
import { Column, DataTable } from '../data/DataTable';
import { RestBar } from '../data/RestBar';
import { IconButton } from '../primitives/IconButton';
import { StatusBadge } from '../primitives/StatusBadge';
import { CrewEligibleForCell } from './CrewEligibleForCell';
import { CrewGradeBadge } from './CrewGradeBadge';

export interface CrewTableProps {
  rows: ReadonlyArray<CrewRow>;
  onEdit: (row: CrewRow) => void;
  onArchive: (row: CrewRow) => void;
  emptyState?: React.ReactNode;
}

export function CrewTable({
  rows,
  onEdit,
  onArchive,
  emptyState,
}: CrewTableProps) {
  const columns: ReadonlyArray<Column<CrewRow>> = [
    {
      key: 'name',
      header: 'Name',
      cell: (r) => <span className="crew-table__name">{r.name}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      cell: (r) => <span className="crew-table__role">{r.kind}</span>,
    },
    {
      key: 'grade',
      header: 'Grade',
      cell: (r) => <CrewGradeBadge grade={r.grade} />,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'rest',
      header: 'Rest remaining',
      cell: (r) => (
        <RestBar
          status={r.status}
          hoursRemaining={r.rest.hoursRemaining}
          neverSignedOff={r.rest.neverSignedOff}
        />
      ),
    },
    {
      key: 'eligibleFor',
      header: 'Eligible for',
      cell: (r) => <CrewEligibleForCell label={r.eligibleForLabel} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="crew-table__actions">
          <IconButton
            aria-label={`Edit ${r.kind} ${r.name}`}
            onClick={() => onEdit(r)}
          >
            ✎
          </IconButton>
          <IconButton
            aria-label={`Archive ${r.kind} ${r.name}`}
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
      // Composite key — server IDs are unique within their kind, but
      // technically `LP_x` and `ALP_x` could collide if someone got cute.
      rowKey={(r) => `${r.kind}:${r.id}`}
      emptyState={emptyState}
    />
  );
}

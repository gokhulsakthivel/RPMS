// `PrAssignmentTable` — Periodic Rest slots on the Assignments tab.
//
// Each row represents one PR position on a Link for the selected runDate.
// Default crew comes from the link rotation; override is per-day operator
// state stored in `data/pr_assignments.csv`.

import type { PrAssignmentRow } from '../../../shared/schemas';
import { Button } from '../primitives/Button';
import { Column, DataTable } from '../data/DataTable';

export interface PrAssignmentTableProps {
  rows: ReadonlyArray<PrAssignmentRow>;
  onEdit: (row: PrAssignmentRow) => void;
  emptyState?: React.ReactNode;
}

export function PrAssignmentTable({
  rows,
  onEdit,
  emptyState,
}: PrAssignmentTableProps) {
  const columns: ReadonlyArray<Column<PrAssignmentRow>> = [
    {
      key: 'link',
      header: 'Link',
      cell: (r) => (
        <div className="assign-table__train">
          <span className="assign-table__num">PR · pos {r.positionNumber}</span>
          <span className="assign-table__name">{r.linkName}</span>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      cell: (r) => <span className="badge badge--muted">{r.crewRole}</span>,
    },
    {
      key: 'default',
      header: 'Default (rotation)',
      cell: (r) =>
        r.defaultCrew ? (
          <span className="assign-table__crew">{r.defaultCrew.name}</span>
        ) : (
          <span className="assign-table__crew assign-table__crew--muted">
            no rotation match
          </span>
        ),
    },
    {
      key: 'assigned',
      header: 'On PR',
      cell: (r) => renderResolvedCell(r),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button variant="text" onClick={() => onEdit(r)}>
          {r.override ? 'Edit' : 'Change'}
        </Button>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.linkId}#${r.positionNumber}`}
      emptyState={emptyState}
    />
  );
}

function renderResolvedCell(r: PrAssignmentRow) {
  if (r.override) {
    if (!r.override.crewId) {
      return (
        <span className="assign-table__crew assign-table__crew--muted">
          No PR today (cleared)
        </span>
      );
    }
    const sameAsDefault =
      r.defaultCrew && r.defaultCrew.id === r.override.crewId;
    return (
      <span className="assign-table__crew">
        {r.override.crewName}
        {!sameAsDefault ? (
          <span className="badge badge--info" style={{ marginLeft: 8 }}>
            override
          </span>
        ) : null}
      </span>
    );
  }
  return r.resolvedCrew ? (
    <span className="assign-table__crew assign-table__crew--muted">
      {r.resolvedCrew.name} <span style={{ opacity: 0.7 }}>(default)</span>
    </span>
  ) : (
    <span className="assign-table__crew assign-table__crew--muted">—</span>
  );
}

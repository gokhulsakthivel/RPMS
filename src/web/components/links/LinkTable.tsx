// `LinkTable` — list of all active links on the Links tab.

import type { LinkRow } from '../../../shared/schemas';
import { Chip } from '../primitives/Chip';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { Column, DataTable } from '../data/DataTable';

export interface LinkTableProps {
  rows: ReadonlyArray<LinkRow>;
  selectedId?: string | null;
  onSelect: (row: LinkRow) => void;
  onEdit: (row: LinkRow) => void;
  onArchive: (row: LinkRow) => void;
}

export function LinkTable({
  rows,
  selectedId,
  onSelect,
  onEdit,
  onArchive,
}: LinkTableProps) {
  const columns: ReadonlyArray<Column<LinkRow>> = [
    {
      key: 'name',
      header: 'Name',
      cell: (r) => <span className="link-table__name">{r.name}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      cell: (r) => <Chip role={r.crewRole}>{r.crewRole}</Chip>,
    },
    {
      key: 'category',
      header: 'Category',
      cell: (r) =>
        r.lpCategory ? (
          <span className="link-table__cat">{prettyCategory(r.lpCategory)}</span>
        ) : (
          <span className="link-table__cat link-table__cat--any">Any</span>
        ),
    },
    {
      key: 'cycle',
      header: 'Cycle',
      align: 'right',
      cell: (r) => <span>{r.cycleLength}</span>,
    },
    {
      key: 'members',
      header: 'Members',
      align: 'right',
      cell: (r) => (
        <span>
          {r.memberCount} / {r.cycleLength}
        </span>
      ),
    },
    {
      key: 'manage',
      header: '',
      cell: (r) => (
        <Button
          variant={selectedId === r.id ? 'primary' : 'secondary'}
          onClick={() => onSelect(r)}
        >
          Manage
        </Button>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (r) => (
        <div className="link-table__actions">
          <IconButton aria-label={`Edit link ${r.name}`} onClick={() => onEdit(r)}>
            ✎
          </IconButton>
          <IconButton aria-label={`Archive link ${r.name}`} onClick={() => onArchive(r)}>
            🗑
          </IconButton>
        </div>
      ),
    },
  ];

  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />;
}

function prettyCategory(c: string): string {
  if (c === 'MAIL_EXPRESS') return 'Mail Express';
  if (c === 'PASSENGER') return 'Passenger';
  return c;
}

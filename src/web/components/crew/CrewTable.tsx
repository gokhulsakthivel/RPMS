// `CrewTable` — unified LP+ALP table on the Crew tab
// (components.md §9 / design.md §9.2).
//
// 7 columns: Name · Role · Grade · Status · Rest remaining · Eligible for · Actions.
// Phase 2 (Links): when `linkInfoByCrewId` is provided, a "Link" column is
// inserted between Grade and Status showing the crew's resolved position
// for the selected date.
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

export interface CrewLinkInfo {
  linkName: string;
  positionNumber: number;
  kind: 'DUTY' | 'OFF' | 'PR';
}

export interface CrewTableProps {
  rows: ReadonlyArray<CrewRow>;
  onEdit: (row: CrewRow) => void;
  onArchive: (row: CrewRow) => void;
  emptyState?: React.ReactNode;
  /**
   * Per-crew Link projection for the operator's selected date. When
   * provided, inserts a "Link" column between Grade and Status.
   */
  linkInfoByCrewId?: ReadonlyMap<string, CrewLinkInfo>;
}

export function CrewTable({
  rows,
  onEdit,
  onArchive,
  emptyState,
  linkInfoByCrewId,
}: CrewTableProps) {
  const columns: Array<Column<CrewRow>> = [
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
  ];

  if (linkInfoByCrewId) {
    columns.push({
      key: 'link',
      header: 'Link',
      cell: (r) => <LinkCell info={linkInfoByCrewId.get(r.id)} />,
    });
  }

  columns.push(
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
  );

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

function LinkCell({ info }: { info: CrewLinkInfo | undefined }) {
  if (!info) return <span className="crew-table__link crew-table__link--none">—</span>;
  const cls =
    info.kind === 'OFF'
      ? 'crew-table__link-pill crew-table__link-pill--off'
      : info.kind === 'PR'
        ? 'crew-table__link-pill crew-table__link-pill--pr'
        : 'crew-table__link-pill crew-table__link-pill--duty';
  return (
    <span className="crew-table__link">
      <span className="crew-table__link-name" title={info.linkName}>
        {info.linkName}
      </span>
      <span className={cls}>
        #{info.positionNumber} · {info.kind}
      </span>
    </span>
  );
}


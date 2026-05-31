// `AssignmentTable` — per-train rows on the Assignments tab
// (components.md §10 / design.md §9.3).
//
// Columns: Train · Type · Departure · LP · ALP · Actions.
//
// Each row exists in one of three states:
//   1. **Persisted** — the API returned an `AssignmentRow`. The LP/ALP are
//      whoever's currently committed to the CSV.
//   2. **Persisted + staged** — the persisted row also has an `'update'` or
//      `'delete'` op in the page-level draft cart. The LP/ALP cells render
//      the staged values (with an arrow showing the diff for `update`) or a
//      strikethrough (for `delete`).
//   3. **Staged-only** — an unassigned, assignable row with a `'create'` op
//      in the cart. The LP/ALP cells render the staged values.
//
// Actions column branches on the row state, taking staged drafts into
// account first:
//   - staged op present → "Edit draft" ✎ + "Remove from draft" ✕ buttons.
//   - else `isAssignable === true` → "Assign" button (opens AssignCrewModal,
//     which Save-stages a `'create'` op).
//   - else active assignment present → "Edit" ✎ + "Delete" 🗑 (open the
//     EditAssignmentModal / ConfirmDialog, both of which stage their op).

import type { AssignmentRow } from '../../../shared/schemas';
import { formatIst } from '../../lib/time';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Column, DataTable } from '../data/DataTable';
import { TrainTypeBadge } from '../trains/TrainTypeBadge';
import type { StagedOp } from './stagedAssignments';

export interface AssignmentTableProps {
  rows: ReadonlyArray<AssignmentRow>;
  /** Map keyed by `trainId` — the page-level draft cart. */
  staged: ReadonlyMap<string, StagedOp>;
  onAssign: (row: AssignmentRow) => void;
  /** Opens the EditAssignmentModal for an existing active assignment. */
  onEdit: (row: AssignmentRow) => void;
  /** Opens the ConfirmDialog for archive-an-assignment (stages a `delete`). */
  onDelete: (row: AssignmentRow) => void;
  /** Removes the staged op for `trainId` from the draft cart. */
  onUnstage: (trainId: string) => void;
  emptyState?: React.ReactNode;
}

export function AssignmentTable({
  rows,
  staged,
  onAssign,
  onEdit,
  onDelete,
  onUnstage,
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
      cell: (r) => renderCrewCell(r, staged.get(r.trainId), 'lp'),
    },
    {
      key: 'alp',
      header: 'ALP',
      cell: (r) => renderCrewCell(r, staged.get(r.trainId), 'alp'),
    },
    {
      key: 'alp2',
      header: 'ALP 2',
      cell: (r) => renderCrewCell(r, staged.get(r.trainId), 'alp2'),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      cell: (r) => {
        const stagedOp = staged.get(r.trainId);

        // Staged op present — give the operator the means to undo or
        // re-edit the draft. Edit re-opens the appropriate modal so the
        // existing draft can be revised; Remove drops the op from the
        // cart without touching the CSV.
        if (stagedOp) {
          // Re-editing a `delete` doesn't make sense — there's nothing to
          // configure. Only render the Remove button in that case.
          const editable = stagedOp.kind !== 'delete';
          return (
            <div className="assign-table__actions">
              {editable ? (
                <IconButton
                  aria-label={`Edit draft for ${r.trainNumber}`}
                  onClick={() =>
                    stagedOp.kind === 'create' ? onAssign(r) : onEdit(r)
                  }
                >
                  ✎
                </IconButton>
              ) : null}
              <IconButton
                aria-label={`Remove draft for ${r.trainNumber}`}
                onClick={() => onUnstage(r.trainId)}
              >
                ✕
              </IconButton>
            </div>
          );
        }

        // Branch order matters: an unfilled slot still wins over the Edit
        // affordance so operators can fill the missing role first. Once
        // the train is fully crewed (`isAssignable === false`) we expose
        // Edit + Delete on the active assignment.
        if (r.isAssignable) {
          return (
            <Button variant="secondary" onClick={() => onAssign(r)}>
              Assign
            </Button>
          );
        }
        if (r.assignmentId) {
          return (
            <div className="assign-table__actions">
              <IconButton
                aria-label={`Edit assignment for ${r.trainNumber}`}
                onClick={() => onEdit(r)}
              >
                ✎
              </IconButton>
              <IconButton
                aria-label={`Delete assignment for ${r.trainNumber}`}
                onClick={() => onDelete(r)}
              >
                🗑
              </IconButton>
            </div>
          );
        }
        return null;
      },
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

// ---------------------------------------------------------------------------
// Cell rendering with staged-op overlay
// ---------------------------------------------------------------------------

function renderCrewCell(
  row: AssignmentRow,
  op: StagedOp | undefined,
  slot: 'lp' | 'alp' | 'alp2',
): React.ReactNode {
  // ----- ALP slots are "Not required" on trains that don't take that
  //       slot (MEMU/DEMU → no ALP at all; non-Amrit-Bharat → no second
  //       ALP) regardless of whatever op is staged.
  if (slot === 'alp' && row.alp === 'NOT_REQUIRED') {
    return (
      <span className="assign-table__crew assign-table__crew--na">
        Not required
      </span>
    );
  }
  if (slot === 'alp2' && row.alp2 === 'NOT_REQUIRED') {
    return (
      <span className="assign-table__crew assign-table__crew--na">
        Not required
      </span>
    );
  }

  // Pull the persisted name (whatever the API returned).
  const persistedName =
    slot === 'lp'
      ? row.lp
        ? row.lp.name
        : null
      : slot === 'alp'
        ? row.alp && row.alp !== 'NOT_REQUIRED'
          ? row.alp.name
          : null
        : row.alp2 && row.alp2 !== 'NOT_REQUIRED'
          ? row.alp2.name
          : null;

  if (!op) {
    return persistedName ? (
      <span className="assign-table__crew">{persistedName}</span>
    ) : (
      <span className="assign-table__crew assign-table__crew--missing">
        Not assigned
      </span>
    );
  }

  // Op-specific overlays. We render an inline "staged" tag rather than
  // relying on per-op CSS classes so the diff is legible even on plain
  // backgrounds (e.g., when CSS hasn't loaded).
  if (op.kind === 'delete') {
    return (
      <span className="assign-table__crew assign-table__crew--staged-delete">
        <s>{persistedName ?? '—'}</s>
        <em className="assign-table__staged-tag"> · staged: archive</em>
      </span>
    );
  }

  if (op.kind === 'create') {
    const stagedName =
      slot === 'lp' ? op.lpName : slot === 'alp' ? op.alpName : op.alpName2;
    if (!stagedName) {
      // ALP slot but train doesn't require one — `create` op carries
      // alpName: null. Render the persisted (nothing) state.
      return (
        <span className="assign-table__crew assign-table__crew--missing">
          Not assigned
        </span>
      );
    }
    return (
      <span className="assign-table__crew assign-table__crew--staged-create">
        {stagedName}
        <em className="assign-table__staged-tag"> · staged: assign</em>
      </span>
    );
  }

  // op.kind === 'update'
  const stagedName =
    slot === 'lp' ? op.lpName : slot === 'alp' ? op.alpName : op.alpName2;
  const originalName =
    slot === 'lp'
      ? op.originalLpName || persistedName
      : slot === 'alp'
        ? op.originalAlpName
        : op.originalAlpName2;
  if (!stagedName) {
    // Possible only on the ALP slot when the train doesn't require one —
    // shouldn't really occur for `update` since Edit doesn't open on
    // MEMU/DEMU rows without ALP.
    return (
      <span className="assign-table__crew">{persistedName ?? '—'}</span>
    );
  }
  if (originalName && originalName !== stagedName) {
    return (
      <span className="assign-table__crew assign-table__crew--staged-update">
        <s>{originalName}</s> → {stagedName}
        <em className="assign-table__staged-tag"> · staged: update</em>
      </span>
    );
  }
  // Slot is unchanged in the update op — show the staged (== persisted) name.
  return (
    <span className="assign-table__crew">{stagedName}</span>
  );
}

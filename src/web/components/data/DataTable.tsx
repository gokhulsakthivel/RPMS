// `DataTable<Row>` — generic table primitive used by every list view
// (components.md §7).
//
// Columns are declared as `Column<Row>` objects:
//
//   const columns: Array<Column<TrainRow>> = [
//     { key: 'number', header: 'Number',  cell: (r) => r.number },
//     { key: 'type',   header: 'Type',    cell: (r) => <TrainTypeBadge type={r.type} /> },
//     ...
//   ];
//
// Why a render-prop instead of automagic field access? Most cells render a
// component (Badge, Chip, RestBar) — a lookup-by-key API would force every
// caller to use a sentinel render function anyway. This keeps the cells
// strongly typed without bespoke intermediate types.

import type { Key, ReactNode } from 'react';

export interface Column<Row> {
  /** Unique identifier for this column — used as React key. */
  key: string;
  /** Header text or arbitrary node. */
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: Row, rowIndex: number) => ReactNode;
  /** Optional CSS class on the `<th>` and `<td>` (alignment, width). */
  align?: 'left' | 'right' | 'center';
  /** Numeric width in px; if omitted the table auto-fits. */
  width?: number;
}

export interface DataTableProps<Row> {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  /** Stable React key per row. Defaults to `rowIndex`. */
  rowKey?: (row: Row, rowIndex: number) => Key;
  /** Optional caption for screen readers. */
  caption?: string;
  /** Optional empty-state to render when `rows.length === 0`. */
  emptyState?: ReactNode;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  emptyState,
}: DataTableProps<Row>) {
  if (rows.length === 0 && emptyState) {
    return <div className="data-table-empty">{emptyState}</div>;
  }
  return (
    <div className="data-table">
      <table>
        {caption ? <caption className="data-table__caption">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`data-table__th data-table__th--${c.align ?? 'left'}`}
                style={c.width ? { width: c.width } : undefined}
                scope="col"
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKey ? rowKey(row, rowIndex) : rowIndex}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`data-table__td data-table__td--${c.align ?? 'left'}`}
                >
                  {c.cell(row, rowIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Storage-agnostic table interface.
//
// Every repo depends on this interface — not on CSV files, not on Google
// Sheets, not on any concrete I/O layer. The composition root in server.ts
// picks the implementation at boot time.
//
// A "table" is an ordered set of string-valued rows keyed by a header.
// This shape matches CSV, Google Sheets tabs, and simple SQL tables.

/** A parsed row — column name → cell text. Identical to `CsvRow` in csvIo. */
export type Row = Record<string, string>;

/**
 * Minimal storage interface every repo needs.
 *
 * - `read`   — return all rows; assert the header matches the schema.
 * - `mutate` — atomic read-modify-write under whatever lock the backend provides.
 *
 * Cell encoding/decoding (dates, pipe-lists, etc.) stays in the repos — it's
 * domain mapping, not I/O.
 */
export interface TableStore {
  /**
   * Read all rows from `table`. The implementation MUST assert that the
   * stored header matches `header` exactly (order + names). Throws on
   * mismatch so schema drift is caught early.
   */
  read(table: string, header: readonly string[]): Promise<Row[]>;

  /**
   * Atomic read-modify-write. The implementation reads the current rows,
   * passes them to `transform`, and writes the result back — all under
   * whatever concurrency guard the backend provides (file lock for CSV,
   * optimistic CAS for Sheets, transaction for SQL, etc.).
   *
   * `knownRows` — optional pre-read snapshot. When supplied the backend
   * MAY skip its own read and use these rows as the starting point for
   * `transform`. Callers (e.g. CachedTableStore) pass their warm cache
   * here to eliminate redundant round-trips on backends with quota limits.
   */
  mutate(
    table: string,
    header: readonly string[],
    transform: (rows: Row[]) => Row[] | Promise<Row[]>,
    knownRows?: Row[],
  ): Promise<void>;
}

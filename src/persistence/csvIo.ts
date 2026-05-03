// Whole-file CSV read/write helpers used by every Csv*Repo.
//
// LLD §5.2 / §5.4:
//   - UTF-8, '\n' line endings, RFC 4180 quoting.
//   - Header row is part of the contract — readers MUST assert exact match.
//   - Every write is whole-file: parse → mutate in memory → stringify →
//     write to `<file>.tmp` → `fs.rename` (atomic on POSIX). Always under
//     the file lock provided by withLock(filePath, ...).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

import { withLock } from './fileLock';

/** A parsed CSV row before domain decoding — column → cell text. */
export type CsvRow = Record<string, string>;

/**
 * Read the file, assert the header equals `expectedHeader` (exact text + order
 * per LLD §5.2 #6), and return rows as `Record<string, string>`. Empty cells
 * remain empty strings — repo decoders translate those to `undefined`.
 */
export async function readCsv(
  filePath: string,
  expectedHeader: readonly string[],
): Promise<CsvRow[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const trimmed = raw.replace(/^\uFEFF/, ''); // strip optional BOM
  if (trimmed.trim() === '') {
    throw new CsvSchemaError(
      filePath,
      `expected header "${expectedHeader.join(',')}" but file is empty`,
    );
  }

  // Read header line first so we can produce a precise error message that
  // names the file and the actual columns we found.
  const records = parse(trimmed, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: false,
    bom: false,
  }) as string[][];

  const [headerRow, ...dataRows] = records;
  if (!headerRow) {
    throw new CsvSchemaError(filePath, 'no header row found');
  }

  if (
    headerRow.length !== expectedHeader.length ||
    expectedHeader.some((col, i) => headerRow[i] !== col)
  ) {
    throw new CsvSchemaError(
      filePath,
      `header mismatch.\n  expected: ${expectedHeader.join(',')}\n  actual:   ${headerRow.join(',')}`,
    );
  }

  return dataRows.map((cells, idx) => {
    if (cells.length !== expectedHeader.length) {
      throw new CsvSchemaError(
        filePath,
        `row ${idx + 2} has ${cells.length} cells, expected ${expectedHeader.length}`,
      );
    }
    const row: CsvRow = {};
    for (let i = 0; i < expectedHeader.length; i++) {
      row[expectedHeader[i]!] = cells[i] ?? '';
    }
    return row;
  });
}

/**
 * Atomic whole-file rewrite. Caller MUST already hold the lock for `filePath`.
 *
 *   1. stringify rows with `expectedHeader` exactly (LLD §5.2 contract).
 *   2. fs.writeFile(<file>.tmp, ...).
 *   3. fs.rename(<file>.tmp, <file>) — atomic on POSIX.
 */
export async function writeCsv(
  filePath: string,
  expectedHeader: readonly string[],
  rows: CsvRow[],
): Promise<void> {
  const body = stringify(rows, {
    header: true,
    columns: expectedHeader as string[],
    record_delimiter: '\n',
    // Quoting defaults already conform to RFC 4180 — only quote when needed.
  });

  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, body, 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Convenience: lock → read-modify-write in a single call. The transformer
 * receives the current rows and returns the next rows. This is the path used
 * by every mutating repo method.
 */
export async function mutateCsv(
  filePath: string,
  expectedHeader: readonly string[],
  transform: (rows: CsvRow[]) => CsvRow[] | Promise<CsvRow[]>,
): Promise<void> {
  await withLock(filePath, async () => {
    const current = await readCsv(filePath, expectedHeader);
    const next = await transform(current);
    await writeCsv(filePath, expectedHeader, next);
  });
}

/**
 * Lock-free read used by `findById`/`list` operations. Concurrent readers
 * never block each other — the lock is only required when mutating, and the
 * temp+rename swap means partial reads are impossible.
 */
export async function readCsvUnlocked(
  filePath: string,
  expectedHeader: readonly string[],
): Promise<CsvRow[]> {
  return readCsv(filePath, expectedHeader);
}

// ---------------------------------------------------------------------------
// Cell encoders/decoders. The repos call these so the wire ↔ domain mapping
// is consistent across all four files.
// ---------------------------------------------------------------------------

/** ISO-8601 UTC string ↔ Date. Empty cell decodes to `undefined`. */
export function decodeDate(cell: string): Date | undefined {
  if (cell === '') return undefined;
  const d = new Date(cell);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`csvIo.decodeDate: not a valid ISO-8601 timestamp: ${JSON.stringify(cell)}`);
  }
  return d;
}

export function encodeDate(d: Date | undefined): string {
  return d ? d.toISOString() : '';
}

/**
 * Pipe-list ↔ string[]. Empty cell decodes to `[]` (LLD §5.2 #5).
 * Whitespace inside a value is preserved, but surrounding spaces around the
 * pipe are trimmed for forgiveness.
 */
export function decodePipeList(cell: string): string[] {
  if (cell === '') return [];
  return cell.split('|').map((s) => s.trim()).filter((s) => s !== '');
}

export function encodePipeList(values: readonly string[]): string {
  return values.join('|');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the file's header doesn't match the schema in LLD §5.3. */
export class CsvSchemaError extends Error {
  constructor(filePath: string, detail: string) {
    super(`CSV schema error in ${path.basename(filePath)}: ${detail}`);
    this.name = 'CsvSchemaError';
  }
}

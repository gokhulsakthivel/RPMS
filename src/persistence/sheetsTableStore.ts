// Google Sheets-backed TableStore.
//
// Each `table` name maps to a sheet tab (worksheet) inside a single Google
// Spreadsheet. The tab name must match the table name exactly (e.g.
// "loco_pilots", "trains"). Row 1 is the header; data starts at row 2.
//
// Auth: uses a Google service account. Share the spreadsheet with the
// service account's email as Editor. Set these env vars:
//
//   GOOGLE_SHEETS_ID             — the spreadsheet ID from the URL
//   GOOGLE_SERVICE_ACCOUNT_EMAIL — the service account email
//   GOOGLE_PRIVATE_KEY           — the PEM private key (with \n preserved)
//
// Concurrency: `mutate` performs a read-transform-write cycle. There is no
// distributed lock — this is acceptable for a single-server deployment. For
// multi-instance setups, front the writes with Apps Script LockService.

import { google, sheets_v4 } from 'googleapis';
import type { Row, TableStore } from './tableStore';

export interface SheetsTableStoreConfig {
  spreadsheetId: string;
  serviceAccountEmail: string;
  privateKey: string;
}

export class SheetsTableStore implements TableStore {
  private readonly spreadsheetId: string;
  private readonly sheets: sheets_v4.Sheets;

  constructor(config: SheetsTableStoreConfig) {
    this.spreadsheetId = config.spreadsheetId;

    const auth = new google.auth.JWT({
      email: config.serviceAccountEmail,
      key: config.privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async read(table: string, header: readonly string[]): Promise<Row[]> {
    const range = `${table}!A:${columnLetter(header.length)}`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });

    const values = res.data.values;
    if (!values || values.length === 0) {
      throw new SheetsSchemaError(
        table,
        `expected header "${header.join(',')}" but sheet tab is empty`,
      );
    }

    const [headerRow, ...dataRows] = values;

    // Assert header matches exactly (same contract as csvIo).
    if (
      headerRow!.length !== header.length ||
      header.some((col, i) => String(headerRow![i] ?? '') !== col)
    ) {
      throw new SheetsSchemaError(
        table,
        `header mismatch.\n  expected: ${header.join(',')}\n  actual:   ${headerRow!.join(',')}`,
      );
    }

    return dataRows.map((cells, idx) => {
      const row: Row = {};
      for (let i = 0; i < header.length; i++) {
        // Sheets may omit trailing empty cells — default to empty string.
        row[header[i]!] = String(cells[i] ?? '');
      }
      return row;
    });
  }

  async mutate(
    table: string,
    header: readonly string[],
    transform: (rows: Row[]) => Row[] | Promise<Row[]>,
  ): Promise<void> {
    // 1. Read current state. If the sheet is empty or has a mismatched header
    //    (e.g. after a previous failed write), treat as zero rows so the
    //    transform can still produce a valid result and self-heal the tab.
    let current: Row[];
    let oldRowCount: number;
    try {
      current = await this.read(table, header);
      oldRowCount = current.length;
    } catch (e) {
      if (e instanceof SheetsSchemaError) {
        current = [];
        oldRowCount = 0;
      } else {
        throw e;
      }
    }

    // 2. Apply transform.
    const next = await transform(current);

    // 3. Build the values array: header row + data rows.
    const headerValues = [...header];
    const dataValues = next.map((row) =>
      header.map((col) => row[col] ?? ''),
    );
    const allValues = [headerValues, ...dataValues];

    const colLetter = columnLetter(header.length);

    // 4. Write first, then clean up stale trailing rows.
    //    This ordering ensures that if the write succeeds but the cleanup
    //    fails, the sheet still contains valid (possibly extra) data rather
    //    than being left blank.
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${table}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: allValues },
    });

    // header occupies row 1, so old data ends at row (oldRowCount + 1).
    // New data ends at row allValues.length. Clear any leftover rows.
    const newEndRow = allValues.length;
    const oldEndRow = oldRowCount + 1; // +1 for header row
    if (oldEndRow > newEndRow) {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: `${table}!A${newEndRow + 1}:${colLetter}${oldEndRow}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 1-based column index to a Sheets column letter.
 * 1 → A, 26 → Z, 27 → AA, etc.
 */
function columnLetter(n: number): string {
  let result = '';
  let num = n;
  while (num > 0) {
    num--;
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

/** Thrown when the sheet tab's header doesn't match the expected schema. */
class SheetsSchemaError extends Error {
  constructor(table: string, detail: string) {
    super(`Sheets schema error in tab "${table}": ${detail}`);
    this.name = 'SheetsSchemaError';
  }
}

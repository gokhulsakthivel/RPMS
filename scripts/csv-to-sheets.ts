#!/usr/bin/env npx tsx
// One-shot migration: read every local CSV and write it into the Google Sheet.
//
// Usage:
//   GOOGLE_SHEETS_ID=... \
//   GOOGLE_SERVICE_ACCOUNT_EMAIL=... \
//   GOOGLE_PRIVATE_KEY=... \
//   npx tsx scripts/csv-to-sheets.ts
//
// Prerequisites:
//   1. Create a Google Sheet with one tab per table:
//      loco_pilots, assistant_loco_pilots, trains, assignments,
//      assignment_drafts, leaves
//   2. Share the sheet with the service account email (Editor).
//
// The script reads each CSV, then writes header + data to the corresponding
// tab. Existing tab content is CLEARED before writing.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const TABLES = [
  'loco_pilots',
  'assistant_loco_pilots',
  'trains',
  'assignments',
  'assignment_drafts',
  'leaves',
];

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!spreadsheetId || !email || !key) {
    console.error(
      'Missing env vars. Required: GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY',
    );
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  for (const table of TABLES) {
    const csvPath = path.join(DATA_DIR, `${table}.csv`);
    console.log(`Reading ${csvPath} ...`);

    const raw = await fs.readFile(csvPath, 'utf8');
    const lines = raw.trim().split('\n');
    // Simple CSV → 2D array. Works for our data (no embedded commas in
    // unquoted cells). For production use csv-parse, but this is a one-shot.
    const values = lines.map((line) => parseCsvLine(line));

    console.log(`  ${values.length - 1} data rows, ${values[0]?.length ?? 0} columns`);

    // Clear and write.
    const range = `${table}!A1`;
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${table}!A:ZZ`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    console.log(`  ✓ written to tab "${table}"`);
  }

  console.log('\nDone. All CSVs migrated to Google Sheets.');
}

/**
 * Minimal RFC 4180 CSV line parser. Handles double-quoted fields (which our
 * pipe-lists and ISO timestamps may trigger).
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      cells.push('');
      break;
    }
    if (line[i] === '"') {
      // Quoted field.
      let val = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += line[i]!;
          i++;
        }
      }
      cells.push(val);
      if (line[i] === ',') i++; // skip separator
    } else {
      // Unquoted field.
      const nextComma = line.indexOf(',', i);
      if (nextComma === -1) {
        cells.push(line.slice(i));
        break;
      }
      cells.push(line.slice(i, nextComma));
      i = nextComma + 1;
    }
  }
  return cells;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

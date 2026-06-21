// One-shot migration: rebuild `data/links.csv` + `data/link_memberships.csv`
// so the projection for 2026-06-14 matches the depot board photo at
// `RPMS/data/Link 2026-06-14.jpeg`.
//
// What it does:
//   1. Mail LP/ALP links → 19 positions, each board row = one position
//      (overnight pairs split into out/in positions; same-day round trips
//      kept as multi-leg single positions).
//   2. Passenger LP/ALP links → keep existing 8-position structure; only
//      memberships are re-anchored.
//   3. All active memberships are re-seeded with anchorDate=2026-06-14 and
//      anchorPositionNumber matching the board row.
//   4. Unmatched memberships are archived (archivedAt=now), not deleted.
//   5. Backups go to `data/.backup-board-2026-06-14/`.
//
// Run with: npx tsx scripts/reseed-links-from-board-2026-06-14.ts

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BACKUP = path.join(DATA, '.backup-board-2026-06-14');
const ANCHOR_DATE = '2026-06-14';

interface RawRow {
  [k: string]: string;
}

async function readCsv(file: string): Promise<RawRow[]> {
  const text = await fs.readFile(file, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true }) as RawRow[];
}

async function writeCsv(
  file: string,
  header: readonly string[],
  rows: RawRow[],
): Promise<void> {
  const body = stringify(rows, {
    header: true,
    columns: header as string[],
    record_delimiter: '\n',
  });
  await fs.writeFile(file, body, 'utf8');
}

async function backup(file: string): Promise<void> {
  await fs.mkdir(BACKUP, { recursive: true });
  const base = path.basename(file);
  await fs.copyFile(file, path.join(BACKUP, base));
}

// ---------------------------------------------------------------------------
// LP / ALP roster lookup by canonical board name
// ---------------------------------------------------------------------------

function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Roster {
  private byName = new Map<string, string>();

  constructor(rows: RawRow[]) {
    for (const r of rows) {
      const id = r['id']!;
      const name = r['name']!;
      this.byName.set(normaliseName(name), id);
    }
  }

  resolve(boardName: string): string | null {
    const key = normaliseName(boardName);
    const direct = this.byName.get(key);
    if (direct) return direct;
    // Try common transformations: drop initials, last-name-first swaps.
    const noInitials = key.replace(/\b[a-z]\b/g, '').replace(/\s+/g, ' ').trim();
    for (const [k, id] of this.byName) {
      const kNoInit = k.replace(/\b[a-z]\b/g, '').replace(/\s+/g, ' ').trim();
      if (kNoInit && kNoInit === noInitials) return id;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board layout (transcribed from RPMS/data/Link 2026-06-14.jpeg)
// ---------------------------------------------------------------------------

interface BoardRow {
  /** new positionNumber, 1-based */
  pos: number;
  /** 'DUTY' | 'PR' */
  kind: 'DUTY' | 'PR';
  /** Source position number from current links.csv whose segments should be
   * preserved. Use a number for a whole segment array, or [src, segIdx] for
   * a single segment from a multi-leg source position. */
  src?: number | [number, number];
  /** LP name as written on the board (mail or passenger) */
  lp: string | null;
  /** ALP name */
  alp: string | null;
}

// Mail link — 19 positions, top-to-bottom on the LEFT half of the board.
// Position 19 is the trailing PR slot ("PR-30 / SUDEV / MANJUSHA").
const MAIL_BOARD: BoardRow[] = [
  { pos: 1,  kind: 'DUTY', src: 1,        lp: 'SUJESH C.',                 alp: 'PRAVEENKUMAR R.' },
  { pos: 2,  kind: 'DUTY', src: 2,        lp: 'PRABATHKAR M.',             alp: 'VIPIN DAS K. T.' },
  { pos: 3,  kind: 'DUTY', src: [3, 0],   lp: 'RAJESH CHANDRA T.',         alp: 'SURESH M.' },
  { pos: 4,  kind: 'DUTY', src: [3, 1],   lp: 'UNNIKRISHNAN V. S.',        alp: 'ARUN JACOB V.' },
  { pos: 5,  kind: 'DUTY', src: [5, 0],   lp: 'DAMODHARAN NAIR P.',        alp: 'VINEETH C. V.' },
  { pos: 6,  kind: 'DUTY', src: [5, 1],   lp: 'BALAMURUGAN M.',            alp: 'VIVEK VALSAN' },
  { pos: 7,  kind: 'DUTY', src: 7,        lp: 'SURESH KUMAR N. K.',        alp: 'KRISHNA DAS S.' },
  { pos: 8,  kind: 'DUTY', src: 8,        lp: 'MD ASHRAF K M',             alp: 'CHRISTO JOJU' },
  { pos: 9,  kind: 'DUTY', src: 9,        lp: 'BIJU P. K.',                alp: null },
  { pos: 10, kind: 'DUTY', src: 10,       lp: 'CHANDRASEKARAN V. S.',      alp: 'JANEESHKUMAR P.' },
  { pos: 11, kind: 'DUTY', src: 11,       lp: 'SURESH M.',                 alp: 'ARUN THULASY' },
  { pos: 12, kind: 'PR',                  lp: 'PRABATH MANOOR K.',         alp: 'VINEETH V. H.' },
  { pos: 13, kind: 'DUTY', src: 13,       lp: 'DENNY THOMAS',              alp: 'JUNAIDH A. P.' },
  { pos: 14, kind: 'DUTY', src: 14,       lp: 'Erode LP',                  alp: 'ASHIK ANTO' },
  { pos: 15, kind: 'DUTY', src: 15,       lp: 'ED LP 2',                   alp: 'JISHNU P. M.' },
  { pos: 16, kind: 'DUTY', src: 16,       lp: 'JAYAKANTHAN M.',            alp: 'SACHIN M.' },
  { pos: 17, kind: 'DUTY', src: 17,       lp: 'RANJIT KUMAR S.',           alp: 'PRABHU C R' },
  { pos: 18, kind: 'DUTY', src: 18,       lp: 'RANJITH P. C.',             alp: 'AASISH NIRMAL G.' },
  { pos: 19, kind: 'PR',                  lp: 'SUDEV A. S.',               alp: 'MANJUSHA RAHINI I.' },
];

// Passenger link — 8 positions, RIGHT half rows 1–8. Structure already
// matches current links.csv; only memberships need re-anchoring.
const PASSENGER_BOARD: BoardRow[] = [
  { pos: 1, kind: 'DUTY', src: 1, lp: 'SASI C. S.',       alp: 'ARAVIND R.' },
  { pos: 2, kind: 'DUTY', src: 2, lp: 'SASIKUMAR C.',     alp: 'DIVEJ S.' },
  { pos: 3, kind: 'DUTY', src: 3, lp: 'REMESH C.',        alp: null },
  { pos: 4, kind: 'DUTY', src: 4, lp: 'SOMASUNDARAM P.',  alp: null },
  { pos: 5, kind: 'PR',           lp: null,               alp: null },
  { pos: 6, kind: 'DUTY', src: 6, lp: 'SAILESH KUMAR M.', alp: 'DHARMAN R.' },
  { pos: 7, kind: 'DUTY', src: 7, lp: 'SHANMUGAM R. K.',  alp: 'MIDHUN P.' },
  { pos: 8, kind: 'DUTY', src: 8, lp: 'ARUN B.',          alp: null },
];

// ---------------------------------------------------------------------------
// Build new positions[] JSON for a link by remapping board rows to segments
// pulled from the OLD positions for that link.
// ---------------------------------------------------------------------------

function buildPositions(board: BoardRow[], oldPositions: any[]): any[] {
  const out: any[] = [];
  for (const row of board) {
    if (row.kind === 'PR') {
      out.push({ positionNumber: row.pos, kind: 'PR' });
      continue;
    }
    if (row.src === undefined) {
      throw new Error(`board row ${row.pos} is DUTY but has no src`);
    }
    if (typeof row.src === 'number') {
      const old = oldPositions.find((p) => p.positionNumber === row.src);
      if (!old || old.kind !== 'DUTY') {
        throw new Error(`src position ${row.src} not found / not DUTY`);
      }
      out.push({
        positionNumber: row.pos,
        kind: 'DUTY',
        segments: old.segments,
      });
    } else {
      const [srcPos, segIdx] = row.src;
      const old = oldPositions.find((p) => p.positionNumber === srcPos);
      if (!old || old.kind !== 'DUTY' || !old.segments[segIdx]) {
        throw new Error(`src position ${srcPos}[${segIdx}] not found`);
      }
      out.push({
        positionNumber: row.pos,
        kind: 'DUTY',
        segments: [old.segments[segIdx]],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const linksFile = path.join(DATA, 'links.csv');
  const membFile = path.join(DATA, 'link_memberships.csv');
  const lpsFile = path.join(DATA, 'loco_pilots.csv');
  const alpsFile = path.join(DATA, 'assistant_loco_pilots.csv');

  await backup(linksFile);
  await backup(membFile);

  const links = await readCsv(linksFile);
  const memberships = await readCsv(membFile);
  const lps = await readCsv(lpsFile);
  const alps = await readCsv(alpsFile);

  const lpRoster = new Roster(lps);
  const alpRoster = new Roster(alps);

  const linkByName = new Map(links.map((l) => [l['name']!, l]));
  const mailLp = linkByName.get('CBE MAIL LINK - 19 MEN');
  const mailAlp = linkByName.get('CBE MAIL ALP LINK - 19 MEN');
  const passLp = linkByName.get('CBE-8 MEN PASSENGER LINK');
  const passAlp = linkByName.get('CBE-8 MEN PASSENGER ALP LINK');
  if (!mailLp || !mailAlp || !passLp || !passAlp) {
    throw new Error('Could not find one of the 4 expected links by name.');
  }

  // ---- 1. Rewrite links.csv positions ----
  const mailLpOld = JSON.parse(mailLp['positions']!);
  const mailAlpOld = JSON.parse(mailAlp['positions']!);
  const passLpOld = JSON.parse(passLp['positions']!);
  const passAlpOld = JSON.parse(passAlp['positions']!);

  const mailLpNew = buildPositions(MAIL_BOARD, mailLpOld);
  const mailAlpNew = buildPositions(MAIL_BOARD, mailAlpOld);
  const passLpNew = buildPositions(PASSENGER_BOARD, passLpOld);
  const passAlpNew = buildPositions(PASSENGER_BOARD, passAlpOld);

  mailLp['positions'] = JSON.stringify(mailLpNew);
  mailLp['cycleLength'] = String(mailLpNew.length);
  mailAlp['positions'] = JSON.stringify(mailAlpNew);
  mailAlp['cycleLength'] = String(mailAlpNew.length);
  passLp['positions'] = JSON.stringify(passLpNew);
  passLp['cycleLength'] = String(passLpNew.length);
  passAlp['positions'] = JSON.stringify(passAlpNew);
  passAlp['cycleLength'] = String(passAlpNew.length);

  const linkHeader = [
    'id', 'name', 'crewRole', 'lpCategory', 'cycleLength',
    'positions', 'createdAt', 'archivedAt',
  ];
  await writeCsv(linksFile, linkHeader, links);
  console.log('✓ Rewrote', linksFile);

  // ---- 2. Build new memberships ----
  const now = new Date().toISOString();
  const existingByKey = new Map<string, RawRow>();
  for (const m of memberships) {
    const key = `${m['linkId']}|${m['crewId']}`;
    if (!m['archivedAt']) existingByKey.set(key, m);
  }

  const desired: Array<{
    linkId: string; crewId: string; crewRole: 'LP' | 'ALP'; pos: number;
  }> = [];
  const unresolved: string[] = [];

  function add(linkId: string, role: 'LP' | 'ALP', name: string | null, pos: number) {
    if (!name) return;
    const id = role === 'LP' ? lpRoster.resolve(name) : alpRoster.resolve(name);
    if (!id) {
      unresolved.push(`${role} "${name}" (link ${linkId.slice(0, 8)} pos ${pos})`);
      return;
    }
    desired.push({ linkId, crewId: id, crewRole: role, pos });
  }

  for (const row of MAIL_BOARD) {
    add(mailLp['id']!, 'LP', row.lp, row.pos);
    add(mailAlp['id']!, 'ALP', row.alp, row.pos);
  }
  for (const row of PASSENGER_BOARD) {
    add(passLp['id']!, 'LP', row.lp, row.pos);
    add(passAlp['id']!, 'ALP', row.alp, row.pos);
  }

  if (unresolved.length) {
    console.error('UNRESOLVED roster names (will be skipped):');
    for (const u of unresolved) console.error('  -', u);
  }

  const newMembs: RawRow[] = [];
  const desiredKeys = new Set<string>();
  for (const d of desired) {
    const key = `${d.linkId}|${d.crewId}`;
    desiredKeys.add(key);
    const existing = existingByKey.get(key);
    if (existing) {
      newMembs.push({
        ...existing,
        anchorDate: ANCHOR_DATE,
        anchorPositionNumber: String(d.pos),
        archivedAt: '',
      });
    } else {
      newMembs.push({
        id: `LM_${randomUUID()}`,
        linkId: d.linkId,
        crewId: d.crewId,
        crewRole: d.crewRole,
        anchorDate: ANCHOR_DATE,
        anchorPositionNumber: String(d.pos),
        createdAt: now,
        archivedAt: '',
      });
    }
  }

  // Archive memberships that exist today but aren't in the desired set.
  for (const m of memberships) {
    const key = `${m['linkId']}|${m['crewId']}`;
    if (!desiredKeys.has(key)) {
      newMembs.push({
        ...m,
        archivedAt: m['archivedAt'] || now,
      });
    }
  }

  const memberHeader = [
    'id', 'linkId', 'crewId', 'crewRole',
    'anchorDate', 'anchorPositionNumber', 'createdAt', 'archivedAt',
  ];
  await writeCsv(membFile, memberHeader, newMembs);
  console.log('✓ Rewrote', membFile);
  console.log(`  active: ${desired.length}, archived/kept: ${newMembs.length - desired.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

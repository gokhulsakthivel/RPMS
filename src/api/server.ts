// Express composition root.
//
// This is the *only* file in `src/api/*` allowed to instantiate concrete
// repo/store classes. Routers and the application layer depend on the
// abstract `*Repo` interfaces declared in `src/domain/repositories.ts`.
//
// Storage backend is selected by `RPMS_STORAGE`:
//   "csv"    (default) — local CSV files under `DATA_DIR`.
//   "sheets" — Google Sheets (one tab per table).
//
// Layout:
//   1. Resolve the data directory / Sheets credentials.
//   2. Build a `TableStore` and pass it to each repo.
//   3. Mount each router under its components.md §11 path.
//   4. Install the centralised error middleware (LAST).
//   5. Start listening on PORT (default 3001).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { CachedTableStore } from '../persistence/cachedTableStore';
import { CsvAssignmentDraftRepo } from '../persistence/csvAssignmentDraftRepo';
import { CsvAssignmentRepo } from '../persistence/csvAssignmentRepo';
import { CsvAssistantLocoPilotRepo } from '../persistence/csvAssistantLocoPilotRepo';
import { CsvLeaveRepo } from '../persistence/csvLeaveRepo';
import { CsvLocoPilotRepo } from '../persistence/csvLocoPilotRepo';
import { CsvTrainRepo } from '../persistence/csvTrainRepo';
import { CsvTableStore } from '../persistence/csvTableStore';
import { SheetsTableStore } from '../persistence/sheetsTableStore';
import type { TableStore } from '../persistence/tableStore';
import { createAssignmentDraftsRouter } from './assignmentDrafts';
import {
  createAssignmentsRouter,
  createEligibleCrewRouter,
} from './assignments';
import { createAssistantLocoPilotsRouter } from './assistantLocoPilots';
import { createCrewDiaryRouter } from './crewDiary';
import { errorMiddleware } from './errorMiddleware';
import { createLeavesRouter } from './leaves';
import { createLocoPilotsRouter } from './locoPilots';
import { createSummaryRouter } from './summary';
import { createTrainsRouter } from './trains';

// ---------------------------------------------------------------------------
// Resolve the data directory (CSV) or Sheets credentials.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.RPMS_DATA_DIR
  ? path.resolve(process.env.RPMS_DATA_DIR)
  : path.join(REPO_ROOT, 'data');

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);
const STORAGE_BACKEND = process.env.RPMS_STORAGE ?? 'csv';

// ---------------------------------------------------------------------------
// TableStore — one env var picks the backend for the entire app.
// ---------------------------------------------------------------------------
function createStore(): TableStore {
  if (STORAGE_BACKEND === 'sheets') {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;
    if (!spreadsheetId || !serviceAccountEmail || !privateKey) {
      throw new Error(
        'RPMS_STORAGE=sheets requires GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY env vars.',
      );
    }
    // eslint-disable-next-line no-console
    console.log('[api] storage backend: Google Sheets (cached, 60 s TTL)');
    const raw = new SheetsTableStore({
      spreadsheetId,
      serviceAccountEmail,
      // The private key arrives with literal \\n — restore real newlines.
      privateKey: privateKey.replace(/\\n/g, '\n'),
    });
    // Wrap with an in-memory cache to stay well within Sheets API quotas.
    // Reads are cached for 60 s; writes invalidate the relevant table.
    return new CachedTableStore(raw);
  }
  // eslint-disable-next-line no-console
  console.log(`[api] storage backend: CSV (${DATA_DIR})`);
  return new CsvTableStore(DATA_DIR);
}

const store = createStore();

// ---------------------------------------------------------------------------
// Repos — single instances per process, backed by the shared store.
// ---------------------------------------------------------------------------
const trains = new CsvTrainRepo(store);
const lps = new CsvLocoPilotRepo(store);
const alps = new CsvAssistantLocoPilotRepo(store);
const assignments = new CsvAssignmentRepo(store);
const leaves = new CsvLeaveRepo(store);
const drafts = new CsvAssignmentDraftRepo(store);

const repoDeps = { trains, lps, alps, assignments, leaves };
const draftDeps = { drafts, ...repoDeps };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // CORS — required when the SPA is hosted on a different origin (e.g.
  // GitHub Pages at gokhulsakthivel.github.io) while the API runs on
  // Render/Railway/Fly. In local dev the Vite proxy means same-origin, so
  // the header is harmless. Restrict `origin` in production to just the
  // Pages URL once it's live.
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000'];
  app.use(cors({ origin: allowedOrigins }));

  // Tiny request log — local dev only, no PII concerns. Helps when triaging
  // a flaky CSV save against a UI action.
  app.use((req, _res, next) => {
    // eslint-disable-next-line no-console
    console.log(`[api] ${req.method} ${req.url}`);
    next();
  });

  // Health check — useful for the Vite proxy "is the api up yet?" probe.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, storage: STORAGE_BACKEND, dataDir: DATA_DIR });
  });

  // Mount per components.md §11.
  app.use('/api/trains',                  createTrainsRouter(repoDeps));
  app.use('/api/loco-pilots',             createLocoPilotsRouter({ lps }));
  app.use('/api/assistant-loco-pilots',   createAssistantLocoPilotsRouter({ alps }));
  app.use('/api/assignments',             createAssignmentsRouter(repoDeps));
  app.use('/api/assignment-drafts',       createAssignmentDraftsRouter(draftDeps));
  app.use('/api/eligible-crew',           createEligibleCrewRouter(repoDeps));
  app.use('/api/leaves',                  createLeavesRouter({ leaves, lps, alps }));
  app.use('/api/crew-diary',              createCrewDiaryRouter({ trains, lps, alps, assignments, leaves }));
  app.use('/api/summary',                 createSummaryRouter(repoDeps));

  // 404 for any unmatched /api/* — surfaces typos as a clean JSON response
  // instead of an HTML body from Express's default handler.
  app.use('/api', (_req, res) => {
    res.status(404).json({ code: 'ROUTE_NOT_FOUND' });
  });

  // Error middleware MUST be last.
  app.use(errorMiddleware);

  return app;
}

// ---------------------------------------------------------------------------
// Bootstrap when invoked directly (tsx watch / node).
// ---------------------------------------------------------------------------
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntry) {
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on http://localhost:${PORT} (storage=${STORAGE_BACKEND})`);
  });
}

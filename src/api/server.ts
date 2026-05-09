// Express composition root.
//
// This is the *only* file in `src/api/*` allowed to instantiate `Csv*Repo`
// concrete classes. Routers and the application layer depend on the abstract
// `*Repo` interfaces declared in `src/domain/repositories.ts`.
//
// Layout:
//   1. Resolve the data directory (defaults to ./data).
//   2. Instantiate one repo per CSV.
//   3. Mount each router under its components.md §11 path.
//   4. Install the centralised error middleware (LAST — Express picks the
//      4-arg signature only after all routes).
//   5. Start listening on PORT (default 3001 — Vite dev server is on 3000).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CsvAssignmentDraftRepo } from '../persistence/csvAssignmentDraftRepo';
import { CsvAssignmentRepo } from '../persistence/csvAssignmentRepo';
import { CsvAssistantLocoPilotRepo } from '../persistence/csvAssistantLocoPilotRepo';
import { CsvLeaveRepo } from '../persistence/csvLeaveRepo';
import { CsvLocoPilotRepo } from '../persistence/csvLocoPilotRepo';
import { CsvTrainRepo } from '../persistence/csvTrainRepo';
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
// Resolve the data directory.
// ---------------------------------------------------------------------------
// We resolve relative to the repo root rather than `process.cwd()` so the
// server behaves the same when launched via `npm run dev:api` (cwd = repo
// root) vs `tsx src/api/server.ts` from a subdirectory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.RPMS_DATA_DIR
  ? path.resolve(process.env.RPMS_DATA_DIR)
  : path.join(REPO_ROOT, 'data');

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10);

// ---------------------------------------------------------------------------
// Repos — single instances per process. The Csv* repos are stateless w.r.t.
// the file (each call re-reads), so sharing one instance is safe and cheap.
// ---------------------------------------------------------------------------
const trains = new CsvTrainRepo(DATA_DIR);
const lps = new CsvLocoPilotRepo(DATA_DIR);
const alps = new CsvAssistantLocoPilotRepo(DATA_DIR);
const assignments = new CsvAssignmentRepo(DATA_DIR);
const leaves = new CsvLeaveRepo(DATA_DIR);
const drafts = new CsvAssignmentDraftRepo(DATA_DIR);

const repoDeps = { trains, lps, alps, assignments, leaves };
const draftDeps = { drafts, ...repoDeps };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export function createApp(): express.Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));

  // Tiny request log — local dev only, no PII concerns. Helps when triaging
  // a flaky CSV save against a UI action.
  app.use((req, _res, next) => {
    // eslint-disable-next-line no-console
    console.log(`[api] ${req.method} ${req.url}`);
    next();
  });

  // Health check — useful for the Vite proxy "is the api up yet?" probe.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, dataDir: DATA_DIR });
  });

  // Mount per components.md §11.
  app.use('/api/trains',                  createTrainsRouter(repoDeps));
  app.use('/api/loco-pilots',             createLocoPilotsRouter({ lps }));
  app.use('/api/assistant-loco-pilots',   createAssistantLocoPilotsRouter({ alps }));
  app.use('/api/assignments',             createAssignmentsRouter(repoDeps));
  app.use('/api/assignment-drafts',       createAssignmentDraftsRouter(draftDeps));
  app.use('/api/eligible-crew',           createEligibleCrewRouter(repoDeps));
  app.use('/api/leaves',                  createLeavesRouter({ leaves, lps, alps }));
  app.use('/api/crew-diary',              createCrewDiaryRouter({ trains, lps, alps, assignments }));
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
    console.log(`[api] listening on http://localhost:${PORT} (data=${DATA_DIR})`);
  });
}

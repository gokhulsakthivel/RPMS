# RPMS Implementation Plan

Step-by-step execution sequence to take the RPMS spec (HLD.md + LLD.md + techstack.md + design.md + components.md) from zero to a runnable local app on `http://localhost:3000`.

The plan is organized into **9 milestones**. Each milestone is independently verifiable; do not advance until its **Done-when** criteria are met.

---

## Milestone 0 — Project Skeleton (~30 min)

> Goal: `npm install` succeeds; `npm run typecheck` passes on an empty project.

### Steps

1. **Create directory tree** per [techstack.md §4](./techstack.md#4-project-layout):
   ```
   data/  public/  src/{domain,application,persistence,api,shared,web/{pages,components,lib}}
   ```
2. **Write `package.json`** with the exact dependency list from [techstack.md §3](./techstack.md#3-dependencies). Scripts:
   - `dev` → `concurrently -n api,web -c blue,green "tsx watch src/api/server.ts" "vite"`
   - `typecheck` → `tsc --noEmit`
   - `build` → `vite build`
3. **Write `tsconfig.json`**: `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `noUncheckedIndexedAccess: true`, `jsx: react-jsx`, `paths: { "@/*": ["./src/*"] }`.
4. **Write `vite.config.ts`**: `@vitejs/plugin-react`, `server.port: 3000`, `server.proxy: { "/api": "http://localhost:3001" }`, `build.outDir: "dist/web"`.
5. **Write `index.html`** at repo root (Vite entry — `<div id="root"></div>` + `<script type="module" src="/src/web/main.tsx">`).
6. **Run** `npm install` then `npm run typecheck`.

**Done-when:** Empty repo type-checks clean.

---

## Milestone 1 — Domain Layer (~1 h)

> Goal: All business rules implemented as **pure** functions with no I/O, no Date.now() leakage, no imports from `application/`/`api/`/`persistence/`/`web/`.

### Steps

1. **`src/domain/types.ts`** — translate [LLD §2](./LLD.md#2-domain-model) verbatim:
   - `TrainType` enum (6 values).
   - `LpCategory` (`'MAIL_EXPRESS' | 'PASSENGER'`).
   - `LocoPilot`, `AssistantLocoPilot`, `Train`, `Assignment` interfaces — each with `archivedAt?: Date`.
   - `RuleError` discriminated union → see [LLD §4](./LLD.md#4-error-contract).
2. **`src/domain/isLpEligible.ts`** — implement the hierarchy rule. **Add the `// DO NOT "FIX": Mail Express LP must NOT step down to Passenger duty` comment** ([AGENTS.md non-negotiable #4](./AGENTS.md#non-negotiables-for-ai-agents)).
3. **`src/domain/isAlpEligible.ts`** — purely `train.type ∈ alp.eligibleTrainTypes`.
4. **`src/domain/requiresAlp.ts`** — `train.type !== 'MEMU' && train.type !== 'DEMU'`.
5. **`src/domain/hasSufficientRest.ts`** — declare `MIN_REST_HOURS = 16` here. **This is the only place the literal `16` is allowed** ([AGENTS.md non-negotiable #2](./AGENTS.md#non-negotiables-for-ai-agents)).
6. **`src/domain/hasWindowConflict.ts`** — closed-interval overlap from [LLD §3.5](./LLD.md#35-window-overlap).
7. **`src/domain/highestGrade.ts`** — server-side projection for the Crew table grade badge ([design.md §9.2](./design.md#92-crew-tab)). Ordering: `MEMU < DEMU < PASSENGER < MAIL_EXPRESS < VANDE_BHARAT < AMRIT_BHARAT`.
8. **`src/domain/repositories.ts`** — declare repo **interfaces** here (`TrainRepo`, `LocoPilotRepo`, `AssistantLocoPilotRepo`, `AssignmentRepo`). The Csv* implementations live in `persistence/`.

**Done-when:**
- `tsc --noEmit` passes.
- `grep -RE "\b16\b" src/domain` returns only `hasSufficientRest.ts`.
- No file in `src/domain/` imports from outside `src/domain/`.

---

## Milestone 2 — Shared Layer (~30 min)

> Goal: Frontend and backend share validation schemas and time helpers.

### Steps

1. **`src/shared/time.ts`** — UTC↔IST helpers:
   - `formatIst(d: Date): string` → `dd MMM yyyy, HH:mm IST` via `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ... })`.
   - `startOfDayIstAsUtc(isoDate: string): Date` for the date-picker filter.
2. **`src/shared/schemas.ts`** — Zod schemas per [LLD §3](./LLD.md#3-validation-functions):
   - `TrainCreateInput`, `TrainUpdateInput`
   - `LocoPilotCreateInput`, `LocoPilotUpdateInput` (Update has optional `lastSignOffTime` for the manual override path, [HLD §4.7](./HLD.md#47-sign-off-time-maintenance))
   - `AlpCreateInput`, `AlpUpdateInput` — Zod `.refine` rejects `MEMU` / `DEMU` in `eligibleTrainTypes`
   - `AssignCrewInput`
   - Response shapes: `TrainRow`, `CrewRow`, `AssignmentRow`, `SummaryResponse`

**Done-when:** Both `src/api/` and `src/web/` can import these without cycle.

---

## Milestone 3 — Persistence Layer (~1.5 h)

> Goal: Read and write the four CSVs atomically under a single-writer lock. Active-vs-archived filtering at the repo boundary.

### Steps

1. **`data/*.csv` seed files** — write headers per [LLD §5.3](./LLD.md#53-csv-schemas) including the `archivedAt` column on all four. Optionally seed a small fixture (3 trains, 2 LPs, 2 ALPs) for local sanity.
2. **`src/persistence/fileLock.ts`** — wrap `proper-lockfile` with a `withLock(path, fn)` helper.
3. **`src/persistence/csvIo.ts`** — read-and-rewrite helper: parse CSV, mutate in memory, stringify, write to `<file>.tmp`, `fs.rename`. Always under `withLock`.
4. **`src/persistence/csvTrainRepo.ts`** — implement `TrainRepo`:
   - `list({ activeOnly = true, departingWithin? })` — filter rows.
   - `create`, `update`, `archive(id)` (sets `archivedAt = new Date()`).
   - `findById`, `findByNumber` for the train-number-uniqueness invariant.
5. **`src/persistence/csvLocoPilotRepo.ts`**, **`csvAssistantLocoPilotRepo.ts`**, **`csvAssignmentRepo.ts`** — same shape.
6. **Manual smoke test** (one-off `tsx scripts/smoke.ts`):
   ```ts
   const trains = new CsvTrainRepo("./data");
   await trains.create({ number: "12345", type: "MAIL_EXPRESS", ... });
   console.log(await trains.list());
   ```

**Done-when:**
- Smoke script writes to `data/trains.csv` and the file contains the row + `archivedAt` empty.
- Re-running with `archive(id)` sets `archivedAt` and `list()` excludes the row.

---

## Milestone 4 — Application Layer (~45 min)

> Goal: `assignCrew` orchestrates the rules in the order specified by [LLD §3.6](./LLD.md#36-orchestration).

### Steps

1. **`src/application/assignCrew.ts`** — pure function: takes repos as deps, returns `Result<Assignment, RuleError>`. Sequence:
   1. `train = trains.findById(...)` → `ARCHIVED_ENTITY` if archived.
   2. LP rules: eligibility → rest → window-conflict (uses `assignments.listActiveByCrew`).
   3. If `requiresAlp(train)`: ALP rules in same order.
   4. Persist `Assignment` and `update()` LP/ALP `lastSignOffTime` to `train.inwardArrivalTime`.
2. **`src/application/listCrewForAssignment.ts`** — used by `AssignCrewModal`'s eligible-crew dropdown. Returns `{ eligible, filteredOut: { reason, crewIds }[] }` so the UI can show the table from [design.md §9.3](./design.md#93-assignments-tab).
3. **`src/application/buildSummary.ts`** — accepts a date `D`, returns the four summary-card numbers scoped per [design.md §9.4](./design.md#94-summary-cards-scope) (anchor = `start_of_D_IST_in_UTC`).

**Done-when:** `tsc --noEmit` passes; no `application/*` file imports from `persistence/` directly (only domain interfaces).

---

## Milestone 5 — API Layer (~1.5 h)

> Goal: Express server on `:3001` exposing the routes the SPA expects.

### Steps

1. **`src/api/server.ts`** — Express bootstrap, JSON middleware, mount routers, error middleware that maps `RuleError` → HTTP 422 with `{ code, ...context }`.
2. **`src/api/trains.ts`**:
   - `GET /api/trains?date=YYYY-MM-DD` (active only, departing in IST day window)
   - `POST /api/trains` (create)
   - `PATCH /api/trains/:id` (edit)
   - `POST /api/trains/:id/archive`
3. **`src/api/crew.ts`** — same CRUD shape for LP and ALP. `PATCH /api/lps/:id` accepts the optional `lastSignOffTime` override. Response includes the server-computed `grade` (highest-rank) and `eligibleForLabel`.
4. **`src/api/assignments.ts`**:
   - `GET /api/assignments?date=...`
   - `GET /api/assignments/eligible?trainId=...` → `{ eligible, filteredOut }`
   - `POST /api/assignments` (calls `assignCrew`)
   - `POST /api/assignments/:id/archive`
5. **`src/api/summary.ts`** → `GET /api/summary?date=...`.
6. **Composition root**: route handlers are the **only** layer that constructs `CsvTrainRepo` etc. and injects them into `assignCrew` ([techstack.md §7](./techstack.md#7-architecture-layering)).
7. **Manual verification** with `curl`:
   ```bash
   curl localhost:3001/api/trains?date=2026-05-02
   curl -X POST localhost:3001/api/trains -d '{...}' -H 'Content-Type: application/json'
   ```

**Done-when:** All five routers respond; archived rows are absent from default lists; `assignCrew` rejects rule violations with structured error codes.

---

## Milestone 6 — Web Shell (~1 h)

> Goal: SPA boots, routes work, header renders, theme tokens applied.

### Steps

1. **`src/web/main.tsx`** — React 18 root, mount `<App />`.
2. **`src/web/App.tsx`** — `BrowserRouter` with routes `/trains`, `/crew`, `/assignments`. Default redirect → `/trains`.
3. **`src/web/styles.css`** — copy the full token block from [design.md §3](./design.md#3-color-tokens). Include the `--status-*-bg/text` pairs, drop the `--status-on-leave-*` variants.
4. **`src/web/components/AppShell.tsx`** — fixed 48px header with the pill-style tab nav and the `<DatePicker />` on the right edge.
5. **`src/web/lib/useSelectedDate.ts`** — global hook (Context) holding `selectedDate` (ISO yyyy-mm-dd, default tomorrow IST). Single writer = `<DatePicker>`.
6. **`src/web/lib/api.ts`** — `fetch` wrappers for every endpoint (`trains.list(date)`, `trains.create(input)`, `trains.update(id, patch)`, `trains.archive(id)`, etc.).
7. **`src/web/lib/time.ts`** — re-exports from `src/shared/time.ts`.

**Done-when:** `npm run dev` launches both processes; `http://localhost:3000` shows the shell with working tab navigation; date picker updates URL state and triggers re-fetches.

---

## Milestone 7 — Pages & Components (~3 h)

> Goal: All three pages render real data and support the documented mutations.

### Steps (per page, in order)

#### 7a. Trains page

1. `<TrainsPage>` → fetches `trains.list(selectedDate)`.
2. `<TrainTable>` from [components.md §8](./components.md#8-table-primitives). Columns: number, type badge, route, **inward route**, departure (full datetime IST), inward arrival, edit/remove icons.
3. `<AddTrainModal>` and `<EditTrainModal>` ([components.md](./components.md)). Reuse the form; Edit prefills.
4. Remove → `<ConfirmDialog>` with "Archive train" verb → `POST /…/archive`.

#### 7b. Crew page

1. `<CrewPage>` → fetches `crew.list()` (combined LPs + ALPs). Single sorted-by-name table.
2. `<CrewTable>` per [components.md](./components.md). Columns: name, kind (LP/ALP), `<CrewGradeBadge>` (any TrainType), eligibleForLabel, `<StatusBadge>`, `<RestBar>`, edit/remove. **No employee ID column.**
3. `<AddCrewModal>` / `<EditCrewModal>` — Edit-only `lastSignOffTime` field for the manual override.
4. `<RestBar>` — `${Math.ceil(hoursRemaining)}h left`.

#### 7c. Assignments page

1. `<AssignmentsPage>` → top half: trains needing assignment (filtered to selected date). Bottom half: existing assignments table.
2. `<AssignCrewModal>` — fetches `/api/assignments/eligible?trainId=...`, shows the eligible dropdown plus the filtered-out reasons table from [design.md §9.3](./design.md#93-assignments-tab).
3. `<SummaryCards>` strip at top — fetches `summary.get(selectedDate)`. Refetch on every successful mutation.

**Done-when:** A full happy-path scenario works end-to-end: create train → create LP and ALP → assign → see assignment listed → see LP/ALP move to `resting` with rest bar → archive train → train disappears from list.

---

## Milestone 8 — Polish & Verification (~1 h)

### Steps

1. **`npm run typecheck`** — must be clean.
2. **Manual rule verification** — walk through every entry in [LLD §7 Test Matrix](./LLD.md#7-testing-requirements) by hand in the UI:
   - Mail Express LP cannot be assigned to a Passenger train (UI must filter them out **and** server must reject if forced).
   - LP with `lastSignOffTime` 15.5 h ago → filtered out with `INSUFFICIENT_REST`.
   - Two trains with overlapping windows for same LP → second is filtered out with `LP_WINDOW_CONFLICT`.
   - MEMU train → ALP slot hidden in modal; ALP cell renders `Not required`.
   - Archive a train → vanishes from list; past assignments still visible.
   - Edit LP `lastSignOffTime` manually → status flips immediately.
3. **Cross-browser check** — Chrome + Safari on macOS.
4. **README** (only if user asks) — covers `npm run dev` and where the CSVs live.

**Done-when:** All rule scenarios pass manually and `tsc --noEmit` is clean.

---

## Critical Sequencing Notes

- **Bottom-up only.** Domain → Shared → Persistence → Application → API → Web. Never start a layer until all its dependencies type-check.
- **Composition root is `src/api/*.ts`.** Repo construction lives nowhere else. The `web/` layer never imports from `domain/`/`application/`/`persistence/`.
- **CSV is the system of record.** No DB, no in-memory cache between requests. Every read goes through the repo.
- **Archive-only.** No `delete` method on any repo, no `DELETE` endpoint. Every "Remove" button is wired to `archive(id)`.
- **Single source for `16`.** `src/domain/hasSufficientRest.ts` only.
- **Single source for the hierarchy rule.** `src/domain/isLpEligible.ts` with the "DO NOT FIX" comment.
- **All times stored UTC, rendered IST.** `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata' })`.

---

## Estimated Total Effort

| Milestone | Effort |
|-----------|--------|
| M0 Skeleton | 30 min |
| M1 Domain | 1 h |
| M2 Shared | 30 min |
| M3 Persistence | 1.5 h |
| M4 Application | 45 min |
| M5 API | 1.5 h |
| M6 Web shell | 1 h |
| M7 Pages | 3 h |
| M8 Polish | 1 h |
| **Total** | **~10.5 h** of focused work |

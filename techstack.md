# Railway People Management System (RPMS) — Tech Stack

This document covers the **technology choices** for the RPMS web application. For the **what** and **why** of the domain, see [`HLD.md`](./HLD.md). For the **how** (types, function signatures, CSV schemas), see [`LLD.md`](./LLD.md). UI design and component breakdown live in [`design.md`](./design.md) and [`components.md`](./components.md).

## 1. Goals

- **Local-only.** Runs on `http://localhost:3000` on a single laptop. No cloud, no Docker, no deployment.
- **Simple.** One repository, one `package.json`, one language (TypeScript).
- **Client-rendered frontend.** A real SPA — React + Vite. **No server-side rendering.** The browser loads JS, the JS calls a JSON API, the API talks to CSV.
- **CSV is the system of record.** Per [LLD §5](./LLD.md#5-persistence). No database.

## 2. Stack at a Glance

### Backend (JSON API)

| Layer        | Choice                                  | Why |
|--------------|-----------------------------------------|-----|
| Language     | **TypeScript**                          | LLD types are already TS; same language as the frontend. |
| Runtime      | **Node.js 20 LTS**                      | Default. Nothing exotic. |
| HTTP server  | **Express 4**                           | Familiar, minimal, JSON-only. No view engine, no template rendering. |
| Validation   | **Zod**                                 | Schemas live in `src/shared/` and validate request bodies on the server *and* form input on the client. |
| CSV          | **`csv-parse` + `csv-stringify`** (sync) | Server-only. RFC 4180 compliant. |
| File locking | **`proper-lockfile`**                   | Implements [LLD §5.4](./LLD.md#54-write-discipline) single-writer rule. |
| Run server   | **`tsx`**                               | Runs `.ts` files directly with watch mode. No compile step. |

### Frontend (SPA)

| Layer        | Choice                                  | Why |
|--------------|-----------------------------------------|-----|
| Framework    | **React 18**                            | Familiar, ubiquitous, no SSR involvement. |
| Build / dev  | **Vite 5**                              | Fast dev server with HMR, zero-config TS + React. |
| Routing      | **React Router 6**                      | Client-side routing for `/trains`, `/crew`, `/assignments`, `/leaves`. |
| HTTP client  | **Native `fetch`**                      | No axios. The Vite dev server proxies `/api/*` to the backend. |
| Styling      | **Plain CSS** (one file, or per-component CSS Modules) | One stylesheet to start. No Tailwind, no CSS-in-JS. |
| Validation   | **Zod** (shared schemas with backend)   | Same schema validates the form *and* the request body on the server. |
| State        | **React's built-in `useState` + `useEffect`** | No Redux, no Zustand, no TanStack Query. The data is small and a refetch on save is fine. |

### Cross-cutting

| Concern      | Choice                                  | Why |
|--------------|-----------------------------------------|-----|
| Time         | **Native `Date` + `Intl.DateTimeFormat`** | Store UTC, render IST via `toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })`. No date library. |
| Type-check   | **`tsc --noEmit`**                      | The only "build verification" step. |
| Run both procs | **`concurrently`** (dev only)         | One `npm run dev` starts the API and the Vite dev server together. |

## 3. Dependencies

```json
{
  "dependencies": {
    "express": "^4",
    "csv-parse": "^5",
    "csv-stringify": "^6",
    "proper-lockfile": "^4",
    "zod": "^3",
    "react": "^18",
    "react-dom": "^18",
    "react-router-dom": "^6"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsx": "^4",
    "vite": "^5",
    "@vitejs/plugin-react": "^4",
    "concurrently": "^9",
    "@types/node": "^20",
    "@types/express": "^4",
    "@types/proper-lockfile": "^4",
    "@types/react": "^18",
    "@types/react-dom": "^18"
  }
}
```

**Explicitly NOT included** (and why):
- Next.js / Remix — those are SSR frameworks. We want a pure CSR SPA.
- Tailwind / shadcn / styled-components — one CSS file is enough until proven otherwise.
- TanStack Query / SWR / Redux / Zustand — `useState` + `useEffect` + `fetch` is the simplest viable approach for a 4-route CRUD app.
- axios — `fetch` is built into the browser.
- date-fns / Luxon — `Intl.DateTimeFormat` handles IST natively.
- pino / winston — `console.log` is fine for a local app.
- ESLint / Prettier / Biome — `tsc --noEmit` is the only check that pays off here.
- Husky / lint-staged — no git hooks; run checks manually.
- Test runners (Vitest / Playwright / `node:test`) — out of scope for now.

## 4. Project Layout

```
RPMS/
├── data/                              ← CSV system of record (LLD §5)
│   ├── trains.csv
│   ├── loco_pilots.csv
│   ├── assistant_loco_pilots.csv
│   └── assignments.csv
├── public/                            ← Vite static assets (favicon etc.)
├── index.html                         ← Vite entry point for the SPA
├── src/
│   ├── domain/                        ← pure TS rules (LLD §3) — no I/O
│   │   ├── types.ts
│   │   ├── isLpEligible.ts
│   │   ├── isAlpEligible.ts
│   │   ├── hasSufficientRest.ts
│   │   └── requiresAlp.ts
│   ├── application/
│   │   └── assignCrew.ts              ← orchestration (LLD §3.5)
│   ├── persistence/                   ← CSV repos (LLD §5)
│   │   ├── csvTrainRepo.ts
│   │   ├── csvLocoPilotRepo.ts
│   │   ├── csvAssistantLocoPilotRepo.ts
│   │   ├── csvAssignmentRepo.ts
│   │   └── fileLock.ts
│   ├── api/                           ← Express handlers (server-only)
│   │   ├── server.ts                  ← Express entry point (port 3001)
│   │   ├── trains.ts
│   │   ├── crew.ts
│   │   ├── assignments.ts
│   │   └── summary.ts
│   ├── shared/                        ← shared by frontend + backend
│   │   ├── schemas.ts                 ← Zod schemas (request/response shapes)
│   │   └── time.ts                    ← UTC ↔ IST helpers
│   └── web/                           ← React SPA (browser-only)
│       ├── main.tsx                   ← Vite entry point (port 3000)
│       ├── App.tsx                    ← Router setup
│       ├── pages/
│       │   ├── TrainsPage.tsx
│       │   ├── CrewPage.tsx
│       │   ├── AssignmentsPage.tsx
│       │   └── LeavesPage.tsx
│       ├── components/                ← per components.md
│       ├── lib/
│       │   └── api.ts                 ← fetch wrappers
│       └── styles.css
├── vite.config.ts                     ← React plugin + /api proxy → :3001
├── tsconfig.json
├── package.json
├── HLD.md
├── LLD.md
├── AGENTS.md
└── techstack.md
```

## 5. How the Two Processes Talk

In **dev**:
- Backend (Express) listens on `http://localhost:3001`.
- Frontend (Vite dev server) listens on `http://localhost:3000` and proxies `/api/*` to `:3001/api/*`.
- The browser only ever talks to `:3000`. Same-origin from its perspective. No CORS dance.
- `concurrently` runs both with one command.

In **prod (still local)**:
- `vite build` produces `dist/web/`.
- Express serves `dist/web/` as static files at `/` and the JSON API at `/api/*`.
- Single port, single process. (Optional — you can also keep using the dev script for local use.)

## 6. Running It

```bash
npm install
npm run dev          # concurrently starts: tsx watch src/api/server.ts (3001) + vite (3000)
npm run typecheck    # tsc --noEmit (covers both server and client)
npm run build        # vite build  → dist/web/  (only needed for the prod-style single-port run)
```

Open `http://localhost:3000`.

## 7. Architecture Layering

The app respects the [HLD §6](./HLD.md#6-high-level-architecture) layering. Imports flow downward only:

```
web/  (React components, pages, fetch calls)
   │
   │  HTTP (JSON over /api)
   ▼
api/  (Express handlers — thin: parse → call application → return JSON)
   ↓
application/  (assignCrew etc.)
   ↓
domain/  (pure rules, types — imports nothing from above)
   ↑
persistence/  (CSV repos — implement repo interfaces declared in domain/)
```

- `domain/` imports nothing from `web/`, `api/`, `application/`, or `persistence/`.
- `application/` imports `domain/` types + repository **interfaces** (not the Csv* classes).
- `api/` route handlers are the **only** place that constructs `CsvTrainRepo` etc. and injects them into `assignCrew`.
- `web/` never imports anything from `api/`, `application/`, `persistence/`, or `domain/` directly. It only knows the JSON shapes from `shared/schemas.ts`.
- `shared/` imports from `domain/types.ts` (and only that) to keep types consistent.

## 8. Out of Scope

- **Authentication.** Single user on `localhost`.
- **HTTPS.** Plain HTTP locally is fine.
- **Deployment.** This app is not designed to be deployed.
- **Multi-process / horizontal scale.** The CSV single-writer lock assumes one Node process.
- **Real-time updates.** No WebSockets / SSE; the operator refreshes.
- **i18n.** English-only.
- **Test runners.** No Vitest/Playwright/`node:test` for now.
- **Leave management.** Per [HLD §7](./HLD.md#7-out-of-scope-initial-version) — out of scope for the initial version.

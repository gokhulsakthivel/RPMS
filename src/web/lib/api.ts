// Typed fetch wrappers for the RPMS REST API.
//
// Pages NEVER call `fetch` directly — they go through these helpers. Reasons:
//   1. One place owns the URL strings (when /api/ paths change, only this
//      file edits).
//   2. Error responses (`ApiErrorResponse` from src/shared/schemas.ts) are
//      translated into a single `ApiError` exception class with the
//      structured `{ code, ...context }` payload preserved — pages catch
//      `ApiError` and decide whether to show an inline banner or a toast.
//   3. Date inputs (`Date` objects) are serialised to ISO-8601 once, here.
//   4. GET requests are cached (30 s TTL) with in-flight deduplication to
//      reduce redundant network round-trips — especially helpful with the
//      Google Sheets backend. Mutations bypass the cache and invalidate
//      related entries so subsequent GETs fetch fresh data.
//
// In development all endpoints route through Vite's dev proxy (`/api → :3001`)
// so the browser only ever talks to :3000.
//
// In production (GitHub Pages), the SPA and the API live on different origins.
// Set `VITE_API_URL` at build time (e.g. `https://rpms-api.onrender.com`) so
// every fetch targets the remote server. When unset, paths stay relative and
// the Vite proxy handles them.
const API_BASE = import.meta.env.VITE_API_URL ?? '';

import * as cache from './fetchCache';
import type {
  AlpCreateInput,
  AlpUpdateInput,
  ApiErrorResponse,
  AssignCrewInput,
  AssignmentDraftCommitResponse,
  AssignmentDraftRow,
  AssignmentDraftStageInput,
  AssignmentRow,
  AssignmentUpdateInput,
  CrewDiaryResponse,
  CrewRow,
  EligibleCrewResponse,
  LeaveCreateInput,
  LeaveRow,
  LeaveUpdateInput,
  LocoPilotCreateInput,
  LocoPilotUpdateInput,
  SummaryResponse,
  TrainCreateInput,
  TrainRow,
  TrainUpdateInput,
  TrainWithAssignment,
} from '../../shared/schemas';

// ---------------------------------------------------------------------------
// Error wrapper — every non-2xx response surfaces as an ApiError.
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(status: number, body: ApiErrorResponse) {
    const { code, ...context } = body;
    super(`API ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = String(code);
    this.context = context as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// Low-level transport
// ---------------------------------------------------------------------------

interface RequestInitJson extends Omit<RequestInit, 'body'> {
  jsonBody?: unknown;
}

/**
 * Core fetch — always hits the network. Used by mutations and as the inner
 * implementation for the cached GET path.
 */
async function rawRequest<T>(path: string, init: RequestInitJson = {}): Promise<T> {
  const { jsonBody, headers, ...rest } = init;
  const finalHeaders: HeadersInit = {
    accept: 'application/json',
    ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  });

  if (res.status === 204) {
    // 204 No Content — used by archive routes.
    return undefined as T;
  }

  // We always expect JSON for everything else. If the API ever returns a
  // non-JSON 5xx (proxy outage, etc.), surface it as an ApiError with code
  // `NETWORK_ERROR` rather than a confusing parse exception in the page.
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, {
      code: 'NETWORK_ERROR',
      message: `Non-JSON response (status ${res.status})`,
      preview: text.slice(0, 200),
    });
  }

  if (!res.ok) {
    const body =
      parsed && typeof parsed === 'object'
        ? (parsed as ApiErrorResponse)
        : { code: 'NETWORK_ERROR', body: parsed };
    throw new ApiError(res.status, body);
  }

  return parsed as T;
}

/**
 * Smart request — GET requests are served from a 30 s TTL cache with
 * in-flight deduplication; mutations always go to the network.
 */
async function request<T>(path: string, init: RequestInitJson = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();

  // Only cache GET requests.
  if (method !== 'GET') return rawRequest<T>(path, init);

  const url = `${API_BASE}${path}`;

  // 1. Return from cache if still fresh.
  const cached = cache.get<T>(url);
  if (cached !== undefined) return cached;

  // 2. Piggy-back on an identical in-flight request.
  const pending = cache.getInflight<T>(url);
  if (pending) return pending;

  // 3. Fetch, cache, and return.
  const promise = rawRequest<T>(path, init).then((data) => {
    cache.set(url, data);
    return data;
  });

  cache.setInflight(url, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Train  →  /api/trains
// ---------------------------------------------------------------------------

/**
 * Wire-form for create/update. M9: trains carry a recurring weekly schedule
 * — `runsOnDays`, `departureTimeOfDay`, `inwardArrivalTimeOfDay`, and
 * `inwardArrivalDayOffset`. The form layer passes those through verbatim.
 */
export type TrainCreateWire = TrainCreateInput;
export type TrainUpdateWire = TrainUpdateInput;

/** Invalidate trains + summary cache after a train mutation. */
function invalidateTrains() {
  cache.invalidate(`${API_BASE}/api/trains`);
  cache.invalidate(`${API_BASE}/api/summary`);
}

export const trains = {
  list: (date: string) =>
    request<TrainWithAssignment[]>(`/api/trains?date=${encodeURIComponent(date)}`),

  create: (input: TrainCreateWire) =>
    request<TrainRow>('/api/trains', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateTrains(); return r; }),

  update: (id: string, patch: TrainUpdateWire) =>
    request<TrainRow>(`/api/trains/${encodeURIComponent(id)}`, {
      method: 'PUT',
      jsonBody: patch,
    }).then((r) => { invalidateTrains(); return r; }),

  archive: (id: string) =>
    request<void>(`/api/trains/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    }).then((r) => { invalidateTrains(); return r; }),
};

// ---------------------------------------------------------------------------
// Loco Pilots  →  /api/loco-pilots
// ---------------------------------------------------------------------------

type LpUpdateWire = Omit<LocoPilotUpdateInput, 'lastSignOffTime'> & {
  /** `Date` to set, `null` to clear, omit to leave unchanged. */
  lastSignOffTime?: Date | null;
};

function encodeLpUpdate(patch: LpUpdateWire): unknown {
  const out: Record<string, unknown> = { ...patch };
  if (patch.lastSignOffTime instanceof Date) {
    out['lastSignOffTime'] = patch.lastSignOffTime.toISOString();
  } else if (patch.lastSignOffTime === null) {
    out['lastSignOffTime'] = null;
  }
  return out;
}

/** Invalidate crew-related caches after an LP or ALP mutation. */
function invalidateCrew() {
  cache.invalidate(`${API_BASE}/api/loco-pilots`);
  cache.invalidate(`${API_BASE}/api/assistant-loco-pilots`);
  cache.invalidate(`${API_BASE}/api/eligible-crew`);
  cache.invalidate(`${API_BASE}/api/summary`);
}

export const locoPilots = {
  list: (date: string) =>
    request<CrewRow[]>(`/api/loco-pilots?date=${encodeURIComponent(date)}`),

  create: (input: LocoPilotCreateInput) =>
    request<unknown>('/api/loco-pilots', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateCrew(); return r; }),

  update: (id: string, patch: LpUpdateWire) =>
    request<unknown>(`/api/loco-pilots/${encodeURIComponent(id)}`, {
      method: 'PUT',
      jsonBody: encodeLpUpdate(patch),
    }).then((r) => { invalidateCrew(); return r; }),

  archive: (id: string) =>
    request<void>(`/api/loco-pilots/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    }).then((r) => { invalidateCrew(); return r; }),
};

// ---------------------------------------------------------------------------
// Assistant Loco Pilots  →  /api/assistant-loco-pilots
// ---------------------------------------------------------------------------

type AlpUpdateWire = Omit<AlpUpdateInput, 'lastSignOffTime'> & {
  lastSignOffTime?: Date | null;
};

function encodeAlpUpdate(patch: AlpUpdateWire): unknown {
  const out: Record<string, unknown> = { ...patch };
  if (patch.lastSignOffTime instanceof Date) {
    out['lastSignOffTime'] = patch.lastSignOffTime.toISOString();
  } else if (patch.lastSignOffTime === null) {
    out['lastSignOffTime'] = null;
  }
  return out;
}

export const assistantLocoPilots = {
  list: (date: string) =>
    request<CrewRow[]>(
      `/api/assistant-loco-pilots?date=${encodeURIComponent(date)}`,
    ),

  create: (input: AlpCreateInput) =>
    request<unknown>('/api/assistant-loco-pilots', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateCrew(); return r; }),

  update: (id: string, patch: AlpUpdateWire) =>
    request<unknown>(`/api/assistant-loco-pilots/${encodeURIComponent(id)}`, {
      method: 'PUT',
      jsonBody: encodeAlpUpdate(patch),
    }).then((r) => { invalidateCrew(); return r; }),

  archive: (id: string) =>
    request<void>(
      `/api/assistant-loco-pilots/${encodeURIComponent(id)}/archive`,
      { method: 'POST' },
    ).then((r) => { invalidateCrew(); return r; }),
};

// ---------------------------------------------------------------------------
// Assignments  →  /api/assignments
// ---------------------------------------------------------------------------

/** Invalidate assignment-related caches after an assignment mutation. */
function invalidateAssignments() {
  cache.invalidate(`${API_BASE}/api/assignments`);
  cache.invalidate(`${API_BASE}/api/trains`);
  cache.invalidate(`${API_BASE}/api/eligible-crew`);
  cache.invalidate(`${API_BASE}/api/crew-diary`);
  cache.invalidate(`${API_BASE}/api/summary`);
}

export const assignments = {
  list: (date: string) =>
    request<AssignmentRow[]>(
      `/api/assignments?date=${encodeURIComponent(date)}`,
    ),

  /**
   * Calls the orchestrator. The server returns 422 with `{ code, ...ctx }`
   * for rule violations — pages catch `ApiError` and inspect `error.code`.
   */
  create: (input: AssignCrewInput) =>
    request<unknown>('/api/assignments', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateAssignments(); return r; }),

  /**
   * Edit an active assignment — swap LP and/or ALP. Same rule errors as
   * `create`. The Edit modal buffers changes locally and only calls this
   * when the user clicks Save (no auto-save on field change).
   */
  update: (id: string, patch: AssignmentUpdateInput) =>
    request<unknown>(`/api/assignments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      jsonBody: patch,
    }).then((r) => { invalidateAssignments(); return r; }),

  archive: (id: string) =>
    request<void>(`/api/assignments/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    }).then((r) => { invalidateAssignments(); return r; }),

  eligibleCrew: (trainId: string, runDate: string) =>
    request<EligibleCrewResponse>(
      `/api/eligible-crew?trainId=${encodeURIComponent(trainId)}&runDate=${encodeURIComponent(runDate)}`,
    ),
};

// ---------------------------------------------------------------------------
// Assignment Drafts  →  /api/assignment-drafts
// ---------------------------------------------------------------------------
//
// Server-backed "draft cart" used by the Assignments page. Every per-row
// modal stages an op via `upsert(...)`; the toolbar "+ Assign (N)" button
// calls `commit(...)` to drain the cart by delegating each draft to the
// regular assignment orchestrators on the server. The cart survives page
// reloads and is shared across tabs/operators because it's the CSV.

/** Invalidate draft cache. */
function invalidateDrafts() {
  cache.invalidate(`${API_BASE}/api/assignment-drafts`);
}

export const assignmentDrafts = {
  list: (date: string) =>
    request<AssignmentDraftRow[]>(
      `/api/assignment-drafts?date=${encodeURIComponent(date)}`,
    ),

  upsert: (input: AssignmentDraftStageInput) =>
    request<AssignmentDraftRow>('/api/assignment-drafts', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateDrafts(); return r; }),

  remove: (trainId: string, date: string) =>
    request<void>(
      `/api/assignment-drafts/${encodeURIComponent(trainId)}?date=${encodeURIComponent(date)}`,
      { method: 'DELETE' },
    ).then((r) => { invalidateDrafts(); return r; }),

  reset: (date: string) =>
    request<void>(
      `/api/assignment-drafts?date=${encodeURIComponent(date)}`,
      { method: 'DELETE' },
    ).then((r) => { invalidateDrafts(); return r; }),

  commit: (date: string) =>
    request<AssignmentDraftCommitResponse>(
      `/api/assignment-drafts/commit?date=${encodeURIComponent(date)}`,
      { method: 'POST' },
    ).then((r) => { invalidateDrafts(); invalidateAssignments(); return r; }),
};

// ---------------------------------------------------------------------------
// Leaves  →  /api/leaves
// ---------------------------------------------------------------------------

/** Invalidate leave-related caches. */
function invalidateLeaves() {
  cache.invalidate(`${API_BASE}/api/leaves`);
  cache.invalidate(`${API_BASE}/api/eligible-crew`);
  cache.invalidate(`${API_BASE}/api/summary`);
}

export const leaves = {
  list: () => request<LeaveRow[]>('/api/leaves'),

  create: (input: LeaveCreateInput) =>
    request<LeaveRow>('/api/leaves', {
      method: 'POST',
      jsonBody: input,
    }).then((r) => { invalidateLeaves(); return r; }),

  update: (id: string, patch: LeaveUpdateInput) =>
    request<LeaveRow>(`/api/leaves/${encodeURIComponent(id)}`, {
      method: 'PUT',
      jsonBody: patch,
    }).then((r) => { invalidateLeaves(); return r; }),

  archive: (id: string) =>
    request<void>(`/api/leaves/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    }).then((r) => { invalidateLeaves(); return r; }),
};

// ---------------------------------------------------------------------------
// Crew Diary  →  /api/crew-diary
// ---------------------------------------------------------------------------
//
// Per-crew month-wise assignment listing for the Crew Diary tab. The page
// hydrates this whenever the operator picks a different crew member or a
// different month — the response is small (one row per run) so a fresh
// fetch per change is preferable to client-side caching.

export const crewDiary = {
  /**
   * @param crewId LP or ALP id (the server probes both rosters).
   * @param month  IST `YYYY-MM`.
   */
  get: (crewId: string, month: string) =>
    request<CrewDiaryResponse>(
      `/api/crew-diary?crewId=${encodeURIComponent(crewId)}&month=${encodeURIComponent(month)}`,
    ),
};

// ---------------------------------------------------------------------------
// Summary  →  /api/summary
// ---------------------------------------------------------------------------

export const summary = {
  get: (date: string) =>
    request<SummaryResponse>(`/api/summary?date=${encodeURIComponent(date)}`),
};

// ---------------------------------------------------------------------------
// Health  →  /api/health   (used by dev tooling / readiness probes)
// ---------------------------------------------------------------------------

export const health = {
  get: () => request<{ ok: true; dataDir: string }>('/api/health'),
};

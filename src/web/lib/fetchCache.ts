// Lightweight in-memory fetch cache with TTL.
//
// Designed for the RPMS SPA where pages share many of the same GET endpoints.
// When switching tabs the same data is often requested within seconds — this
// cache prevents redundant network round-trips (especially important with the
// Google Sheets backend, which is slower than local CSV).
//
// Features:
//   1. **TTL** — cached responses expire after `DEFAULT_TTL_MS` (30 s).
//   2. **In-flight deduplication** — if the same URL is already being fetched,
//      the second caller piggy-backs on the first promise instead of launching
//      a parallel request.
//   3. **Targeted invalidation** — after a mutation, call
//      `invalidate('/api/trains')` to evict every cache key that starts with
//      that prefix. The next `get()` for that resource will be a real fetch.
//   4. **Global clear** — `invalidateAll()` evicts everything (used by the
//      summary refresh path as a catch-all).
//
// Only GET requests go through this cache. Mutations (POST/PUT/DELETE) always
// hit the network directly.

/** Milliseconds a cached response stays valid. */
const DEFAULT_TTL_MS = 30_000; // 30 seconds

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number; // Date.now() + TTL
}

/** Pending in-flight requests keyed by URL — prevents duplicate GETs. */
const inflight = new Map<string, Promise<unknown>>();

/** Resolved responses keyed by URL. */
const store = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return cached data if fresh, otherwise return `undefined`.
 */
export function get<T>(url: string): T | undefined {
  const entry = store.get(url);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(url);
    return undefined;
  }
  return entry.data as T;
}

/**
 * Store a response in the cache with the default TTL.
 */
export function set<T>(url: string, data: T): void {
  store.set(url, { data, expiresAt: Date.now() + DEFAULT_TTL_MS });
}

/**
 * If an identical GET is already in flight, return its promise so callers
 * share the same network request. Returns `undefined` when no request is
 * pending for `url`.
 */
export function getInflight<T>(url: string): Promise<T> | undefined {
  return inflight.get(url) as Promise<T> | undefined;
}

/**
 * Register a promise as the in-flight request for `url`. When the promise
 * settles (resolve or reject) the entry is automatically removed.
 */
export function setInflight<T>(url: string, promise: Promise<T>): void {
  inflight.set(url, promise);
  const cleanup = () => {
    // Only delete if the map still points to *this* promise (a later caller
    // may have replaced it).
    if (inflight.get(url) === promise) inflight.delete(url);
  };
  promise.then(cleanup, cleanup);
}

/**
 * Evict every cache entry whose key starts with `prefix`.
 *
 * Example: `invalidate('/api/trains')` removes cached responses for
 * `/api/trains`, `/api/trains?date=2026-05-17`, etc.
 */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * Evict the entire cache. Useful after broad mutations that touch multiple
 * resources (e.g. committing assignment drafts affects assignments + summary).
 */
export function invalidateAll(): void {
  store.clear();
}

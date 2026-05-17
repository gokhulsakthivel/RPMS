// In-memory caching decorator for any TableStore.
//
// Wraps a delegate store and caches `read()` results per table for a
// configurable TTL. After `mutate()` the cache is updated in-place with
// the post-transform result so back-to-back mutations (e.g. the commit
// loop) reuse the warm cache instead of re-reading from the delegate.
//
// This is critical for the Google Sheets backend where every read is an
// HTTP round-trip to the Sheets API (which enforces per-minute quotas).
// With a 60 s TTL the server can handle many browser requests from the
// same operator without exhausting the "Read requests per minute" quota.
//
// For the CSV backend this wrapper is unnecessary (local disk I/O is fast
// and has no quota), so the composition root in server.ts only applies it
// when `RPMS_STORAGE=sheets`.

import type { Row, TableStore } from './tableStore';

/** Default time-to-live for cached reads: 60 seconds. */
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  rows: Row[];
  expiresAt: number;
}

export class CachedTableStore implements TableStore {
  private readonly delegate: TableStore;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * In-flight read promises keyed by `table + '\0' + header`. When multiple
   * requests arrive for the same table concurrently, only the first one hits
   * the delegate — the rest piggy-back on the same promise.
   */
  private readonly inflight = new Map<string, Promise<Row[]>>();

  constructor(delegate: TableStore, ttlMs = DEFAULT_TTL_MS) {
    this.delegate = delegate;
    this.ttlMs = ttlMs;
  }

  async read(table: string, header: readonly string[]): Promise<Row[]> {
    const key = this.cacheKey(table, header);

    // 1. Return from cache if still fresh.
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return this.deepCopyRows(cached.rows);
    }

    // 2. Deduplicate concurrent reads for the same table.
    const pending = this.inflight.get(key);
    if (pending) {
      const rows = await pending;
      return this.deepCopyRows(rows);
    }

    // 3. Fetch from delegate, cache, and return.
    const promise = this.delegate.read(table, header);
    this.inflight.set(key, promise);

    try {
      const rows = await promise;
      this.cache.set(key, {
        rows,
        expiresAt: Date.now() + this.ttlMs,
      });
      return this.deepCopyRows(rows);
    } finally {
      this.inflight.delete(key);
    }
  }

  async mutate(
    table: string,
    header: readonly string[],
    transform: (rows: Row[]) => Row[] | Promise<Row[]>,
  ): Promise<void> {
    const key = this.cacheKey(table, header);

    // If the cache is warm, pass it to the delegate as `knownRows` so
    // backends with expensive reads (Google Sheets) can skip the round-trip.
    const cached = this.cache.get(key);
    const knownRows =
      cached && Date.now() < cached.expiresAt
        ? this.deepCopyRows(cached.rows)
        : undefined;

    // Wrap the transform to capture the post-mutation result. The captured
    // rows are used to update the cache in-place — subsequent reads and
    // mutations hit the warm cache instead of re-reading from the delegate.
    let captured: Row[] | undefined;
    const wrappedTransform = async (rows: Row[]) => {
      const result = await transform(rows);
      captured = result.map((r) => ({ ...r }));
      return result;
    };

    await this.delegate.mutate(table, header, wrappedTransform, knownRows);

    // Update cache in-place with the mutation result so the next operation
    // on this table (read or another mutate) hits the warm cache.
    if (captured) {
      this.cache.set(key, {
        rows: captured,
        expiresAt: Date.now() + this.ttlMs,
      });
    } else {
      this.invalidate(table);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Invalidate all cache entries for a given table. Called after mutate()
   * and can also be called externally if needed.
   */
  invalidate(table: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(table + '\0')) {
        this.cache.delete(key);
      }
    }
  }

  /** Invalidate all tables. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private cacheKey(table: string, header: readonly string[]): string {
    return table + '\0' + header.join(',');
  }

  /**
   * Return a shallow copy of each row so callers can't accidentally mutate
   * cached data.
   */
  private deepCopyRows(rows: Row[]): Row[] {
    return rows.map((row) => ({ ...row }));
  }
}

// Cross-process advisory lock around CSV mutations.
//
// LLD §5.4 mandates "whole-file rewrite under a single-writer lock". We use
// `proper-lockfile` so two `node` processes (e.g. dev API + a one-shot script)
// cannot interleave writes against the same CSV. In-process serialisation
// alone is not enough because tsx/vite-watch can spawn fresh workers.
//
// Lock files live next to their target: `data/trains.csv` → `data/trains.csv.lock`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

/** Default options tuned for our short, in-memory rewrite cycles. */
const LOCK_OPTIONS = {
  // proper-lockfile uses stale to garbage-collect crashed-process locks.
  // 30s is long enough to cover a debugger-paused write but short enough
  // that a real crash does not block subsequent writers indefinitely.
  stale: 30_000,
  // Wait briefly under contention; fail fast otherwise so callers see real
  // errors instead of silent hangs.
  retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
};

/**
 * Run `fn` while holding an exclusive advisory lock on `filePath`. The file
 * must already exist (the seed CSVs are committed with their headers); we
 * `touch` it as a safety net to avoid `proper-lockfile` ENOENT during local
 * sandbox setup.
 *
 * The lock is released even if `fn` throws.
 */
export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureFileExists(filePath);
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Create the file (with an empty body) if it is missing. We never invent
 * headers here — the repo layer asserts the header on read, so an empty file
 * will surface as a clear contract violation rather than silent corruption.
 */
async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '', { flag: 'wx' }).catch(() => {
      // Race: another process created it between access() and writeFile().
      // That's fine — the file now exists.
    });
  }
}

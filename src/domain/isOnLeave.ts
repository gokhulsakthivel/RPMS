import { Leave } from './types';

/**
 * Does any non-archived leave window in `leaves` cover `runDate`?
 *
 * Pure, deterministic, side-effect free. The window is **inclusive on both
 * ends** in IST calendar dates — a row blocks the run iff
 * `fromDate <= runDate <= toDate`. Lexicographic compare is safe because
 * dates are stored as zero-padded `YYYY-MM-DD`.
 *
 * Archived leaves are ignored; the caller passes whatever set of records
 * is relevant (typically pre-filtered by `crewId`).
 *
 * Returns the **first** covering leave so the orchestrator can surface
 * the leave type and window to the UI. `null` means "not on leave".
 *
 * Source of truth: HLD §4.4 / LLD §3.5.
 */
export function findCoveringLeave(
  leaves: ReadonlyArray<Leave>,
  runDate: string,
): Leave | null {
  for (const leave of leaves) {
    if (leave.archivedAt) continue;
    if (leave.fromDate <= runDate && runDate <= leave.toDate) return leave;
  }
  return null;
}

/**
 * Boolean form of `findCoveringLeave`. Useful when the caller does not
 * need the matching record (e.g. the eligibility-list projection).
 */
export function isOnLeave(
  leaves: ReadonlyArray<Leave>,
  runDate: string,
): boolean {
  return findCoveringLeave(leaves, runDate) !== null;
}

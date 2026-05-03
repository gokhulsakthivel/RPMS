import { Assignment } from './types';

/**
 * Closed-interval overlap check. Two intervals `[a, b]` and `[c, d]` overlap
 * iff `a <= d` AND `c <= b`. The sign-off instant is still "on duty", so the
 * interval is closed on both ends.
 *
 * The orchestrator MUST pass only **active** (non-archived) assignments here;
 * archived rows are excluded by the repository layer per HLD §4.6/§4.8.
 *
 * Source of truth: HLD §4.6 / LLD §3.5.
 */
export function hasWindowConflict(
  candidateWindow: { departureTime: Date; signOffTime: Date },
  existingAssignments: Assignment[],
): boolean {
  return existingAssignments.some((a) =>
    candidateWindow.departureTime.getTime() <= a.signOffTime.getTime() &&
    a.departureTime.getTime() <= candidateWindow.signOffTime.getTime()
  );
}

/**
 * Same overlap predicate, but returns the FIRST conflicting assignment so the
 * orchestrator can surface its id in the structured error
 * (`LP_WINDOW_CONFLICT.conflictingAssignmentId`, etc.).
 */
export function findWindowConflict(
  candidateWindow: { departureTime: Date; signOffTime: Date },
  existingAssignments: Assignment[],
): Assignment | undefined {
  return existingAssignments.find((a) =>
    candidateWindow.departureTime.getTime() <= a.signOffTime.getTime() &&
    a.departureTime.getTime() <= candidateWindow.signOffTime.getTime()
  );
}

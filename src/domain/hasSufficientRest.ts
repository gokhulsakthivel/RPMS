// MIN_REST_HOURS — single source of truth for the rest window.
// AGENTS.md non-negotiable #2: this is the ONLY place the literal `16`
// may appear in the codebase. Update only here when policy changes.
export const MIN_REST_HOURS = 16;

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * Is the given crew member rested enough to sign on at `trainDepartureTime`?
 *
 * Pure, deterministic, side-effect free. The orchestrator passes the train's
 * `departureTime` in directly — never read `Date.now()` here.
 *
 * Source of truth: HLD §4.3 / LLD §3.4.
 */
export function hasSufficientRest(
  crew: { lastSignOffTime?: Date },
  trainDepartureTime: Date,
): boolean {
  if (!crew.lastSignOffTime) return true; // brand-new crew are immediately assignable
  const diffMs = trainDepartureTime.getTime() - crew.lastSignOffTime.getTime();
  const diffHours = diffMs / MS_PER_HOUR;
  return diffHours >= MIN_REST_HOURS;
}

/**
 * Hours of rest **remaining** until the crew member becomes assignable for
 * `trainDepartureTime`. Negative or zero values mean "already rested".
 *
 * Used by the API layer to populate `<RestBar>` ([components.md §6.1]).
 * The UI rounds with `Math.ceil` per design.md §9.2.
 */
export function hoursRestRemaining(
  crew: { lastSignOffTime?: Date },
  trainDepartureTime: Date,
): number {
  if (!crew.lastSignOffTime) return 0;
  const elapsedHours =
    (trainDepartureTime.getTime() - crew.lastSignOffTime.getTime()) / MS_PER_HOUR;
  return Math.max(0, MIN_REST_HOURS - elapsedHours);
}

// Pure helpers for resolving a crew member's position on a Link for any
// calendar date (HLD §4.10 / LLD §3.7).
//
// All functions are pure: no I/O, no `Date.now()`, no `Math.random()`.
// IST-day math is timezone-clean — IST has no DST, so the IST day-of-month
// equals the UTC day-of-month at midnight UTC of the same calendar date.

import type { Link, LinkMembership, LinkPosition } from './types';

/** `YYYY-MM-DD` — same shape as `runDate` elsewhere in the codebase. */
type IsoDate = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute the 1-based position a crew member sits at on `runDate`.
 *
 * The link rotation is `cycleLength` long; advancing by one position per
 * IST calendar day. `runDate` may be before the anchor — `delta` is allowed
 * to be negative, and the helper uses a sign-safe modulo so callers always
 * get a value in `[1..cycleLength]`.
 *
 * @throws if any of the inputs are malformed (bad date, non-positive
 *         cycleLength, anchor position outside `[1..cycleLength]`). Phase-1
 *         schemas reject these at the API boundary; the throw here is
 *         defence-in-depth so corrupt CSV rows surface immediately.
 */
export function positionOnDate(
  link: Pick<Link, 'cycleLength'>,
  membership: Pick<LinkMembership, 'anchorDate' | 'anchorPositionNumber'>,
  runDate: IsoDate,
): number {
  if (!Number.isInteger(link.cycleLength) || link.cycleLength < 1) {
    throw new Error(
      `positionOnDate: cycleLength must be a positive integer (got ${link.cycleLength})`,
    );
  }
  if (
    !Number.isInteger(membership.anchorPositionNumber) ||
    membership.anchorPositionNumber < 1 ||
    membership.anchorPositionNumber > link.cycleLength
  ) {
    throw new Error(
      `positionOnDate: anchorPositionNumber must be in [1..${link.cycleLength}] (got ${membership.anchorPositionNumber})`,
    );
  }
  if (!ISO_DATE_RE.test(membership.anchorDate)) {
    throw new Error(
      `positionOnDate: anchorDate must be YYYY-MM-DD (got ${JSON.stringify(membership.anchorDate)})`,
    );
  }
  if (!ISO_DATE_RE.test(runDate)) {
    throw new Error(
      `positionOnDate: runDate must be YYYY-MM-DD (got ${JSON.stringify(runDate)})`,
    );
  }

  const delta = istCalendarDelta(membership.anchorDate, runDate);
  const zeroBased = membership.anchorPositionNumber - 1 + delta;
  // JS `%` is sign-preserving (e.g. -1 % 19 = -1). Wrap so the result is
  // always non-negative before adding 1.
  const wrapped = ((zeroBased % link.cycleLength) + link.cycleLength) % link.cycleLength;
  return wrapped + 1;
}

/**
 * Return the resolved `LinkPosition` for the given run date, alongside its
 * 1-based number. Convenience for callers that need to inspect segments
 * (the Auto-Draft orchestrator in Phase 3, the projection endpoint in
 * Phase 2).
 *
 * @throws if `link.positions` is malformed (does not satisfy
 *         `positions[i].positionNumber === i + 1`).
 */
export function resolvePositionForRun(
  link: Link,
  membership: LinkMembership,
  runDate: IsoDate,
): { positionNumber: number; position: LinkPosition } {
  if (link.positions.length !== link.cycleLength) {
    throw new Error(
      `resolvePositionForRun: positions.length (${link.positions.length}) !== cycleLength (${link.cycleLength}) for link ${link.id}`,
    );
  }
  const positionNumber = positionOnDate(link, membership, runDate);
  const position = link.positions[positionNumber - 1];
  if (!position || position.positionNumber !== positionNumber) {
    throw new Error(
      `resolvePositionForRun: positions[${positionNumber - 1}] is missing or has the wrong positionNumber for link ${link.id}`,
    );
  }
  return { positionNumber, position };
}

/**
 * Integer-day delta between two IST `YYYY-MM-DD` dates. Pure: parses the
 * date fields directly into `Date.UTC` so the math is timezone-clean.
 */
function istCalendarDelta(from: IsoDate, to: IsoDate): number {
  const fromMs = parseIsoDateToUtcMidnight(from);
  const toMs = parseIsoDateToUtcMidnight(to);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

function parseIsoDateToUtcMidnight(iso: IsoDate): number {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) {
    throw new Error(`linkSchedule: bad isoDate ${JSON.stringify(iso)}`);
  }
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

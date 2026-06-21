//
// Resolve the OUTWARD pair for an INWARD link segment.
//
// The depot's hand-printed links pair each inward leg (a return run that
// terminates at the home depot) with the outward leg the same crew drove
// out from the depot on. Because the rotation advances one position per
// IST calendar day, the pair lives either:
//
//   - in the SAME position (same-day pair) — the operator did a
//     round-trip the same day, e.g. Passenger link pos 1 = 56109 CBE→POY
//     followed by 56114 POY→CBE.
//   - in the PREVIOUS position (overnight pair) — the operator slept
//     outstation; e.g. Mail link pos 1 = 13351 CBE→ERS (day D), pos 2 =
//     13352 ERS→CBE (day D+1) is driven by the SAME crew as yesterday's
//     pos 1.
//
// Algorithm:
//   1. Walk backwards through THIS position's segments from segmentIndex.
//      Return the first one tagged `outward` — that's the same-day pair.
//   2. If no outward is found within this position, walk to position N-1
//      (cyclic). If it's DUTY, walk its segments from last to first and
//      return the first one tagged `outward` — that's the overnight pair.
//   3. Otherwise return undefined.
//
// Structural typing: works for both the domain `Link` shape
// (`LinkPositionKind.DUTY` enum) and the wire `LinkRow` shape (string
// literal `'DUTY'`) because both serialize identically as `'DUTY'`.

export type LinkDirection = 'outward' | 'inward' | 'conti';

export interface PairSegmentLike {
  trainNumber: string;
  direction?: LinkDirection;
}

export type PairPositionLike<TSeg extends PairSegmentLike = PairSegmentLike> =
  | { positionNumber: number; kind: 'DUTY'; segments: ReadonlyArray<TSeg> }
  | { positionNumber: number; kind: 'OFF' }
  | { positionNumber: number; kind: 'PR' };

export interface PairLinkLike<TSeg extends PairSegmentLike = PairSegmentLike> {
  cycleLength: number;
  positions: ReadonlyArray<PairPositionLike<TSeg>>;
}

export type PairKind = 'same-day' | 'overnight';

export interface OutwardPair<TSeg extends PairSegmentLike = PairSegmentLike> {
  outward: TSeg;
  positionNumber: number;
  segmentIndex: number;
  pairKind: PairKind;
}

/**
 * Find the outward pair for `segments[segmentIndex]` inside
 * `positions[positionNumber - 1]`. Returns `undefined` when the segment
 * is not tagged `inward` or no outward is reachable.
 */
export function findOutwardPair<TSeg extends PairSegmentLike>(
  link: PairLinkLike<TSeg>,
  positionNumber: number,
  segmentIndex: number,
): OutwardPair<TSeg> | undefined {
  const position = findPosition(link, positionNumber);
  if (!position || position.kind !== 'DUTY') return undefined;
  const seg = position.segments[segmentIndex];
  if (!seg || seg.direction !== 'inward') return undefined;

  for (let i = segmentIndex - 1; i >= 0; i--) {
    const candidate = position.segments[i];
    if (candidate && candidate.direction === 'outward') {
      return {
        outward: candidate,
        positionNumber,
        segmentIndex: i,
        pairKind: 'same-day',
      };
    }
  }

  const prevNumber = previousPositionNumber(positionNumber, link.cycleLength);
  const prevPos = findPosition(link, prevNumber);
  if (!prevPos || prevPos.kind !== 'DUTY') return undefined;
  for (let i = prevPos.segments.length - 1; i >= 0; i--) {
    const candidate = prevPos.segments[i];
    if (candidate && candidate.direction === 'outward') {
      return {
        outward: candidate,
        positionNumber: prevNumber,
        segmentIndex: i,
        pairKind: 'overnight',
      };
    }
  }
  return undefined;
}

function findPosition<TSeg extends PairSegmentLike>(
  link: PairLinkLike<TSeg>,
  positionNumber: number,
): PairPositionLike<TSeg> | undefined {
  return link.positions.find((p) => p.positionNumber === positionNumber);
}

function previousPositionNumber(positionNumber: number, cycleLength: number): number {
  if (cycleLength < 1) return positionNumber;
  return positionNumber === 1 ? cycleLength : positionNumber - 1;
}

/**
 * Derive the outward leg's run date (IST, `YYYY-MM-DD`) from the inward
 * leg's run date and the pair kind. Pure: parses via `Date.UTC`.
 */
export function outwardRunDate(inwardRunDate: string, pairKind: PairKind): string {
  if (pairKind === 'same-day') return inwardRunDate;
  const y = Number(inwardRunDate.slice(0, 4));
  const m = Number(inwardRunDate.slice(5, 7));
  const d = Number(inwardRunDate.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d) - 86400000;
  const dt = new Date(ms);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

//
// Build a `trainNumber → LinkContext` map for the Plan / Assignments table.
//
// The context drives the row's secondary hint line ("↩ from 13351 ·
// 2026-06-13 · LP: …, ALP: …"). It complements `linkSuggestions.ts` —
// suggestions feed the modal pre-fill, contexts feed the row display.
//
// Pairing uses the direction-tagged walk in `domain/linkPairing`:
//   - INWARD seg → look up its OUTWARD pair (same-day or overnight).
//   - other segs → no pairing hint.
//
// Crew names attached to the pair come from the assignments for the
// outward leg's run date (live data wins over rotation guesses).

import type {
  AssignmentRow,
  LinkProjectionRow,
  LinkRow,
  LinkSegmentRow,
} from '../../../shared/schemas';
import { findOutwardPair, outwardRunDate } from '../../../domain/linkPairing';

export interface ContextSegment {
  trainNumber: string;
  direction?: 'outward' | 'inward' | 'conti';
  fromStation?: string;
  toStation?: string;
  signOnTimeOfDay: string;
  signOffTimeOfDay: string;
  signOffDayOffset: number;
}

export interface PairedOutward {
  trainNumber: string;
  fromStation?: string;
  toStation?: string;
  /** Calendar date the outward leg ran on (YYYY-MM-DD, IST). */
  runDate: string;
  /** Source position number on the same link. */
  positionNumber: number;
  /** 'same-day' or 'overnight' (overnight = ran yesterday). */
  pairKind: 'same-day' | 'overnight';
  /** Crew assigned to the OUTWARD leg, if any. */
  lpName?: string;
  alpName?: string;
}

export interface LinkContext {
  linkId: string;
  linkName: string;
  positionNumber: number;
  matchedSegment: ContextSegment;
  /** Set when the matched segment is inward and has a resolvable pair. */
  pairedOutward?: PairedOutward;
}

export interface BuildLinkContextOptions {
  sameDayAssignmentsByTrain?: ReadonlyMap<string, AssignmentRow>;
  prevDayAssignmentsByTrain?: ReadonlyMap<string, AssignmentRow>;
}

export function buildLinkContextByTrainNumber(
  projection: readonly LinkProjectionRow[],
  linksById: ReadonlyMap<string, LinkRow>,
  runDate: string,
  options: BuildLinkContextOptions = {},
): ReadonlyMap<string, LinkContext> {
  const out = new Map<string, LinkContext>();
  const { sameDayAssignmentsByTrain, prevDayAssignmentsByTrain } = options;

  for (const row of projection) {
    if (row.position.kind !== 'DUTY') continue;
    const link = linksById.get(row.linkId);
    if (!link) continue;
    for (let i = 0; i < row.position.segments.length; i++) {
      const seg = row.position.segments[i];
      if (!seg) continue;
      if (out.has(seg.trainNumber)) continue; // first-wins
      const ctx: LinkContext = {
        linkId: row.linkId,
        linkName: row.linkName,
        positionNumber: row.positionNumber,
        matchedSegment: toContextSegment(seg),
      };
      const paired = resolvePairedOutward(
        link,
        row.positionNumber,
        i,
        runDate,
        sameDayAssignmentsByTrain,
        prevDayAssignmentsByTrain,
      );
      if (paired) ctx.pairedOutward = paired;
      out.set(seg.trainNumber, ctx);
    }
  }
  return out;
}

function toContextSegment(s: LinkSegmentRow): ContextSegment {
  const out: ContextSegment = {
    trainNumber: s.trainNumber,
    signOnTimeOfDay: s.signOnTimeOfDay,
    signOffTimeOfDay: s.signOffTimeOfDay,
    signOffDayOffset: s.signOffDayOffset,
  };
  if (s.direction) out.direction = s.direction;
  if (s.fromStation) out.fromStation = s.fromStation;
  if (s.toStation) out.toStation = s.toStation;
  return out;
}

function resolvePairedOutward(
  link: LinkRow,
  positionNumber: number,
  segmentIndex: number,
  runDate: string,
  sameDay: ReadonlyMap<string, AssignmentRow> | undefined,
  prevDay: ReadonlyMap<string, AssignmentRow> | undefined,
): PairedOutward | undefined {
  const pair = findOutwardPair(link, positionNumber, segmentIndex);
  if (!pair) return undefined;
  const outRunDate = outwardRunDate(runDate, pair.pairKind);
  const map = pair.pairKind === 'overnight' ? prevDay : sameDay;
  const assignment = map?.get(pair.outward.trainNumber);
  const result: PairedOutward = {
    trainNumber: pair.outward.trainNumber,
    runDate: outRunDate,
    positionNumber: pair.positionNumber,
    pairKind: pair.pairKind,
  };
  if (pair.outward.fromStation) result.fromStation = pair.outward.fromStation;
  if (pair.outward.toStation) result.toStation = pair.outward.toStation;
  if (assignment?.lp) result.lpName = assignment.lp.name;
  if (assignment?.alp && assignment.alp !== 'NOT_REQUIRED') {
    result.alpName = assignment.alp.name;
  }
  return result;
}

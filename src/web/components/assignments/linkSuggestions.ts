//
// Build a `trainNumber → LinkSuggestion` map for pre-filling the Assign /
// Edit modals on the Plan page.
//
// Three layered sources, applied per (trainNumber, segment direction):
//
//   1. OUTWARD / CONTI / untagged segment → prefer the SAME-DAY assignment
//      for this train's outward leg; fall back to the projection's
//      rotation pick.
//   2. INWARD segment → prefer the paired OUTWARD train's assignment
//      (same-day if both legs are in this position; previous-day if the
//      outward sits in position N-1). Fall back to this train's own
//      same-day assignment if any, then to the projection's rotation
//      pick.
//
// Tie-breaking remains "first projection row wins" when the same train
// number appears on multiple links' DUTY positions.

import type {
  AssignmentRow,
  LinkProjectionRow,
  LinkRow,
  LinkSegmentRow,
} from '../../../shared/schemas';
import { findOutwardPair } from '../../../domain/linkPairing';

export interface SuggestedPick {
  id: string;
  name: string;
  linkName: string;
  /** Where the suggestion ultimately came from. */
  source: 'assignment-same-day' | 'assignment-outward-pair' | 'projection';
}

export interface LinkSuggestion {
  lp?: SuggestedPick;
  alp?: SuggestedPick;
}

export interface BuildSuggestionOptions {
  linksById?: ReadonlyMap<string, LinkRow>;
  sameDayAssignmentsByTrain?: ReadonlyMap<string, AssignmentRow>;
  prevDayAssignmentsByTrain?: ReadonlyMap<string, AssignmentRow>;
}

/**
 * Build the suggestion lookup. The assignment maps are optional —
 * without them this degrades to the original projection-only behavior.
 */
export function buildSuggestionByTrainNumber(
  projection: readonly LinkProjectionRow[],
  options: BuildSuggestionOptions = {},
): ReadonlyMap<string, LinkSuggestion> {
  const {
    linksById,
    sameDayAssignmentsByTrain,
    prevDayAssignmentsByTrain,
  } = options;

  // Baseline: projection-only picks (legacy semantics, first-wins).
  const out = new Map<string, LinkSuggestion>();
  for (const row of projection) {
    if (row.position.kind !== 'DUTY') continue;
    for (const seg of row.position.segments) {
      const existing = out.get(seg.trainNumber);
      const pick: SuggestedPick = {
        id: row.crewId,
        name: row.crewName,
        linkName: row.linkName,
        source: 'projection',
      };
      if (row.crewRole === 'LP') {
        if (existing) {
          if (!existing.lp) existing.lp = pick;
        } else {
          out.set(seg.trainNumber, { lp: pick });
        }
      } else {
        if (existing) {
          if (!existing.alp) existing.alp = pick;
        } else {
          out.set(seg.trainNumber, { alp: pick });
        }
      }
    }
  }

  if (!sameDayAssignmentsByTrain && !prevDayAssignmentsByTrain) {
    return out;
  }

  // Upgrade pass: chain through assignments where the segment direction
  // tells us we can do better than the rotation pick.
  for (const row of projection) {
    if (row.position.kind !== 'DUTY') continue;
    const link = linksById?.get(row.linkId);
    for (let i = 0; i < row.position.segments.length; i++) {
      const seg = row.position.segments[i];
      if (!seg) continue;
      const chained = resolveChainedPick(
        seg,
        row.positionNumber,
        i,
        row.linkName,
        link,
        sameDayAssignmentsByTrain,
        prevDayAssignmentsByTrain,
      );
      if (!chained.lp && !chained.alp) continue;
      const existing = out.get(seg.trainNumber) ?? {};
      const merged: LinkSuggestion = { ...existing };
      if (chained.lp && shouldUpgrade(existing.lp, chained.lp)) {
        merged.lp = chained.lp;
      }
      if (chained.alp && shouldUpgrade(existing.alp, chained.alp)) {
        merged.alp = chained.alp;
      }
      out.set(seg.trainNumber, merged);
    }
  }
  return out;
}

function shouldUpgrade(
  existing: SuggestedPick | undefined,
  candidate: SuggestedPick,
): boolean {
  if (!existing) return true;
  if (existing.source === 'projection') return true;
  // outward-pair always beats same-day-self for an inward train.
  if (candidate.source === 'assignment-outward-pair' && existing.source === 'assignment-same-day') {
    return true;
  }
  return false;
}

function resolveChainedPick(
  seg: LinkSegmentRow,
  positionNumber: number,
  segmentIndex: number,
  linkName: string,
  link: LinkRow | undefined,
  sameDay: ReadonlyMap<string, AssignmentRow> | undefined,
  prevDay: ReadonlyMap<string, AssignmentRow> | undefined,
): LinkSuggestion {
  if (seg.direction === 'inward' && link) {
    const pair = findOutwardPair(link, positionNumber, segmentIndex);
    if (pair) {
      const map = pair.pairKind === 'overnight' ? prevDay : sameDay;
      const a = map?.get(pair.outward.trainNumber);
      if (a) return toSuggestion(a, linkName, 'assignment-outward-pair');
      // Fall through to same-day-self lookup.
    }
    const self = sameDay?.get(seg.trainNumber);
    if (self) return toSuggestion(self, linkName, 'assignment-same-day');
    return {};
  }
  // OUTWARD / CONTI / untagged: prefer same-day own assignment.
  const a = sameDay?.get(seg.trainNumber);
  if (a) return toSuggestion(a, linkName, 'assignment-same-day');
  return {};
}

function toSuggestion(
  a: AssignmentRow,
  linkName: string,
  source: SuggestedPick['source'],
): LinkSuggestion {
  const out: LinkSuggestion = {};
  if (a.lp) {
    out.lp = { id: a.lp.id, name: a.lp.name, linkName, source };
  }
  if (a.alp && a.alp !== 'NOT_REQUIRED') {
    out.alp = { id: a.alp.id, name: a.alp.name, linkName, source };
  }
  return out;
}

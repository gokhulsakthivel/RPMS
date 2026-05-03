// `HiddenCrewFootnote` — grey footnote under each AssignCrewModal dropdown
// (components.md §10 / design.md §9.3).
//
// Renders the per-bucket counts coming back from `/api/eligible-crew`:
//   "Hidden: 8 not eligible, 3 still resting, 1 already assigned"
//
// `archived` crew are silently omitted (design.md §9.3) — they are filtered
// upstream and don't appear here.

import type { HiddenCount } from '../../../shared/schemas';

export interface HiddenCrewFootnoteProps {
  counts: HiddenCount;
}

export function HiddenCrewFootnote({ counts }: HiddenCrewFootnoteProps) {
  // Build the "Hidden: X not eligible, Y still resting, Z already assigned"
  // copy. Skip zero-count buckets so the line stays scannable. If no
  // buckets have hidden crew, render nothing.
  const parts: string[] = [];
  if (counts.notEligible > 0) parts.push(`${counts.notEligible} not eligible`);
  if (counts.resting > 0) parts.push(`${counts.resting} still resting`);
  if (counts.alreadyAssigned > 0) parts.push(`${counts.alreadyAssigned} already assigned`);

  if (parts.length === 0) return null;

  return (
    <p className="hidden-footnote">
      <span aria-hidden>↳ </span>
      Hidden: {parts.join(', ')}
    </p>
  );
}

// `CrewGradeBadge` — shows the highest-rank train type the crew member can
// drive (components.md §9 / design.md §9.2). The grade is computed
// **server-side** and arrives as `CrewRow.grade`. The UI never derives it.
//
// `null` grade — only seen on a brand-new ALP with no certifications —
// renders as a muted "—" so the column stays aligned.

import type { TrainType } from '../../../domain/types';
import { TrainTypeBadge } from '../trains/TrainTypeBadge';

export interface CrewGradeBadgeProps {
  grade: TrainType | null;
}

export function CrewGradeBadge({ grade }: CrewGradeBadgeProps) {
  if (grade === null) {
    return <span className="crew-grade__none" aria-label="No grade">—</span>;
  }
  // The grade is rendered as a TrainTypeBadge: the visual class of a
  // Mail/Express LP and a Mail/Express train should match (design.md §3.5).
  return <TrainTypeBadge type={grade} />;
}

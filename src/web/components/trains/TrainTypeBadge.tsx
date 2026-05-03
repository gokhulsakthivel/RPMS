// `TrainTypeBadge` — a `Badge` keyed off the `TrainType` enum
// (components.md §8 / design.md §3.5).
//
// Resolves the `--accent-{slug}-bg` / `--accent-{slug}-text` token pair
// via `tokenSlug(type)` and renders the long-form label.

import { TrainType } from '../../../domain/types';
import { longFormLabel, tokenSlug } from '../../lib/grade';
import { Badge } from '../primitives/Badge';

export interface TrainTypeBadgeProps {
  type: TrainType;
}

export function TrainTypeBadge({ type }: TrainTypeBadgeProps) {
  const slug = tokenSlug(type);
  return (
    <Badge
      bgVar={`--accent-${slug}-bg`}
      textVar={`--accent-${slug}-text`}
      aria-label={`Train type: ${longFormLabel(type)}`}
    >
      {longFormLabel(type)}
    </Badge>
  );
}

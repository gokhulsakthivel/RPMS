// `LeaveTypeBadge` — soft pill keyed off the `LeaveType` enum
// (HLD §4.4 / design.md §9.5).
//
// Sick / Leave / Training / PR each get their own accent token pair so
// the table is scannable at a glance. The Badge primitive renders the
// background/text from CSS custom properties — see `styles.css`.

import { LeaveType } from '../../../domain/types';
import { Badge } from '../primitives/Badge';

export interface LeaveTypeBadgeProps {
  type: LeaveType;
}

const LABEL: Record<LeaveType, string> = {
  [LeaveType.SICK]:     'Sick',
  [LeaveType.LEAVE]:    'Leave',
  [LeaveType.TRAINING]: 'Training',
  [LeaveType.PR]:       'PR',
};

const SLUG: Record<LeaveType, string> = {
  [LeaveType.SICK]:     'sick',
  [LeaveType.LEAVE]:    'leave',
  [LeaveType.TRAINING]: 'training',
  [LeaveType.PR]:       'pr',
};

export function LeaveTypeBadge({ type }: LeaveTypeBadgeProps) {
  const slug = SLUG[type];
  return (
    <Badge
      bgVar={`--accent-${slug}-bg`}
      textVar={`--accent-${slug}-text`}
      aria-label={`Leave type: ${LABEL[type]}`}
    >
      {LABEL[type]}
    </Badge>
  );
}

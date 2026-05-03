// `StatusBadge` — convenience wrapper for the two crew status pills
// (components.md §4 / design.md §3.3). Maps `available | resting` to the
// `--status-*-bg` / `--status-*-text` token pair so the call site is short.

import { Badge } from './Badge';

export interface StatusBadgeProps {
  status: 'available' | 'resting';
}

export function StatusBadge({ status }: StatusBadgeProps) {
  if (status === 'available') {
    return (
      <Badge
        bgVar="--status-available-bg"
        textVar="--status-available-text"
        aria-label="Status: available"
      >
        available
      </Badge>
    );
  }
  return (
    <Badge
      bgVar="--status-resting-bg"
      textVar="--status-resting-text"
      aria-label="Status: resting"
    >
      resting
    </Badge>
  );
}

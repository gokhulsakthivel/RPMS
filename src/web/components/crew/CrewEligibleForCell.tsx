// `CrewEligibleForCell` — renders the comma-separated short labels in the
// "Eligible for" column on the Crew tab (components.md §9 / design.md §9.2).
//
// The label string is server-projected (`CrewRow.eligibleForLabel`) so the
// UI never re-derives it. This component is currently a thin wrapper, but
// existing as its own component keeps the table cell strongly typed and
// gives us a hook for future tweaks (truncation, tooltips, etc.).

export interface CrewEligibleForCellProps {
  label: string;
}

export function CrewEligibleForCell({ label }: CrewEligibleForCellProps) {
  return (
    <span className="crew-eligible" title={label}>
      {label}
    </span>
  );
}

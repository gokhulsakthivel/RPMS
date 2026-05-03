// `RestBar` — 100×6px horizontal progress bar showing how many hours of
// the 16-hour rest window remain before a crew member is eligible again
// (components.md §7 / design.md §6).
//
// Critical contracts:
//   - Width is fixed at 100px so bars line up across rows.
//   - Color: green (`--rest-bar-ready`) when ready; red (`--rest-bar-resting`)
//     within the window.
//   - Fill width: `(hoursRemaining / 16) * 100%` when resting; 100% when ready.
//   - Label rounds **up** so the operator never sees `0h left` for a non-ready
//     crew. The 0-hour edge resolves server-side (state flips to `available`).
//   - All math is server-driven; the bar is a pure render of the `rest`
//     payload from `CrewRow`.

const MIN_REST_HOURS = 16;

export interface RestBarProps {
  /** From CrewRow.status — drives the color and label. */
  status: 'available' | 'resting';
  /** From CrewRow.rest.hoursRemaining. */
  hoursRemaining: number;
  /** From CrewRow.rest.neverSignedOff. Affects the label only. */
  neverSignedOff: boolean;
}

export function RestBar({
  status,
  hoursRemaining,
  neverSignedOff,
}: RestBarProps) {
  const ready = status === 'available';

  // Clamp hoursRemaining to [0, 16] for the visual fill — server should
  // already keep it in range, but defence in depth is cheap.
  const clamped = Math.max(0, Math.min(MIN_REST_HOURS, hoursRemaining));
  const fillPct = ready
    ? 100
    : Math.round((clamped / MIN_REST_HOURS) * 100);

  // Always round up so we never render "0h left" for a resting crew.
  const labelHours = Math.ceil(clamped);
  const label = ready
    ? (neverSignedOff ? 'Ready (new)' : 'Ready')
    : `${labelHours}h left`;

  return (
    <div className="rest-bar">
      <div
        className="rest-bar__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={MIN_REST_HOURS}
        aria-valuenow={ready ? MIN_REST_HOURS : Math.round(clamped)}
        aria-label={`Rest remaining: ${label}`}
      >
        <div
          className={`rest-bar__fill rest-bar__fill--${ready ? 'ready' : 'resting'}`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
      <span className="rest-bar__label">{label}</span>
    </div>
  );
}

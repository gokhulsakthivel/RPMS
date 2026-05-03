// Time helpers shared by frontend and backend.
//
// Storage rule (HLD §4.4 / techstack.md): all timestamps live in UTC. They
// are rendered in IST only at display boundaries. We never do ambiguous
// local-time math.
//
// We use the platform `Intl.DateTimeFormat` instead of pulling in a date
// library. IST is UTC+05:30 with no DST, so the offset is constant.

const IST_TIME_ZONE = 'Asia/Kolkata';
/** UTC+05:30 in milliseconds — IST has no DST, so this is exact. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateOnlyFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const timeOnlyFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Format a UTC `Date` as `dd MMM yyyy, HH:mm IST` for display.
 *
 *     formatIst(new Date('2026-05-02T18:30:00Z'))
 *     // => "03 May 2026, 00:00 IST"
 */
export function formatIst(d: Date): string {
  // en-IN renders "02 May 2026, 18:00" — we suffix " IST" so the timezone
  // is unambiguous on every screen.
  const parts = dateTimeFormatter.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const day = get('day');
  const month = get('month');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');
  return `${day} ${month} ${year}, ${hour}:${minute} IST`;
}

/** "03 May 2026" — used in date-only column headers. */
export function formatIstDate(d: Date): string {
  return dateOnlyFormatter.format(d);
}

/** "00:00 IST" — used where the calendar date is already shown elsewhere. */
export function formatIstTime(d: Date): string {
  return `${timeOnlyFormatter.format(d)} IST`;
}

/**
 * Convert an ISO date string `YYYY-MM-DD` (interpreted in IST) into the UTC
 * `Date` that represents the start of that IST day.
 *
 * IST is UTC+05:30, so 00:00 IST on 2026-05-02 is 18:30 UTC on 2026-05-01.
 * This is the anchor used by:
 *   - the `departingWithin` repo filter (HLD §4.x, LLD §5.5)
 *   - the summary-cards "Available crew" tally (design.md §9.4)
 *
 *     startOfDayIstAsUtc('2026-05-02').toISOString()
 *     // => "2026-05-01T18:30:00.000Z"
 */
export function startOfDayIstAsUtc(isoDate: string): Date {
  // Strict shape validation — bad input becomes a clear error rather than
  // a silently-wrong Date.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    throw new Error(
      `startOfDayIstAsUtc: expected YYYY-MM-DD, received ${JSON.stringify(isoDate)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Treat the date as 00:00 UTC, then subtract the IST offset to back into
  // the UTC instant that IST sees as midnight.
  const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(utcMidnight - IST_OFFSET_MS);
}

/**
 * Convenience: the UTC instant for `start of (isoDate + 1 day) in IST`.
 * Used as the half-open upper bound of `departingWithin`.
 */
export function startOfNextDayIstAsUtc(isoDate: string): Date {
  const start = startOfDayIstAsUtc(isoDate);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Today's date in IST as `YYYY-MM-DD`. The single source for the page-level
 * "today" reference (the `<DatePicker>` defaults to *tomorrow* IST per
 * design.md §2.1, computed off this).
 */
export function todayIstIsoDate(now: Date = new Date()): string {
  return dateOnlyFormatterIso.format(now);
}

const dateOnlyFormatterIso = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Tomorrow IST as `YYYY-MM-DD` — the DatePicker default. */
export function tomorrowIstIsoDate(now: Date = new Date()): string {
  // Add 24h to "now", then ask for the IST date. Adding 24h before formatting
  // is correct even across DST jumps elsewhere in the world because IST has
  // no DST.
  const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return todayIstIsoDate(next);
}

// ---------------------------------------------------------------------------
// IST wall-clock <-> UTC bridges for `<input type="datetime-local">`
//
// The native control reads/writes a "local-wall-clock" string of the form
// `YYYY-MM-DDTHH:mm` (no timezone). Operators type these as IST values, so
// the UI converts both directions through here. Living in `shared/time.ts`
// keeps the offset and parser in one place.
// ---------------------------------------------------------------------------

/**
 * Convert a UTC `Date` to the corresponding IST wall-clock string the
 * `<input type="datetime-local">` control expects (`YYYY-MM-DDTHH:mm`).
 *
 *     utcToIstWallClock(new Date('2026-05-02T09:00:00Z'))
 *     // => "2026-05-02T14:30"
 */
export function utcToIstWallClock(d: Date): string {
  const parts = wallClockFormatter.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Parse an IST wall-clock string from the `<input type="datetime-local">`
 * control into the UTC `Date` it represents.
 *
 *     istWallClockToUtc('2026-05-02T14:30').toISOString()
 *     // => "2026-05-02T09:00:00.000Z"
 *
 * Throws on malformed input — a bad value here would silently corrupt
 * persisted data.
 */
export function istWallClockToUtc(wallClock: string): Date {
  // The native control may include seconds or fractions on some browsers;
  // the regex accepts an optional `:ss(.fff)?` tail and rounds them in.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
    wallClock,
  );
  if (!match) {
    throw new Error(
      `istWallClockToUtc: expected YYYY-MM-DDTHH:mm, received ${JSON.stringify(wallClock)}`,
    );
  }
  const year   = Number(match[1]);
  const month  = Number(match[2]);
  const day    = Number(match[3]);
  const hour   = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  // `Date.UTC` builds a UTC instant from these wall-clock fields; subtract
  // the IST offset to get the UTC instant the IST clock reads as that time.
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  return new Date(utcMs - IST_OFFSET_MS);
}

const wallClockFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// `errors.ts` — UI-facing error code → human copy mapping.
//
// The server returns structured `{ code, ...context }` errors (LLD §4). The
// UI never displays the raw code — it looks up a friendly sentence here. If
// a code is unknown (e.g., a future server addition the SPA hasn't shipped
// for yet), we fall back to the code itself so something useful still shows.
//
// Keep this in sync with:
//   - src/domain/types.ts → AssignmentError (the orchestrator errors)
//   - src/api/errorMiddleware.ts → NotFoundError, ConflictError, ZodError 400s
//   - src/api/server.ts → 404 ROUTE_NOT_FOUND fallback

import type { ApiError } from './api';

/**
 * Map a structured error code + its context to a human sentence.
 *
 * Pages call this to render the message inside a Banner or Toast. Returns
 * `null` if the code is unknown — caller may fall back to `error.message`.
 */
export function describeApiError(error: ApiError): string {
  const { code, context } = error;
  // ---------------- Orchestrator (HTTP 422) ----------------
  switch (code) {
    case 'LP_NOT_ELIGIBLE':
      return `This LP isn't certified for ${formatTrainType(context['trainType'])}.`;
    case 'LP_REST_VIOLATION':
      return `This LP hasn't completed the 16-hour rest window (${formatHours(context['actualHours'])} of ${formatHours(context['requiredHours'])} so far).`;
    case 'LP_WINDOW_CONFLICT':
      return `This LP is already assigned to an overlapping window.`;
    case 'ALP_NOT_ELIGIBLE':
      return `This ALP isn't certified for ${formatTrainType(context['trainType'])}.`;
    case 'ALP_REST_VIOLATION':
      return `This ALP hasn't completed the 16-hour rest window (${formatHours(context['actualHours'])} of ${formatHours(context['requiredHours'])} so far).`;
    case 'ALP_WINDOW_CONFLICT':
      return `This ALP is already assigned to an overlapping window.`;
    case 'ALP_REQUIRED_BUT_MISSING':
      return `An ALP is required for ${formatTrainType(context['trainType'])} trains.`;
    case 'ALP_NOT_ALLOWED':
      return `${formatTrainType(context['trainType'])} trains do not take an ALP.`;
    case 'ARCHIVED_ENTITY':
      return `That ${formatEntity(context['entity'])} has been archived and can't be used.`;
    case 'TRAIN_DOES_NOT_RUN_ON_DAY':
      return `This train doesn't run on ${formatDayOfWeek(context['dayOfWeek'])} (${formatDate(context['runDate'])}). Pick a date the train operates.`;
    case 'ALREADY_ASSIGNED':
      return `This train already has crew assigned for ${formatDate(context['runDate'])}. Archive the existing assignment first.`;

    // ---------------- API/HTTP layer ----------------
    case 'NOT_FOUND':
      return `That ${formatEntity(context['entity'])} doesn't exist (id: ${String(context['id'] ?? '?')}).`;
    case 'CONFLICT':
      // CSV repos surface duplicate `number` here.
      return typeof context['message'] === 'string'
        ? (context['message'] as string)
        : `That value is already in use.`;
    case 'VALIDATION_FAILED':
      return formatValidationFailed(context);
    case 'ROUTE_NOT_FOUND':
      return `Endpoint not found.`;
    case 'INTERNAL_ERROR':
      return `Something went wrong on the server. Try again, or check the API logs.`;
    case 'NETWORK_ERROR':
      return `Couldn't reach the API. Is the server running?`;

    default:
      return `${code}${error.status ? ` (HTTP ${error.status})` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTrainType(value: unknown): string {
  if (typeof value !== 'string') return 'this train';
  switch (value) {
    case 'PASSENGER':    return 'Passenger';
    case 'MAIL_EXPRESS': return 'Mail/Express';
    case 'MEMU':         return 'MEMU';
    case 'DEMU':         return 'DEMU';
    case 'VANDE_BHARAT': return 'Vande Bharat';
    case 'AMRIT_BHARAT': return 'Amrit Bharat';
    default:             return value;
  }
}

function formatEntity(value: unknown): string {
  if (typeof value !== 'string') return 'record';
  switch (value) {
    case 'TRAIN':      return 'train';
    case 'LP':         return 'Loco Pilot';
    case 'ALP':        return 'Assistant Loco Pilot';
    case 'ASSIGNMENT': return 'assignment';
    default:           return value.toLowerCase();
  }
}

function formatDayOfWeek(value: unknown): string {
  if (typeof value !== 'string') return 'that day';
  switch (value) {
    case 'SUN': return 'Sunday';
    case 'MON': return 'Monday';
    case 'TUE': return 'Tuesday';
    case 'WED': return 'Wednesday';
    case 'THU': return 'Thursday';
    case 'FRI': return 'Friday';
    case 'SAT': return 'Saturday';
    default:    return value;
  }
}

/**
 * `runDate` arrives as `YYYY-MM-DD`. We surface it verbatim — the date the
 * operator selected is the date they expect to see echoed back.
 */
function formatDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : 'the selected date';
}

function formatHours(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?h';
  // Rule: round up so we never show 0h for a non-ready person — mirrors the
  // RestBar "Math.ceil" treatment from design.md §6.
  const rounded = value >= 1 ? Math.round(value * 10) / 10 : Math.ceil(value);
  return `${rounded}h`;
}

function formatValidationFailed(context: Record<string, unknown>): string {
  // Zod 400s arrive as `{ code: 'VALIDATION_FAILED', issues: ZodIssue[] }`.
  const issues = context['issues'];
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0] as { path?: unknown[]; message?: string };
    const path =
      Array.isArray(first.path) && first.path.length > 0
        ? first.path.join('.')
        : null;
    return path
      ? `Validation failed on \`${path}\`: ${first.message ?? 'invalid value'}.`
      : (first.message ?? 'Validation failed.');
  }
  return 'Validation failed.';
}

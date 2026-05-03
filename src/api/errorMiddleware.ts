// Express error-handling utilities.
//
// Two responsibilities:
//   1. Translate `AssignmentError` (the domain Result.error union) into a
//      stable HTTP wire shape: 422 Unprocessable Entity with body
//      `{ code, ...context }`. Same `code` strings the SPA already knows
//      about — see LLD §4 and `ApiErrorResponse` in src/shared/schemas.ts.
//   2. Provide a catch-all error handler so an uncaught exception (e.g. a
//      Zod validation throw, a CSV write failure) is mapped to the right
//      HTTP status without leaking internals.
//
// Routers should use `asyncHandler(...)` to wrap async handlers so thrown
// promises reach the error middleware instead of escaping the event loop.
//
// Layering: this is the only place in `src/api/*` that knows about
// `AssignmentError`. Routers `return errorFromRule(res, result.error)` rather
// than encoding the wire format inline.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { AssignmentError } from '../domain/types';
import type { ApiErrorResponse } from '../shared/schemas';

// ---------------------------------------------------------------------------
// Rule errors (AssignmentError) → HTTP 422
// ---------------------------------------------------------------------------

/**
 * Send the standard 422 response for a rule violation. The body is the
 * discriminated union flattened to JSON: `{ code, ...rest }`. Routers call
 * this on `Result.error` from `assignCrew`.
 */
export function sendRuleError(res: Response, error: AssignmentError): Response {
  const body: ApiErrorResponse = { ...error };
  return res.status(422).json(body);
}

// ---------------------------------------------------------------------------
// Public errors thrown from routers — translated to HTTP by the middleware
// ---------------------------------------------------------------------------

/**
 * Throw this when a request references an entity that does not exist (or has
 * been archived to the point of being indistinguishable from "missing").
 * The middleware turns it into HTTP 404 with `{ code: 'NOT_FOUND', entity, id }`.
 */
export class NotFoundError extends Error {
  constructor(
    readonly entity: 'TRAIN' | 'LP' | 'ALP' | 'ASSIGNMENT',
    readonly entityId: string,
  ) {
    super(`${entity} not found: ${entityId}`);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown for input the routers reject *before* delegating to the orchestrator
 * — e.g. a duplicate train number on create. HTTP 409 Conflict with
 * `{ code, ...context }`.
 */
export class ConflictError extends Error {
  constructor(
    readonly code: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(`Conflict: ${code}`);
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// Async wrapper — forwards rejected promises to next(err)
// ---------------------------------------------------------------------------

/**
 * Express 4 swallows rejected promises in async route handlers. This wrapper
 * funnels them into `next(err)` so the error middleware below sees them.
 * Express 5 makes this redundant, but we are pinned to v4 (techstack.md).
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Extract a required route param. Express guarantees the param exists when
 * the route matched (`/:id`), but `noUncheckedIndexedAccess` types the
 * indexer as `string | undefined`. This helper narrows safely and throws a
 * clean 500 if some future router config drops the param by accident.
 */
export function requireParam(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`requireParam: missing or empty route param "${name}"`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Centralised error middleware (must be the last `app.use(...)`)
// ---------------------------------------------------------------------------

/**
 * Order of precedence:
 *   1. ZodError              → 400  `{ code: 'VALIDATION_FAILED', issues }`
 *   2. NotFoundError         → 404  `{ code: 'NOT_FOUND', entity, id }`
 *   3. ConflictError         → 409  `{ code, ...context }`
 *   4. anything else         → 500  `{ code: 'INTERNAL_ERROR' }` + log to stderr
 *
 * AssignmentError responses are produced via `sendRuleError(...)` directly in
 * the route handler — they never reach this middleware.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const body: ApiErrorResponse = {
      code: 'VALIDATION_FAILED',
      issues: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof NotFoundError) {
    const body: ApiErrorResponse = {
      code: 'NOT_FOUND',
      entity: err.entity,
      id: err.entityId,
    };
    res.status(404).json(body);
    return;
  }

  if (err instanceof ConflictError) {
    const body: ApiErrorResponse = { code: err.code, ...err.context };
    res.status(409).json(body);
    return;
  }

  // Unknown / unexpected. Log to stderr so the operator can correlate with
  // CSV state, but do NOT echo the message to the client — it may include a
  // file path or other internal detail.
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error:', err);
  const body: ApiErrorResponse = { code: 'INTERNAL_ERROR' };
  res.status(500).json(body);
}

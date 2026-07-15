// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Generic Express plumbing: wraps async route handlers so thrown/rejected
// errors reach errorHandler, and maps known error types to safe HTTP responses.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ViewportParseError } from './viewport';

// Reserved for a future throwing-stub variant of the Graph Query Service
// (see spec.md's Interfaces section) — not thrown anywhere today, but mapped
// here so errorHandler doesn't need to change when it is introduced.
export class NotImplementedError extends Error {}

export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ViewportParseError) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof NotImplementedError) {
    res.status(501).json({ error: 'Not implemented' });
    return;
  }

  // Never leak err.stack or the raw internal message for unknown errors.
  res.status(500).json({ error: 'Internal server error' });
}

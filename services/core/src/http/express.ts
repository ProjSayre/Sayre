// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Generic Express plumbing: wraps async route handlers so thrown/rejected
// errors reach errorHandler, and maps known error types to safe HTTP responses.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ViewportParseError } from './viewport';
import { RealtimeDeltaParseError } from './realtimeDeltaRequest';
import { WebhookSignatureError } from '../webhooks/githubSignature';
import { WebhookBadRequestError } from '../services/githubWebhookService';
import {
  GithubApiError,
  InstallationOrgConflictError,
  InstallCallbackBadRequestError,
} from '../services/githubAppInstallService';
import { AuthenticationError } from './authenticate';
import { AuthorizationError } from './authorize';
import {
  ProviderSettingsForbiddenError,
  ProviderSettingsValidationError,
} from '../services/providerSettingsService';
import {
  ProviderJobStateAccessDeniedError,
  ProviderJobStateInputError,
} from '../services/providerJobStateService';

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

  if (err instanceof RealtimeDeltaParseError) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof NotImplementedError) {
    res.status(501).json({ error: 'Not implemented' });
    return;
  }

  // Signature/shape errors never leak the message (which could echo header content) —
  // fixed, generic bodies only.
  if (err instanceof WebhookSignatureError) {
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  if (err instanceof WebhookBadRequestError) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  if (err instanceof InstallCallbackBadRequestError) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  if (err instanceof InstallationOrgConflictError) {
    res.status(409).json({ error: 'installation already bound to a different organization' });
    return;
  }

  if (err instanceof GithubApiError) {
    res.status(502).json({ error: 'GitHub API request failed' });
    return;
  }

  // express.raw()'s body-size limit (see app.ts, /webhooks/github mounted with a 5mb
  // cap) rejects an oversized request via `raw-body`'s `entity.too.large` error before
  // any handler runs. Surface its real 413, not the generic 500 fallback below.
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'payload too large' });
    return;
  }

  // Generic bodies only — no message leakage about which check failed.
  if (err instanceof AuthenticationError) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (err instanceof AuthorizationError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof ProviderJobStateInputError) {
    res.status(400).json({ error: 'invalid provider state request' });
    return;
  }

  if (err instanceof ProviderJobStateAccessDeniedError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof ProviderSettingsForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof ProviderSettingsValidationError) {
    res.status(400).json({ error: 'invalid provider settings' });
    return;
  }

  // Never leak err.stack or the raw internal message for unknown errors.
  res.status(500).json({ error: 'Internal server error' });
}

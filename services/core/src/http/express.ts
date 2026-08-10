// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
// Generic Express plumbing: wraps async route handlers so thrown/rejected
// errors reach errorHandler, and maps known error types to safe HTTP responses.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ViewportParseError } from './viewport';
import { RealtimeDeltaParseError } from './realtimeDeltaRequest';
import { WebhookSignatureError } from '../webhooks/githubSignature';
import { WebhookBadRequestError } from '../services/githubWebhookService';
import { InstallationResolutionInputError } from '../db/installations';
import {
  GithubApiError,
  GithubInstallationAuthorizationError,
  InstallationOrgConflictError,
  InstallCallbackBadRequestError,
} from '../services/githubAppInstallService';
import { LoginCallbackBadRequestError } from '../services/loginService';
import {
  JiraCallbackBadRequestError,
  JiraOAuthUpstreamError,
} from '../services/jiraConnectService';
import {
  GithubOAuthApiError,
  GithubOAuthCodeError,
  NoVerifiedEmailError,
} from '../github/oauthClient';
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
import {
  AgentSkillMdForbiddenError,
  AgentSkillMdNotFoundError,
  AgentSkillMdValidationError,
  AgentSkillMdVersionConflictError,
} from '../services/agentSkillMdService';
import {
  McpKeyAuthenticationError,
  McpKeyForbiddenError,
  McpKeyNotFoundError,
  McpKeyValidationError,
} from '../services/mcpKeyService';
import {
  ChatEnqueueError,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatValidationError,
} from '../services/chatService';

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

  // GAP-6 (AC-3) defence-in-depth: resolveInstallationOrg's own input guard
  // (db/installations.ts) throws this for a non-positive-safe-integer installation
  // id. Map it here too so it can never reach the generic 500 fallback below from ANY
  // caller, not only the webhook route (which already filters malformed ids out
  // before this point). Fixed body only — never echo the thrown message.
  //
  // Wrapped in try/catch rather than a bare `instanceof`: several unrelated test
  // suites' `vi.mock('../db/installations', ...)` doubles only stub
  // `resolveInstallationOrg`/`getRuntimeDb` and don't re-export this class. Under
  // Vitest's mock module namespace, accessing an export the factory didn't return
  // THROWS (not merely `undefined`) — that access must never crash every other error
  // type this handler maps for those same suites.
  let isInstallationResolutionInputError = false;
  try {
    isInstallationResolutionInputError = err instanceof InstallationResolutionInputError;
  } catch {
    isInstallationResolutionInputError = false;
  }
  if (isInstallationResolutionInputError) {
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

  if (err instanceof GithubInstallationAuthorizationError) {
    res.status(403).json({ error: 'GitHub installation authorization failed' });
    return;
  }

  if (err instanceof GithubApiError) {
    res.status(502).json({ error: 'GitHub API request failed' });
    return;
  }

  // AUTH-01 "Sign in with GitHub" — generic bodies only, no message leakage.
  if (err instanceof LoginCallbackBadRequestError) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  if (err instanceof GithubOAuthCodeError) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  if (err instanceof NoVerifiedEmailError) {
    res.status(422).json({ error: 'no usable verified email on the GitHub account' });
    return;
  }

  if (err instanceof GithubOAuthApiError) {
    res.status(502).json({ error: 'GitHub authentication request failed' });
    return;
  }

  // W3-10 Jira OAuth 3LO connect flow — generic bodies only, no message
  // leakage. JiraSingleSiteRequiredError is deliberately NOT mapped here: the
  // callback route (routes/jiraConnect.ts) catches it itself and issues a 302
  // redirect with an actionable `?jira_error=multiple_sites` flag instead of a
  // JSON error body.
  if (err instanceof JiraCallbackBadRequestError) {
    res.status(400).json({ error: 'bad request' });
    return;
  }

  if (err instanceof JiraOAuthUpstreamError) {
    res.status(502).json({ error: 'Jira OAuth request failed' });
    return;
  }

  // express.raw()'s body-size limit (see app.ts, /webhooks/github mounted with
  // GITHUB_WEBHOOK_MAX_BODY_BYTES) rejects an oversized request via `raw-body`'s
  // `entity.too.large` error before any handler runs. Surface its real 413, not the
  // generic 500 fallback below.
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    // GAP-9 (AC-6): the 5 MB cap is a deliberate, kept decision (see app.ts /
    // routes/githubWebhook.ts), not an oversight — but a dropped delivery should
    // still be observable. Fixed string only, matching the pattern at
    // integrations/git/worker.ts:54 — never interpolate the error/request (header,
    // body, signature, secret) into the log line.
    console.warn('GitHub webhook delivery rejected: request body exceeded the configured size cap.');
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

  if (err instanceof AgentSkillMdValidationError) {
    res.status(400).json({ error: 'invalid Agent/Skill MD', issues: err.issues });
    return;
  }

  if (err instanceof AgentSkillMdForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof AgentSkillMdNotFoundError) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (err instanceof AgentSkillMdVersionConflictError) {
    res.status(409).json({
      error: 'version conflict',
      currentVersion: err.currentVersion,
    });
    return;
  }

  if (err instanceof McpKeyAuthenticationError) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (err instanceof McpKeyForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof McpKeyValidationError) {
    res.status(400).json({ error: 'invalid MCP key settings' });
    return;
  }

  if (err instanceof McpKeyNotFoundError) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (err instanceof ChatValidationError) {
    res.status(400).json({ error: 'invalid chat request', issues: err.issues });
    return;
  }

  if (err instanceof ChatForbiddenError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  if (err instanceof ChatNotFoundError) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  if (err instanceof ChatEnqueueError) {
    // Fixed body only — never the underlying SQS message, queue URL, region,
    // or AWS error code (spec.md AC-12/EC-13).
    res.status(502).json({ error: 'chat turn could not be queued' });
    return;
  }

  // Never leak err.stack or the raw internal message for unknown errors.
  res.status(500).json({ error: 'Internal server error' });
}

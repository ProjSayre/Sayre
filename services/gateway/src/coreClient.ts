// HTTP client to Core's internal `/internal/realtime/graph-delta` endpoint —
// the only path by which the gateway reaches RBAC filtering (W2-03 O-2). The
// gateway forwards the connected client's own bearer token and NEVER asserts
// org_id itself; Core re-runs authenticate() and re-derives org_id server-side
// on every call. This keeps node-level RBAC filtering in exactly one place
// (the Graph Query Service, via Core) per .claude/rules/security-multitenancy.md.
//
// INVARIANT: `token` is never logged, anywhere in this module.

import type { RealtimeDeltaRequest, RealtimeGraphDelta } from '@sayre/shared-types';

export class CoreUnauthorizedError extends Error {
  constructor(message = 'Core rejected the forwarded session token.') {
    super(message);
    this.name = 'CoreUnauthorizedError';
  }
}

export class CoreUnavailableError extends Error {
  constructor(message = 'Core internal realtime endpoint is unavailable.') {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}

export interface FetchAuthorizedDeltaArgs {
  baseUrl: string;
  token: string; // forwarded client bearer token; NEVER logged
  repoId: string;
  change: { changedPaths: string[]; fullRebuild: boolean; graphVersion: number };
}

/**
 * POSTs a RealtimeDeltaRequest to `${baseUrl}/internal/realtime/graph-delta`
 * with `Authorization: Bearer <token>` (only when `token` is non-empty — the
 * dev/test fallback identity carries no real token, and Core's own
 * authenticate() falls back to the same dev identity when no Authorization
 * header is present). Sends repoId/changedPaths/fullRebuild/graphVersion
 * only — NEVER an org_id (Core derives it from the token).
 */
export async function fetchAuthorizedDelta(args: FetchAuthorizedDeltaArgs): Promise<RealtimeGraphDelta> {
  const body: RealtimeDeltaRequest = {
    repoId: args.repoId,
    changedPaths: args.change.changedPaths,
    fullRebuild: args.change.fullRebuild,
    graphVersion: args.change.graphVersion,
  };

  let response: Response;
  try {
    response = await fetch(`${args.baseUrl}/internal/realtime/graph-delta`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Network error / connection refused — never include the underlying error
    // (which could echo request details) in a log line with the token nearby.
    throw new CoreUnavailableError('Core internal realtime endpoint is unreachable.');
  }

  if (response.status === 401) {
    throw new CoreUnauthorizedError();
  }
  if (!response.ok) {
    throw new CoreUnavailableError(`Core internal realtime endpoint returned status ${response.status}.`);
  }

  return (await response.json()) as RealtimeGraphDelta;
}

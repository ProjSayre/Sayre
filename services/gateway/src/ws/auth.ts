// Connection-time authentication for a WebSocket client. There is no Express
// upgrade middleware chain for a WS connection, so this reuses Core's single
// JWT-verification implementation directly (verifySessionToken, exported via
// @sayre/core's library entry point — see services/core/src/lib.ts and W2-03
// O-4) rather than re-implementing signature verification here.
//
// INVARIANT: never reads a token from the URL query string (would land in
// access logs / browser history) — only the `Authorization: Bearer` upgrade
// header or a first `{ type: 'auth' }` frame are accepted
// (.claude/rules/security-multitenancy.md; spec.md Approach step 6).

import type { IncomingMessage } from 'node:http';
import { getConfig } from '@sayre/config';
import { verifySessionToken, type SessionClaims } from '@sayre/core';
import type { OrgRole } from '@sayre/shared-types';

export interface ConnectionIdentity {
  orgId: string;
  roles: OrgRole[];
  userId: string;
  token: string;
}

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/** Reads the Authorization header only. */
export function extractUpgradeToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = BEARER_RE.exec(header.trim());
  return match?.[1];
}

export function isDevOrTestEnvironment(): boolean {
  const environment = getConfig('NODE_ENV');
  return environment === 'development' || environment === 'test';
}

/**
 * Verifies `token` via Core's verifySessionToken and maps its claims onto the
 * gateway's connection identity shape. Propagates SessionTokenError on ANY
 * failure — callers must close the socket with a single generic reason and
 * never leak which specific check failed (mirrors
 * services/core/src/http/authenticate.ts).
 */
export async function authenticateConnectionToken(token: string): Promise<ConnectionIdentity> {
  const claims: SessionClaims = await verifySessionToken(token);
  return {
    orgId: claims.org_id,
    roles: claims.roles,
    userId: claims.sub,
    token,
  };
}

/**
 * Dev/test-only synthetic identity, mirroring services/core's
 * devSessionContext(). Fails closed (throws) outside development/test — the
 * caller (ws/connection.ts) must only invoke this after confirming the
 * environment, exactly like authenticate.ts's isDevOrTestEnvironment() gate.
 * `token: ''` — there is no real bearer token to forward to Core on later
 * pushes; Core's own authenticate() falls back to the same dev identity when
 * no Authorization header is forwarded (see ../coreClient.ts).
 */
export function devConnectionIdentity(): ConnectionIdentity {
  if (!isDevOrTestEnvironment()) {
    throw new Error('Dev connection identity is unavailable outside development/test.');
  }
  return {
    orgId: getConfig('DEV_ORG_ID'),
    roles: ['owner'],
    userId: getConfig('DEV_USER_ID'),
    token: '',
  };
}

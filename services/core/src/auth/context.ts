// Request adaptation only — no domain logic (see .claude/rules/service-layer.md).
//
// AuthContext is the single documented auth contract for Sayre's REST API
// today, and for W4-06's MCP Gateway tomorrow — one permission model, two
// front doors. `authenticate()` (src/http/authenticate.ts) attaches one of
// these to `req.context` after server-side token verification;
// `authorize(minRole)` (src/http/authorize.ts) and downstream service checks
// consume it without caring which subject type produced it.
//
// A future `agent_key` subject (W4-06, MCP Gateway) attaches
// `{ subjectType: 'agent_key', agentKeyId, orgId, roles }` through this same
// shape — no change to `authorize()` or service-layer checks is needed when
// that lands. Nothing here constructs an `agent_key` context; it is reserved
// only so the contract is stable in advance.
//
// INVARIANT: `orgId` is resolved server-side from a verified credential and
// is NEVER read from req.query/req.body/headers a client controls
// (.claude/rules/security-multitenancy.md).
//
// OrgRole is defined in @sayre/shared-types (hoisted there in W2-03 O-4) so
// services/gateway can consume the same type without importing this Express-
// specific module. Re-exported here (not redefined) so this remains the one
// place callers within services/core look for the auth-context shape.

import type { Request } from 'express';
import type { OrgRole } from '@sayre/shared-types';

export type { OrgRole };

interface BaseAuthContext {
  /** UUID, server-resolved from the validated token — NEVER from client input. */
  orgId: string;
  /** Coarse org roles carried by the credential. */
  roles: OrgRole[];
}

export interface UserAuthContext extends BaseAuthContext {
  subjectType: 'user';
  /** users.id */
  userId: string;
}

// Reserved for W4-06's MCP Gateway. NOT constructed anywhere in W1-03 —
// defined here so the contract is stable and authorize()/service checks are
// subject-agnostic.
export interface AgentKeyAuthContext extends BaseAuthContext {
  subjectType: 'agent_key';
  /** mcp_client_keys.key_prefix / id */
  agentKeyId: string;
}

export type AuthContext = UserAuthContext | AgentKeyAuthContext;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      context?: AuthContext;
    }
  }
}

/** Returns `req.context`, throwing if `authenticate()` did not run (or rejected the request). */
export function requireAuthContext(req: Request): AuthContext {
  if (!req.context) {
    throw new Error('Missing auth context: req.context was not set (authenticate() must run first)');
  }
  return req.context;
}

/** Convenience accessor: `requireAuthContext(req).orgId`. The sole source of a request-scoped org id. */
export function requireOrgId(req: Request): string {
  return requireAuthContext(req).orgId;
}

// Business logic lives here (service-layer rule — .claude/rules/service-layer.md).
// Plain functions, no Express/req/res types — JWT verification and context
// resolution stay in the service layer; src/http/authenticate.ts is a thin
// adapter that only reads the Authorization header and calls into here.

import { getConfig } from '@sayre/config';
import type { OrgRole, UserAuthContext } from '../auth/context';
import type { SessionClaims } from '../auth/sessionToken';
import { verifySessionToken } from '../auth/sessionToken';

export interface AuthServiceDeps {
  verifyToken: (token: string) => Promise<SessionClaims>;
}

const defaultDeps: AuthServiceDeps = {
  verifyToken: verifySessionToken,
};

/** Verifies `token` and maps its claims to a `UserAuthContext`. Propagates `SessionTokenError`. */
export async function resolveSessionContext(
  token: string,
  deps?: Partial<AuthServiceDeps>,
): Promise<UserAuthContext> {
  const { verifyToken } = { ...defaultDeps, ...deps };
  const claims = await verifyToken(token);
  return {
    subjectType: 'user',
    userId: claims.sub,
    orgId: claims.org_id,
    roles: claims.roles as OrgRole[],
  };
}

/**
 * Dev/test-only synthetic context, mirroring the retired `tenantContext`'s
 * posture: used only when no credential is presented and NODE_ENV is
 * 'development' or 'test'. Fails closed (throws) in any other environment —
 * callers (http/authenticate.ts) must never call this in production.
 */
export function devSessionContext(): UserAuthContext {
  const environment = getConfig('NODE_ENV');
  if (environment !== 'development' && environment !== 'test') {
    throw new Error('Dev session context is unavailable until production authentication is configured.');
  }
  return {
    subjectType: 'user',
    userId: getConfig('DEV_USER_ID'),
    orgId: getConfig('DEV_ORG_ID'),
    roles: ['owner'],
  };
}

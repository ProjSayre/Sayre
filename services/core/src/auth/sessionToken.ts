// Stateless session bearer token — verify/sign helpers only. W1-03 does not
// own token *issuance* (login / human OAuth / a sessions table is a future
// ticket's scope); `signSessionToken` exists for tests and future issuers.
// MVP trusts the signed token's claims for `{ userId, orgId, roles }` with no
// per-request DB confirmation (stateless) — role changes take effect on next
// token re-issue only.
//
// HS256, signed with env://JWT_SIGNING_KEY (W0-07 loader) — same key loader
// and uniform-error discipline as github/installState.ts, but `purpose:
// 'session'` keeps the two token families non-cross-usable: an install-state
// token replayed here (or vice versa) fails verification.

import jwt from 'jsonwebtoken';
import { getSecret } from '@sayre/config';
import type { OrgRole } from './context';

const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];

// Same UUID convention as db/client.ts's withOrgContext check — a non-UUID
// org_id is rejected here, at auth time, so it can never reach withOrgContext.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionClaims {
  /** userId */
  sub: string;
  /** UUID */
  org_id: string;
  roles: OrgRole[];
  /** distinct from installState's 'github_app_install' — tokens are NOT cross-usable */
  purpose: 'session';
}

const PURPOSE = 'session' as const;
const DEFAULT_EXPIRY = '12h';

export class SessionTokenError extends Error {
  constructor(message = 'Invalid or expired session token.') {
    super(message);
    this.name = 'SessionTokenError';
  }
}

function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/** Signs a fresh session JWT for tests / future issuers. Never accepts a client-supplied org. */
export async function signSessionToken(
  input: { userId: string; orgId: string; roles: OrgRole[] },
  opts?: { expiresIn?: string | number },
): Promise<string> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  const payload: SessionClaims = {
    sub: input.userId,
    org_id: input.orgId,
    roles: input.roles,
    purpose: PURPOSE,
  };
  const expiresIn = (opts?.expiresIn ?? DEFAULT_EXPIRY) as jwt.SignOptions['expiresIn'];
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn });
}

/**
 * Verifies signature + expiry + `purpose` claim, and structurally validates
 * every claim: `sub` non-empty; `org_id` is a UUID; `roles` is a non-empty
 * array whose every element is a valid `OrgRole`. Throws `SessionTokenError`
 * for ANY failure — the caller maps this uniformly to a 401, never leaking
 * which specific check failed.
 */
export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const key = await getSecret('env://JWT_SIGNING_KEY');
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
  } catch {
    throw new SessionTokenError();
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new SessionTokenError();
  }
  const candidate = decoded as Record<string, unknown>;

  if (typeof candidate.sub !== 'string' || candidate.sub.length === 0) {
    throw new SessionTokenError();
  }
  if (typeof candidate.org_id !== 'string' || !UUID_RE.test(candidate.org_id)) {
    throw new SessionTokenError();
  }
  if (candidate.purpose !== PURPOSE) {
    throw new SessionTokenError();
  }
  if (!Array.isArray(candidate.roles) || candidate.roles.length === 0) {
    throw new SessionTokenError();
  }
  if (!candidate.roles.every(isOrgRole)) {
    throw new SessionTokenError();
  }

  return {
    sub: candidate.sub,
    org_id: candidate.org_id,
    roles: candidate.roles as OrgRole[],
    purpose: PURPOSE,
  };
}

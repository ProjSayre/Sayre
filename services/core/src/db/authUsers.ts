// Privileged installation->org resolver's login-flow analog: resolves a
// GitHub external auth id to an existing {user, org} BEFORE any `app.org_id`
// session context exists — org_id is the very thing being resolved here, so
// this intentionally runs outside `withOrgContext` (see db/client.ts), on the
// same login-role pool as db/installations.ts::resolveInstallationOrg
// (reused via getRuntimeDb, not a second pool).
//
// PRODUCTION GAP (documented, not fixed): `users` carries org_id RLS. In local
// dev/test the login role (`sayre_dev`) is a superuser and bypasses RLS, so
// this plain global query works today. In production the login role is
// NOBYPASSRLS, so this pre-tenant read needs a sanctioned privileged read path
// — without it, every login would look like a new user and mint a duplicate
// org. NOTE: this is NOT the same gap as resolveInstallationOrg anymore —
// migration 0011 (`resolve_github_installation_org`) already closed that one
// via a NOLOGIN/NOBYPASSRLS `SECURITY DEFINER` function scoped to four
// columns. This resolver should get an equivalent function (e.g.
// `resolve_user_by_external_auth_id`) rather than reusing the old superuser-
// bypass posture — tracked in docs/post-mvp-backlog.md, deliberately deferred
// to ship login for MVP rather than block it on re-deriving that migration.

import { eq } from 'drizzle-orm';
import type { OrgRole } from '../auth/context';
import { getRuntimeDb } from './installations';
import type { Db } from './client';
import { users } from './schema';

export interface ResolvedAuthUser {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
}

const VALID_ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];

function coerceOrgRole(value: string): OrgRole {
  return (VALID_ORG_ROLES as readonly string[]).includes(value) ? (value as OrgRole) : 'member';
}

/**
 * Privileged, PRE-tenant-context lookup: GitHub external auth id -> existing
 * user+org. Runs on the login-role pool WITHOUT withOrgContext because org_id
 * is the very thing being resolved (identical trust boundary + PRODUCTION GAP
 * as resolveInstallationOrg). Returns null when no user has this
 * external_auth_id. `orgRole` is coerced to a valid OrgRole
 * ('owner'|'admin'|'member'), defaulting to 'member' on an unexpected value
 * (least privilege).
 */
export async function resolveUserByExternalAuthId(
  db: Db,
  externalAuthId: string,
): Promise<ResolvedAuthUser | null> {
  const rows = await db
    .select({
      userId: users.id,
      orgId: users.orgId,
      orgRole: users.orgRole,
    })
    .from(users)
    .where(eq(users.externalAuthId, externalAuthId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.userId,
    orgId: row.orgId,
    orgRole: coerceOrgRole(row.orgRole),
  };
}

// Re-exported so loginService.ts's default deps can reuse the SAME memoized
// runtime db as the install flow, per spec.md ("do not create a second pool").
export { getRuntimeDb };

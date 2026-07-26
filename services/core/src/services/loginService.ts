// Orchestration for the real "Sign in with GitHub" login/signup flow
// (AUTH-01): start (redirect to GitHub) and callback (verify state -> exchange
// code -> fetch identity -> resolve-or-create org+user -> issue session ->
// redirect to the web completion page). Business logic lives here per
// .claude/rules/service-layer.md; the route (routes/login.ts) is a thin HTTP
// adapter that only calls these functions.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): org_id
// is NEVER read from the callback request. It is either resolved server-side
// via `resolveUserByExternalAuthId` (existing user) or freshly generated
// server-side via `randomUUID()` (brand-new signup) — never from a query
// param, body field, or header.
//
// The session is minted ONLY via the existing, unmodified `signSessionToken`
// (src/auth/sessionToken.ts) — no second signing implementation.

import { randomUUID } from 'node:crypto';
import { getConfig } from '@sayre/config';
import type { OrgRole } from '../auth/context';
import {
  LoginStateError,
  signLoginState,
  verifyLoginState,
  type LoginState,
} from '../auth/loginState';
import { signSessionToken } from '../auth/sessionToken';
import {
  createDefaultGithubOAuthClient,
  type GithubOAuthClient,
  type GithubOAuthUser,
} from '../github/oauthClient';
import { getRuntimeDb, resolveUserByExternalAuthId, type ResolvedAuthUser } from '../db/authUsers';
import { withOrgContext, type Db } from '../db/client';
import { insertOrganization, insertOwnerUser } from '../db/loginWrites';

export interface StartLoginResult {
  redirectTo: string; // GitHub authorize URL
}

export interface LoginStartDeps {
  signState: (input?: { redirectTo?: string }) => Promise<string>;
}

const defaultStartDeps: LoginStartDeps = {
  signState: signLoginState,
};

/**
 * Signs login state (optionally binding a validated redirect_to) and builds
 * the GitHub authorize URL. Sends an explicit `redirect_uri` pinned to
 * `GITHUB_LOGIN_CALLBACK_URL` — a GitHub App with more than one registered
 * callback URL (e.g. the install flow's alongside this login flow's) does not
 * infer which one a given authorize request should use, and silently falls
 * back to the first URL in the app's list. Without this param, login redirects
 * would land on the install flow's callback instead of this one.
 */
export async function startGithubLogin(
  input?: { redirectTo?: string },
  deps: Partial<LoginStartDeps> = {},
): Promise<StartLoginResult> {
  const resolvedDeps: LoginStartDeps = { ...defaultStartDeps, ...deps };
  const state = await resolvedDeps.signState(input);
  const webBaseUrl = getConfig('GITHUB_WEB_BASE_URL');
  const clientId = getConfig('GITHUB_APP_CLIENT_ID');
  const redirectUri = getConfig('GITHUB_LOGIN_CALLBACK_URL');
  return {
    redirectTo:
      `${webBaseUrl}/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&state=${encodeURIComponent(state)}&scope=${encodeURIComponent('user:email')}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}`,
  };
}

export interface LoginCallbackInput {
  code?: string;
  state?: string;
}

export interface LoginCallbackResult {
  redirectTo: string; // the /auth/complete URL, token in the fragment
}

/** Missing/invalid/expired/wrong-purpose state, or missing code. */
export class LoginCallbackBadRequestError extends Error {
  constructor(message = 'Malformed GitHub login callback request.') {
    super(message);
    this.name = 'LoginCallbackBadRequestError';
  }
}

export interface LoginCallbackDeps {
  verifyState: (token: string) => Promise<LoginState>;
  oauthClient: GithubOAuthClient;
  resolveUser: (externalAuthId: string) => Promise<ResolvedAuthUser | null>;
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  insertOrganization: typeof insertOrganization;
  insertOwnerUser: typeof insertOwnerUser;
  signSession: (input: { userId: string; orgId: string; roles: OrgRole[] }) => Promise<string>;
  newOrgId: () => string;
}

const defaultCallbackDeps: LoginCallbackDeps = {
  verifyState: verifyLoginState,
  oauthClient: createDefaultGithubOAuthClient(),
  resolveUser: async (externalAuthId) =>
    resolveUserByExternalAuthId(await getRuntimeDb(), externalAuthId),
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
  insertOrganization,
  insertOwnerUser,
  signSession: (input) => signSessionToken(input),
  newOrgId: randomUUID,
};

// Bounds the create-vs-resolve retry loop below (slug collisions, or a
// concurrent same-user first-sign-in race) so pathological contention fails
// loudly instead of looping forever or leaving a partial/orphan org.
const MAX_CREATE_ATTEMPTS = 5;

/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = '23505';

/** The constraint name for the AUTH-01 global partial-unique index (drizzle/0010_*). */
const EXTERNAL_AUTH_ID_CONSTRAINT = 'users_external_auth_id_unique';
/** The constraint name for `organizations.slug` (drizzle/0000_*). */
const ORGANIZATIONS_SLUG_CONSTRAINT = 'organizations_slug_unique';

interface PgLikeError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as PgLikeError;
  return candidate.code === UNIQUE_VIOLATION_CODE && candidate.constraint === constraintName;
}

async function verifyState(
  deps: LoginCallbackDeps,
  rawState: string | undefined,
): Promise<LoginState> {
  if (!rawState || rawState.trim().length === 0) {
    throw new LoginCallbackBadRequestError('Missing state.');
  }
  try {
    return await deps.verifyState(rawState);
  } catch (error) {
    if (error instanceof LoginStateError) {
      throw new LoginCallbackBadRequestError('Invalid or expired state.');
    }
    throw error;
  }
}

/** Normalizes a GitHub login into a URL-safe slug base; falls back to 'org' if empty. */
function deriveOrgSlug(login: string, attempt: number): string {
  const base =
    login
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'org';
  return attempt === 0 ? base : `${base}-${attempt + 1}`;
}

/** `user.name`, trimmed, falling back to `login` when null/blank. */
function deriveOrgName(user: GithubOAuthUser): string {
  const trimmedName = user.name?.trim();
  return trimmedName && trimmedName.length > 0 ? trimmedName : user.login;
}

async function resolveOrCreateUser(
  deps: LoginCallbackDeps,
  user: GithubOAuthUser,
  email: string,
): Promise<{ userId: string; orgId: string; roles: OrgRole[] }> {
  // Resolution keys ONLY on external_auth_id (the GitHub numeric id) — NEVER
  // on email. Two different orgs' users can share an email with no merge.
  const existing = await deps.resolveUser(user.id);
  if (existing) {
    return { userId: existing.userId, orgId: existing.orgId, roles: [existing.orgRole] };
  }

  const db = await deps.getDb();
  const name = deriveOrgName(user);

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const newOrgId = deps.newOrgId();
    const slug = deriveOrgSlug(user.login, attempt);

    try {
      // The whole org+user insert runs inside ONE withOrgContext transaction
      // so a failed user-insert never orphans an org (rollback on any error).
      const userId = await deps.withOrg(db, newOrgId, async (tx) => {
        await deps.insertOrganization(tx, { id: newOrgId, name, slug });
        const { userId: insertedUserId } = await deps.insertOwnerUser(tx, {
          orgId: newOrgId,
          email,
          name: user.name,
          externalAuthId: user.id,
        });
        return insertedUserId;
      });
      return { userId, orgId: newOrgId, roles: ['owner'] };
    } catch (error) {
      if (isUniqueViolation(error, EXTERNAL_AUTH_ID_CONSTRAINT)) {
        // A concurrent first-sign-in for the SAME GitHub user won the race —
        // re-resolve and use the winner's row rather than creating a second org.
        const winner = await deps.resolveUser(user.id);
        if (winner) {
          return { userId: winner.userId, orgId: winner.orgId, roles: [winner.orgRole] };
        }
        // Extremely unlikely (row deleted between the conflict and the
        // re-resolve) — fall through to rethrow below rather than loop forever.
        throw error;
      }
      if (isUniqueViolation(error, ORGANIZATIONS_SLUG_CONSTRAINT)) {
        // Two different logins normalized to the same base slug — retry with
        // the next de-duplicated slug; does not consume a re-resolve.
        continue;
      }
      throw error;
    }
  }

  throw new Error('Exhausted org-creation attempts due to persistent slug/id contention.');
}

/**
 * Verify state -> exchange code -> fetch identity (+email fallback) ->
 * resolve-or-create org+user -> signSessionToken -> build completion
 * redirect. `org_id` is NEVER read from the callback query/body/headers.
 */
export async function handleGithubLoginCallback(
  input: LoginCallbackInput,
  deps: Partial<LoginCallbackDeps> = {},
): Promise<LoginCallbackResult> {
  const resolvedDeps: LoginCallbackDeps = { ...defaultCallbackDeps, ...deps };
  const completeRedirectUrl = getConfig('GITHUB_LOGIN_COMPLETE_REDIRECT_URL');

  const state = await verifyState(resolvedDeps, input.state);

  if (!input.code || input.code.trim().length === 0) {
    throw new LoginCallbackBadRequestError('Missing code.');
  }

  const accessToken = await resolvedDeps.oauthClient.exchangeCodeForToken(input.code);
  const user = await resolvedDeps.oauthClient.getAuthenticatedUser(accessToken);
  const email = user.email ?? (await resolvedDeps.oauthClient.getPrimaryVerifiedEmail(accessToken));

  const { userId, orgId, roles } = await resolveOrCreateUser(resolvedDeps, user, email);
  const sessionToken = await resolvedDeps.signSession({ userId, orgId, roles });

  // Token rides the URL FRAGMENT, never the query string (see spec.md's OQ-3):
  // fragments are never sent to the server, never appear in access logs, and
  // never leak via Referer.
  let redirectTo = `${completeRedirectUrl}#token=${sessionToken}`;
  if (state.redirect_to) {
    redirectTo += `&redirect_to=${encodeURIComponent(state.redirect_to)}`;
  }

  return { redirectTo };
}

// Org-scoped credential loader (W3-10) — the SINGLE credential-read call site
// for Jira. This is the org-scoped analog of W0-07's `getSecret(name)`, giving
// W3-05's `jira-sync` worker (and PM-07's later KMS cutover) exactly one call
// site to change. Deliberately narrow/Jira-backed and lives in `services/core`,
// not `packages/config` (OQ-1, human-confirmed default): `packages/config`
// is deliberately DB-free, and a Postgres-backed loader there would invert
// that dependency layering.
//
// SECURITY-SENSITIVE (.claude/rules/security-multitenancy.md): this module,
// `db/jiraConnectionStore.ts`, and `db/schema.ts`'s definition site are the
// ONLY places allowed to reference the raw `jiraAccessTokenEnc` /
// `jiraRefreshTokenEnc` columns — enforced by `scripts/check-org-secret-access.mjs`.
// This file never touches those column identifiers directly; it only calls
// through the store's already-decrypted return values.
//
// Silent-refresh mechanics (spec.md "Silent refresh mechanics (concrete)"):
// lazily, immediately before returning a token, refresh if the access token
// expires within `SKEW_MS`. Concurrency-safety comes from
// `JiraConnectionStore.withLockedActiveConnection` holding one Postgres row
// lock across the Jira token-refresh HTTP call itself (not just the persist
// step) — this is what prevents two concurrent same-org jobs from both
// spending the same single-use, rotating Jira refresh token. A
// `JiraRefreshInvalidGrantError` (refresh token itself expired/revoked at
// Atlassian) soft-revokes the connection so the UI shows disconnected and
// future jobs no-op; any other refresh failure is treated as transient and
// does NOT revoke.

import { getConfig } from '@sayre/config';
import {
  jiraConnectionStore,
  type JiraConnectionStore,
} from '../../../db/jiraConnectionStore';
import {
  createDefaultJiraOAuthClient,
  JiraRefreshInvalidGrantError,
  type JiraOAuthClient,
} from './jiraOAuthClient';

export type OrgSecretName = 'JIRA_ACCESS_TOKEN';

export interface JiraConnectionContext {
  cloudId: string;
  apiBaseUrl: string; // `${JIRA_OAUTH_API_BASE_URL}/ex/jira/${cloudId}`
  siteUrl: string; // for /browse links + display
}

export class OrgSecretUnavailableError extends Error {
  constructor(
    message = 'No usable Jira credential is available for this organization.',
  ) {
    super(message);
    this.name = 'OrgSecretUnavailableError';
  }
}

// Refresh if the access token expires within 60s of "now" (spec.md's SKEW).
const SKEW_MS = 60_000;

// Swappable module-level singletons — mirrors the test-seam convention already
// established by packages/config (`setSecretBackendForTests`,
// `setConfigOverrideForTests`): `getOrgSecret`/`resolveJiraConnectionContext`
// keep their literal, dependency-free spec.md signatures for production
// callers, while tests reach the refresh/lock logic without a real DB or a
// real Atlassian endpoint. Zero effect on production behavior.
let activeStore: JiraConnectionStore = jiraConnectionStore;
let activeOAuthClient: JiraOAuthClient = createDefaultJiraOAuthClient();

function requireTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'orgSecrets test helpers are unavailable outside the test environment.',
    );
  }
}

export function setJiraOrgSecretsDependenciesForTests(deps: {
  store?: JiraConnectionStore;
  oauthClient?: JiraOAuthClient;
}): void {
  requireTestEnvironment();
  if (deps.store) activeStore = deps.store;
  if (deps.oauthClient) activeOAuthClient = deps.oauthClient;
}

export function resetJiraOrgSecretsDependenciesForTests(): void {
  requireTestEnvironment();
  activeStore = jiraConnectionStore;
  activeOAuthClient = createDefaultJiraOAuthClient();
}

function apiBaseUrlFor(cloudId: string): string {
  return `${getConfig('JIRA_OAUTH_API_BASE_URL')}/ex/jira/${cloudId}`;
}

function isFresh(expiresAt: Date): boolean {
  return expiresAt.getTime() > Date.now() + SKEW_MS;
}

/** Connection metadata (no token, no refresh). Returns null when no active connection. */
export async function resolveJiraConnectionContext(
  orgId: string,
): Promise<JiraConnectionContext | null> {
  const row = await activeStore.resolveActive(orgId);
  if (row === null) return null;
  return {
    cloudId: row.cloudId,
    apiBaseUrl: apiBaseUrlFor(row.cloudId),
    siteUrl: row.siteUrl,
  };
}

/**
 * Returns a *usable* (fresh) access token for the org's active Jira
 * connection. Ensures freshness (silent refresh) before returning. NOT
 * cached (per-org tokens rotate). Throws `OrgSecretUnavailableError` when
 * there is no active connection or refresh failed.
 */
export async function getOrgSecret(
  orgId: string,
  name: OrgSecretName,
): Promise<string> {
  if (name !== 'JIRA_ACCESS_TOKEN') {
    throw new OrgSecretUnavailableError();
  }

  const row = await activeStore.resolveActive(orgId);
  if (row === null) throw new OrgSecretUnavailableError();
  if (isFresh(row.accessTokenExpiresAt)) return row.accessToken;

  try {
    const result = await activeStore.withLockedActiveConnection(
      orgId,
      async (locked) => {
        // Re-check under the lock: another concurrent job may have already
        // refreshed while this call waited for the lock. If so, reuse its
        // result instead of spending the (single-use, rotating) refresh
        // token a second time.
        if (isFresh(locked.row.accessTokenExpiresAt)) {
          return locked.row.accessToken;
        }
        try {
          const tokenSet = await activeOAuthClient.refresh(locked.row.refreshToken);
          const accessTokenExpiresAt = new Date(
            Date.now() + tokenSet.expiresInSeconds * 1000,
          );
          await locked.persistRefresh({
            accessToken: tokenSet.accessToken,
            refreshToken: tokenSet.refreshToken,
            accessTokenExpiresAt,
            scopes: tokenSet.scope,
          });
          return tokenSet.accessToken;
        } catch (error) {
          if (error instanceof JiraRefreshInvalidGrantError) {
            await locked.revoke();
          }
          throw error;
        }
      },
    );
    if (result === null) throw new OrgSecretUnavailableError();
    return result;
  } catch (error) {
    if (error instanceof OrgSecretUnavailableError) throw error;
    // Both an invalid_grant (already revoked above) and any transient
    // upstream failure surface uniformly here — never leak which case
    // occurred, and never let a raw OAuth/network error escape this loader.
    throw new OrgSecretUnavailableError();
  }
}

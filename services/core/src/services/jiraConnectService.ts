// Orchestration for the Jira Cloud OAuth 3LO connect flow (W3-10): start
// (redirect to Atlassian), callback (verify state -> exchange code -> resolve
// exactly one accessible site -> persist the connection), status, and
// disconnect. Business logic lives here per .claude/rules/service-layer.md;
// the route (routes/jiraConnect.ts) is a thin HTTP adapter that only calls
// these functions.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): the
// connecting `org_id`/`user_id` are resolved ONLY from the signed connect-
// state token (set at connect-start from the server-resolved auth context,
// itself resolved by authenticate()) — NEVER from a callback query param. All
// store writes run inside `withOrgContext` (enforced inside
// `db/jiraConnectionStore.ts`).
//
// Credential invariant: this module never reads/writes the raw
// `jiraAccessTokenEnc`/`jiraRefreshTokenEnc` columns directly — it only calls
// through `JiraConnectionStore`'s already-decrypted/encrypted boundary.

import { getConfig } from '@sayre/config';
import {
  JiraConnectStateError,
  signJiraConnectState,
  verifyJiraConnectState,
  type JiraConnectState,
} from '../integrations/tickets/jira/jiraConnectState';
import {
  createDefaultJiraOAuthClient,
  type JiraOAuthClient,
} from '../integrations/tickets/jira/jiraOAuthClient';
import {
  jiraConnectionStore,
  type JiraConnectionStatusView,
  type JiraConnectionStore,
} from '../db/jiraConnectionStore';
import { mcpKeyStore } from '../db/mcpKeyStore';

export interface StartJiraConnectResult {
  redirectTo: string;
}

export interface JiraCallbackInput {
  code?: string;
  state?: string;
  error?: string;
}

export interface JiraCallbackResult {
  redirectTo: string;
}

export interface JiraStatusResponse {
  authorization: 'server-filtered';
  connection: JiraConnectionStatusView | null;
  updatedAt: string; // ISO
}

/** Missing/tampered/expired state, missing code, or a malformed callback input. */
export class JiraCallbackBadRequestError extends Error {
  constructor(message = 'Malformed Jira OAuth callback request.') {
    super(message);
    this.name = 'JiraCallbackBadRequestError';
  }
}

/**
 * Atlassian granted access to zero or (MVP-disallowed) more than one Jira
 * site. The ROUTE catches this specifically to redirect back to Settings with
 * an actionable `?jira_error=...` flag rather than a JSON error body — see
 * routes/jiraConnect.ts.
 */
export class JiraSingleSiteRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraSingleSiteRequiredError';
  }
}

/** Any Atlassian OAuth API failure during the callback (code exchange, accessible-resources, /me). */
export class JiraOAuthUpstreamError extends Error {
  constructor(message = 'Jira OAuth request failed.') {
    super(message);
    this.name = 'JiraOAuthUpstreamError';
  }
}

export interface JiraConnectServiceDeps {
  signState: (input: {
    orgId: string;
    userId: string;
    userLabel: string;
  }) => Promise<string>;
  verifyState: (token: string) => Promise<JiraConnectState>;
  oauthClient: JiraOAuthClient;
  store: JiraConnectionStore;
  resolveUserLabel: (orgId: string, userId: string) => Promise<string | null>;
}

const defaultDeps: JiraConnectServiceDeps = {
  signState: signJiraConnectState,
  verifyState: verifyJiraConnectState,
  oauthClient: createDefaultJiraOAuthClient(),
  store: jiraConnectionStore,
  resolveUserLabel: (orgId, userId) => mcpKeyStore.getActorLabel(orgId, userId),
};

/**
 * Resolves the connecting user's display label from the SERVER-side auth
 * context (`orgId`/`userId`) — never a client-supplied value. `UserAuthContext`
 * (auth/context.ts) carries no label/email field, so the route calls this
 * BEFORE `startJiraConnect` (whose `userLabel` input is an immutable
 * attribution snapshot, per spec.md's `JiraConnectState.user_label` doc
 * comment) rather than the service resolving it internally — keeping
 * `startJiraConnect`'s signature exactly as spec'd while still never letting
 * the route touch Postgres directly (.claude/rules/service-layer.md).
 */
export async function resolveConnectingUserLabel(
  input: { orgId: string; userId: string },
  deps: Partial<Pick<JiraConnectServiceDeps, 'resolveUserLabel'>> = {},
): Promise<string> {
  const resolveUserLabel = deps.resolveUserLabel ?? defaultDeps.resolveUserLabel;
  const label = await resolveUserLabel(input.orgId, input.userId);
  return label ?? 'Sayre administrator';
}

/**
 * Begins the connect flow: signs a state token binding this flow to the
 * SERVER-resolved `orgId`/`userId`/`userLabel` (caller passes
 * `requireOrgId(req)` plus the authenticated context's user, never a client
 * value), then returns Atlassian's authorize URL to redirect the browser to.
 */
export async function startJiraConnect(
  input: { orgId: string; userId: string; userLabel: string },
  deps: Partial<JiraConnectServiceDeps> = {},
): Promise<StartJiraConnectResult> {
  const resolved: JiraConnectServiceDeps = { ...defaultDeps, ...deps };
  const state = await resolved.signState(input);
  return { redirectTo: resolved.oauthClient.buildAuthorizeUrl({ state }) };
}

async function verifyCallbackState(
  deps: JiraConnectServiceDeps,
  rawState: string | undefined,
): Promise<JiraConnectState> {
  if (!rawState || rawState.trim().length === 0) {
    throw new JiraCallbackBadRequestError('Missing state.');
  }
  try {
    return await deps.verifyState(rawState);
  } catch (error) {
    if (error instanceof JiraConnectStateError) {
      throw new JiraCallbackBadRequestError('Invalid or expired state.');
    }
    throw error;
  }
}

/**
 * Verifies `state` (org_id/user_id/user_label come ONLY from it) -> exchanges
 * the one-time OAuth code -> requires exactly one Atlassian-accessible Jira
 * site (OQ-3: MVP rejects zero or more than one) -> resolves the connecting
 * user's Jira account -> persists the connection. Redirects back to Settings
 * in every case; nothing is stored unless every step above succeeds.
 */
export async function handleJiraCallback(
  input: JiraCallbackInput,
  deps: Partial<JiraConnectServiceDeps> = {},
): Promise<JiraCallbackResult> {
  const resolved: JiraConnectServiceDeps = { ...defaultDeps, ...deps };
  const postConnectRedirect = getConfig('JIRA_POST_CONNECT_REDIRECT_URL');

  // The user declined consent (or Atlassian reported another error) before
  // ever reaching the code-exchange step -- nothing to verify, nothing stored.
  if (input.error !== undefined && input.error.trim().length > 0) {
    return { redirectTo: `${postConnectRedirect}?jira_error=cancelled` };
  }

  const state = await verifyCallbackState(resolved, input.state);

  if (!input.code || input.code.trim().length === 0) {
    throw new JiraCallbackBadRequestError('Missing OAuth callback code.');
  }

  let tokenSet;
  try {
    tokenSet = await resolved.oauthClient.exchangeCode(input.code);
  } catch (error) {
    throw new JiraOAuthUpstreamError(
      `Jira code exchange failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  let resources;
  try {
    resources = await resolved.oauthClient.listAccessibleResources(
      tokenSet.accessToken,
    );
  } catch (error) {
    throw new JiraOAuthUpstreamError(
      `Jira accessible-resources request failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  if (resources.length === 0) {
    return { redirectTo: `${postConnectRedirect}?jira_error=no_site` };
  }
  if (resources.length > 1) {
    throw new JiraSingleSiteRequiredError(
      'Your Atlassian authorization granted access to multiple Jira sites; ' +
        'Sayre connects one site per organization — re-run Connect and grant ' +
        "access to only the target site on Atlassian's consent screen.",
    );
  }
  const [resource] = resources;

  // getCurrentUser failing is treated as an upstream failure, NOT a completed
  // connection with unknown attribution (spec.md edge case: "No" — we need
  // the connecting-user record). Nothing is stored.
  let currentUser;
  try {
    currentUser = await resolved.oauthClient.getCurrentUser(tokenSet.accessToken);
  } catch (error) {
    throw new JiraOAuthUpstreamError(
      `Jira current-user request failed: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }

  await resolved.store.connect(state.org_id, {
    cloudId: resource.id,
    siteUrl: resource.url,
    siteName: resource.name.trim().length > 0 ? resource.name : null,
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    accessTokenExpiresAt: new Date(Date.now() + tokenSet.expiresInSeconds * 1000),
    scopes: tokenSet.scope,
    connectedByUserId: state.user_id,
    connectedByLabel: state.user_label,
    connectedByAccountId: currentUser.accountId,
  });

  return { redirectTo: postConnectRedirect };
}

export async function getJiraConnectionStatus(
  input: { orgId: string },
  deps: Partial<JiraConnectServiceDeps> = {},
): Promise<JiraStatusResponse> {
  const resolved: JiraConnectServiceDeps = { ...defaultDeps, ...deps };
  const connection = await resolved.store.statusView(input.orgId);
  return {
    authorization: 'server-filtered',
    connection,
    updatedAt: new Date().toISOString(),
  };
}

/** Soft-revoke only — no call to any Atlassian-side revoke endpoint (3LO has no reliable programmatic revoke). */
export async function disconnectJira(
  input: { orgId: string; actorUserId: string; actorLabel: string },
  deps: Partial<JiraConnectServiceDeps> = {},
): Promise<JiraStatusResponse> {
  const resolved: JiraConnectServiceDeps = { ...defaultDeps, ...deps };
  await resolved.store.softRevoke(input.orgId, input.actorUserId, input.actorLabel);
  const connection = await resolved.store.statusView(input.orgId);
  return {
    authorization: 'server-filtered',
    connection,
    updatedAt: new Date().toISOString(),
  };
}

// Orchestration for the GitHub App install flow: start (redirect to GitHub) and
// callback (verify state -> mint token -> list repos -> write rows -> enqueue).
// Business logic lives here per .claude/rules/service-layer.md; the route
// (routes/githubInstall.ts) is a thin HTTP adapter that only calls these functions.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): org_id is
// resolved ONLY from the signed install-state token (set at install-start from
// req.context.orgId, itself server-resolved by authenticate() — W1-03, closing
// O-1) — NEVER from a callback query param. All DB writes run inside `withOrgContext`.
//
// Credential invariant: the App private key and any minted installation token
// are read/used ONLY via the W0-07 loader / in-memory (GithubAppClient) — never
// persisted, never logged. No raw installation credential is ever stored; only
// IDs/metadata land in `github_app_installations`.

import { getConfig } from '@sayre/config';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import {
  InstallStateError,
  signInstallState,
  verifyInstallState,
  type InstallState,
} from '../github/installState';
import {
  createDefaultGithubAppClient,
  GithubAppAuthorizationError,
  type AuthorizedInstallation,
  type GithubAppClient,
} from '../github/appClient';
import { getRuntimeDb, resolveInstallationOrg } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import { upsertInstallation } from '../db/githubAppInstallWrites';
import { startInstallationSync } from '../db/githubInstallationSyncStore';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import { kickInstallationDiscoveryDispatcher } from './installationDiscoveryWake';

export interface StartInstallResult {
  redirectTo: string;
}

export interface InstallStartDeps {
  signState: (orgId: string) => Promise<string>;
}

const defaultStartDeps: InstallStartDeps = {
  signState: signInstallState,
};

/**
 * Begins the install flow: signs a state token binding this flow to the
 * SERVER-resolved `orgId` (caller passes `requireOrgId(req)`, never a client
 * value), then returns the GitHub App installation URL to redirect the
 * browser to.
 */
export async function startGithubAppInstall(
  input: { orgId: string },
  deps: Partial<InstallStartDeps> = {},
): Promise<StartInstallResult> {
  const resolvedDeps: InstallStartDeps = { ...defaultStartDeps, ...deps };
  const state = await resolvedDeps.signState(input.orgId);
  const webBaseUrl = getConfig('GITHUB_WEB_BASE_URL');
  const slug = getConfig('GITHUB_APP_SLUG');
  return {
    redirectTo: `${webBaseUrl}/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`,
  };
}

export interface CallbackInput {
  installationId?: string; // req.query.installation_id
  setupAction?: string; // req.query.setup_action ('install' | 'update' | 'request')
  state?: string; // req.query.state (signed)
  code?: string; // req.query.code (required one-time GitHub App user OAuth code)
}

export interface CallbackResult {
  redirectTo: string;
  discovery: 'queued' | 'skipped';
}

export class InstallCallbackBadRequestError extends Error {
  constructor(message = 'Malformed GitHub App install callback request.') {
    super(message);
    this.name = 'InstallCallbackBadRequestError';
  }
}

/** An installation_id is already bound to a DIFFERENT org — never silently moved. */
export class InstallationOrgConflictError extends Error {
  constructor(message = 'This GitHub App installation is already bound to a different organization.') {
    super(message);
    this.name = 'InstallationOrgConflictError';
  }
}

/** The GitHub user completing OAuth cannot administer the installation account. */
export class GithubInstallationAuthorizationError extends Error {
  constructor() {
    super('The GitHub user cannot administer this installation account.');
    this.name = 'GithubInstallationAuthorizationError';
  }
}

/** Any GitHub App API failure (token mint or repo list) — maps to 502. */
export class GithubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export interface InstallCallbackDeps {
  verifyState: (token: string) => Promise<InstallState>;
  resolveExistingInstallationOrg: (
    installationId: number,
  ) => Promise<{ orgId: string; active: boolean } | null>;
  githubClient: GithubAppClient;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  getDb: () => Promise<Db>;
  upsertInstallation: typeof upsertInstallation;
  // W7-01 (OQ-3): replaces the callback's former inline enqueue/kick/repo-registration deps —
  // the callback writes a pending discovery run row instead of listing/registering repos inline.
  startInstallationSync: typeof startInstallationSync;
  kickDiscoveryDispatcher: () => void;
}

const defaultCallbackDeps: InstallCallbackDeps = {
  verifyState: verifyInstallState,
  resolveExistingInstallationOrg: async (installationId) =>
    resolveInstallationOrg(await getRuntimeDb(), installationId),
  githubClient: createDefaultGithubAppClient(),
  withOrg: withOrgContext,
  getDb: getRuntimeDb,
  upsertInstallation,
  startInstallationSync,
  kickDiscoveryDispatcher: kickInstallationDiscoveryDispatcher,
};

function parseInstallationId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function verifyState(
  deps: InstallCallbackDeps,
  rawState: string | undefined,
): Promise<InstallState> {
  if (!rawState || rawState.trim().length === 0) {
    throw new InstallCallbackBadRequestError('Missing state.');
  }
  try {
    return await deps.verifyState(rawState);
  } catch (error) {
    if (error instanceof InstallStateError) {
      throw new InstallCallbackBadRequestError('Invalid or expired state.');
    }
    throw error;
  }
}

async function authorizeInstallation(
  deps: InstallCallbackDeps,
  code: string,
  installationId: number,
): Promise<AuthorizedInstallation> {
  try {
    return await deps.githubClient.authorizeInstallation(code, installationId);
  } catch (error) {
    if (error instanceof GithubAppAuthorizationError) {
      throw new GithubInstallationAuthorizationError();
    }
    throw new GithubApiError('Failed to authorize the GitHub App installation.');
  }
}

/**
 * Exported (W2-09) so `githubInstallationRepositoriesService.ts` (webhook added path) and
 * `githubInstallationReconcileService.ts` (manual reconcile) build the EXACT same envelope
 * shape as the fresh-install callback — same `source`/`reason`/`trace_id`/`idempotency_key`
 * composition — rather than reimplementing it, so downstream idempotent-dedup and the W1-05
 * consumer need no changes (see spec.md OQ-4).
 */
export function buildInitialParseEnvelope(input: {
  orgId: string;
  installationId: number;
  repoId: string;
  providerRepoId: string;
  fullName: string;
  ref: string;
  revisionSha: string;
}): MessageEnvelope<RepoInitialParseEvent> {
  return makeEnvelope<RepoInitialParseEvent>({
    org_id: input.orgId,
    type: 'repo.initial_parse',
    source: 'github-app-install',
    trace_id: `install:${input.installationId}`,
    idempotency_key: [
      'github',
      'initial_parse',
      input.installationId,
      input.providerRepoId,
      input.ref,
      input.revisionSha,
    ].join(':'),
    payload: {
      provider: 'github',
      type: 'initial_parse',
      repo: { provider_repo_id: input.providerRepoId, full_name: input.fullName, repo_id: input.repoId },
      ref: input.ref,
      revision_sha: input.revisionSha,
      installation_id: String(input.installationId),
      reason: 'app_install',
    },
  });
}

/**
 * W7-01 (AC-1): row-write-only. Verifies `state` -> exchanges the one-time OAuth code and
 * proves the user administers the installation account -> in ONE `withOrgContext` transaction,
 * writes the installation row and a `pending` `github_installation_sync` row (`reason:
 * 'app_install'`) -> kicks the discovery dispatcher after commit. No GitHub repo-list call and
 * no BullMQ `enqueue()` happen on the request path — a dedicated background worker performs the
 * actual paginated discovery (`githubInstallationDiscoveryService.ts`).
 * `org_id` comes ONLY from the verified `state` token; a forged `org_id`-shaped query param is
 * never read.
 */
export async function handleGithubAppCallback(
  input: CallbackInput,
  deps: Partial<InstallCallbackDeps> = {},
): Promise<CallbackResult> {
  const resolvedDeps: InstallCallbackDeps = { ...defaultCallbackDeps, ...deps };
  const postInstallRedirect = getConfig('GITHUB_POST_INSTALL_REDIRECT_URL');

  const state = await verifyState(resolvedDeps, input.state);

  // GitHub does not include an installation_id for the org-owner-approval
  // ("request") flow — no token has been minted for an install that doesn't
  // exist yet, so there is nothing to write or dispatch (EC-7).
  if (input.setupAction === 'request') {
    return { redirectTo: postInstallRedirect, discovery: 'skipped' };
  }

  const installationId = parseInstallationId(input.installationId);
  if (installationId === null) {
    throw new InstallCallbackBadRequestError('Missing or non-numeric installation_id.');
  }
  if (!input.code || input.code.trim().length === 0) {
    throw new InstallCallbackBadRequestError('Missing OAuth callback code.');
  }

  // The signed state proves which Sayre organization started the flow. The
  // OAuth exchange independently proves that the GitHub user completing it
  // owns/administers this exact GitHub installation account. Never bind an
  // arbitrary query-string installation_id based on state alone.
  const authorizedInstallation = await authorizeInstallation(
    resolvedDeps,
    input.code,
    installationId,
  );
  const existing = await resolvedDeps.resolveExistingInstallationOrg(installationId);
  if (existing && existing.orgId !== state.org_id) {
    // EC-8: the conflict guard still runs BEFORE any row is written or dispatch occurs.
    throw new InstallationOrgConflictError();
  }

  const db = await resolvedDeps.getDb();
  await resolvedDeps.withOrg(db, state.org_id, async (tx) => {
    await resolvedDeps.upsertInstallation(tx, {
      orgId: state.org_id,
      installationId,
      accountLogin: authorizedInstallation.account_login,
      accountType: authorizedInstallation.account_type,
      // repository_selection is carried by installation webhooks; the
      // authenticated callback account metadata above is authoritative here.
      repositorySelection: null,
    });

    await resolvedDeps.startInstallationSync(tx, {
      orgId: state.org_id,
      installationId,
      reason: 'app_install',
      requestedBy: null, // a GitHub redirect is not an authenticated admin action (AC-25)
    });
  });

  // The kick is only a latency optimization: the durable dispatcher polls from startup, so a
  // process/request failure here cannot strand the row (OQ-3). It may fire only after `withOrg`
  // has committed the installation + sync row.
  resolvedDeps.kickDiscoveryDispatcher();

  return { redirectTo: postInstallRedirect, discovery: 'queued' };
}

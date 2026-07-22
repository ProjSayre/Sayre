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
  type GithubAppClient,
  type InstalledRepo,
} from '../github/appClient';
import { getRuntimeDb, resolveInstallationOrg } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import { registerRepository, upsertInstallation } from '../db/githubAppInstallWrites';
import { publishInitialParseEvent } from '../queue/sqs';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';

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
  code?: string; // req.query.code (optional OAuth user code) — unused (O-3)
}

export interface CallbackResult {
  redirectTo: string;
  enqueuedRepos: number;
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
  publishInitialParse: (envelope: MessageEnvelope<RepoInitialParseEvent>) => Promise<void>;
  upsertInstallation: typeof upsertInstallation;
  registerRepository: typeof registerRepository;
}

// MVP deviation from spec.md's own stated O-5 default ("bounded synchronous
// loop with pagination", i.e. unbounded except by GitHub's own page size):
// human-confirmed decision caps the callback at the first 25 repos returned
// by `listInstallationRepos` (in whatever order the API returns them) to
// bound both ingestion cost and the callback request's time budget on a very
// large org-wide install. Repos beyond the 25th are neither registered nor
// enqueued — no error, no partial-failure response, no "skipped repos"
// tracking. See .pipeline/changes.md "Deviations from spec".
const MAX_REPOS_PER_CALLBACK = 25;

const defaultCallbackDeps: InstallCallbackDeps = {
  verifyState: verifyInstallState,
  resolveExistingInstallationOrg: async (installationId) =>
    resolveInstallationOrg(await getRuntimeDb(), installationId),
  githubClient: createDefaultGithubAppClient(),
  withOrg: withOrgContext,
  getDb: getRuntimeDb,
  publishInitialParse: async (envelope) => {
    await publishInitialParseEvent(envelope);
  },
  upsertInstallation,
  registerRepository,
};

function parseInstallationId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

async function listInstalledRepos(
  deps: InstallCallbackDeps,
  installationId: number,
): Promise<InstalledRepo[]> {
  try {
    return await deps.githubClient.listInstallationRepos(installationId);
  } catch (error) {
    throw new GithubApiError(
      `Failed to fetch GitHub App installation repositories: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}

function buildInitialParseEnvelope(input: {
  orgId: string;
  installationId: number;
  repoId: string;
  providerRepoId: string;
  fullName: string;
  ref: string;
}): MessageEnvelope<RepoInitialParseEvent> {
  return makeEnvelope<RepoInitialParseEvent>({
    org_id: input.orgId,
    type: 'repo.initial_parse',
    source: 'github-app-install',
    trace_id: `install:${input.installationId}`,
    idempotency_key: `github:initial_parse:${input.installationId}:${input.providerRepoId}:${input.ref}`,
    payload: {
      provider: 'github',
      type: 'initial_parse',
      repo: { provider_repo_id: input.providerRepoId, full_name: input.fullName, repo_id: input.repoId },
      ref: input.ref,
      installation_id: String(input.installationId),
      reason: 'app_install',
    },
  });
}

/**
 * Verifies `state` -> mints an installation token + lists repos -> writes the
 * installation + repository rows -> enqueues one `repo.initial_parse` per
 * repo with a non-null default branch. `org_id` comes ONLY from the verified
 * `state` token; a forged `org_id`-shaped query param is never read.
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
  // exist yet, so there is nothing to write or enqueue.
  if (input.setupAction === 'request') {
    return { redirectTo: postInstallRedirect, enqueuedRepos: 0 };
  }

  const installationId = parseInstallationId(input.installationId);
  if (installationId === null) {
    throw new InstallCallbackBadRequestError('Missing or non-numeric installation_id.');
  }

  const existing = await resolvedDeps.resolveExistingInstallationOrg(installationId);
  if (existing && existing.orgId !== state.org_id) {
    throw new InstallationOrgConflictError();
  }

  const allRepos = await listInstalledRepos(resolvedDeps, installationId);
  // O-5 (human-confirmed deviation, see MAX_REPOS_PER_CALLBACK above): hard
  // cap, not pagination — repos past the cap are silently excluded.
  const repos = allRepos.slice(0, MAX_REPOS_PER_CALLBACK);

  const db = await resolvedDeps.getDb();
  const enqueuedRepos = await resolvedDeps.withOrg(db, state.org_id, async (tx) => {
    await resolvedDeps.upsertInstallation(tx, {
      orgId: state.org_id,
      installationId,
      // Neither the callback query params nor GithubAppClient expose account/
      // repository_selection metadata (that lands on the webhook payload —
      // W1-02's concern) — left null here; see .pipeline/changes.md.
      accountLogin: null,
      accountType: null,
      repositorySelection: null,
    });

    let enqueued = 0;
    for (const repo of repos) {
      const { repoId } = await resolvedDeps.registerRepository(tx, {
        orgId: state.org_id,
        providerRepoId: repo.provider_repo_id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
      });

      // No default branch (empty repo, no commits) => no ref to target a full
      // parse at. Registered, but excluded from enqueuedRepos.
      if (!repo.default_branch) continue;

      const envelope = buildInitialParseEnvelope({
        orgId: state.org_id,
        installationId,
        repoId,
        providerRepoId: repo.provider_repo_id,
        fullName: repo.full_name,
        ref: repo.default_branch,
      });
      await resolvedDeps.publishInitialParse(envelope);
      enqueued += 1;
    }
    return enqueued;
  });

  return { redirectTo: postInstallRedirect, enqueuedRepos };
}

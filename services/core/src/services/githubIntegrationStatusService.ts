import type {
  GitHubInstallationState,
  GitHubIntegrationStatusResponse,
  GitHubRepositoryImportState,
} from '@sayre/shared-types';
import {
  githubIntegrationStatusStore,
  type GitHubIntegrationStatusStore,
} from '../db/githubIntegrationStatusStore';

export interface GitHubIntegrationStatusServiceDeps {
  store: GitHubIntegrationStatusStore;
  now: () => Date;
}

const defaultDeps: GitHubIntegrationStatusServiceDeps = {
  store: githubIntegrationStatusStore,
  now: () => new Date(),
};

function installationState(input: {
  suspendedAt: Date | null;
  revokedAt: Date | null;
}): GitHubInstallationState {
  if (input.revokedAt !== null) return 'revoked';
  if (input.suspendedAt !== null) return 'suspended';
  return 'active';
}

function importState(input: {
  hasCurrentRef: boolean;
  hasDefaultBranch: boolean;
}): GitHubRepositoryImportState {
  if (input.hasCurrentRef) return 'ready';
  if (!input.hasDefaultBranch) return 'empty';
  return 'preparing';
}

/**
 * Builds the redacted browser read model. The org id is server-derived by the
 * authenticated route, and never appears in the response.
 */
export async function getGitHubIntegrationStatus(
  orgId: string,
  overrides: Partial<GitHubIntegrationStatusServiceDeps> = {},
): Promise<GitHubIntegrationStatusResponse> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const stored = await deps.store.get(orgId);

  return {
    authorization: 'server-filtered',
    installations: stored.installations.map((installation) => ({
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      state: installationState(installation),
      updatedAt: installation.updatedAt.toISOString(),
    })),
    repositories: stored.repositories.map((repository) => {
      const currentRef = repository.refs[0]?.refName ?? null;
      return {
        id: repository.id,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        currentRef,
        state: importState({
          hasCurrentRef: currentRef !== null,
          hasDefaultBranch: repository.defaultBranch !== null,
        }),
        registeredAt: repository.createdAt.toISOString(),
      };
    }),
    updatedAt: now.toISOString(),
  };
}

import type { MessageEnvelope } from '../queue/envelope';
import { assertValidEnvelope } from '../queue/envelope';
import type { OwnershipGraphStore } from '../integrations/git/graphOwnershipStore';
import { GitProviderRegistry } from '../integrations/git/providerRegistry';
import type { GitRepositoryResolver } from '../integrations/git/repositoryResolver';
import type { ProviderRepoEvent } from '../integrations/git/types';

export interface GitSyncDependencies {
  providers: GitProviderRegistry;
  installations: GitInstallationResolver;
  repositories: GitRepositoryResolver;
  graph: OwnershipGraphStore;
}

export interface GitInstallationResolver {
  resolve(installationId: number): Promise<{ orgId: string; active: boolean } | null>;
}

export interface GitSyncResult {
  status: 'applied' | 'ignored';
  provider: string;
  updatedFiles: number;
}

function githubInstallationId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const installationId = Number(value);
  return Number.isSafeInteger(installationId) && installationId > 0
    ? installationId
    : null;
}

export async function syncGitMetadata(
  envelope: MessageEnvelope<ProviderRepoEvent>,
  dependencies: GitSyncDependencies,
): Promise<GitSyncResult> {
  assertValidEnvelope(envelope);
  const event = envelope.payload;
  if (!envelope.type.startsWith('repo.') || envelope.type !== `repo.${event.type}`) {
    throw new Error('Git synchronization envelope type does not match its normalized event.');
  }

  if (event.provider === 'github') {
    const installationId = githubInstallationId(event.installation_id);
    if (installationId === null) {
      return { status: 'ignored', provider: event.provider, updatedFiles: 0 };
    }
    const installation = await dependencies.installations.resolve(installationId);
    if (
      installation === null ||
      !installation.active ||
      installation.orgId !== envelope.org_id
    ) {
      return { status: 'ignored', provider: event.provider, updatedFiles: 0 };
    }
  }

  const provider = dependencies.providers.get(event.provider);
  const changes = await provider.resolveChanges(event, envelope.occurred_at);
  if (changes.refName === null || changes.edits.length === 0) {
    return { status: 'ignored', provider: event.provider, updatedFiles: 0 };
  }

  const repository = await dependencies.repositories.resolve(envelope.org_id, event);
  const result = await dependencies.graph.apply({
    orgId: envelope.org_id,
    provider: event.provider,
    repositoryId: repository.repositoryId,
    refName: changes.refName,
    edits: changes.edits,
  });
  return {
    status: result.updatedFiles > 0 ? 'applied' : 'ignored',
    provider: event.provider,
    updatedFiles: result.updatedFiles,
  };
}

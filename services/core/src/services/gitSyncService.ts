import type { MessageEnvelope } from '../queue/envelope';
import { assertValidEnvelope } from '../queue/envelope';
import type { OwnershipGraphStore } from '../integrations/git/graphOwnershipStore';
import { GitProviderRegistry } from '../integrations/git/providerRegistry';
import type { GitRepositoryResolver } from '../integrations/git/repositoryResolver';
import type { ProviderRepoEvent } from '../integrations/git/types';

export interface GitSyncDependencies {
  providers: GitProviderRegistry;
  repositories: GitRepositoryResolver;
  graph: OwnershipGraphStore;
}

export interface GitSyncResult {
  status: 'applied' | 'ignored';
  provider: string;
  updatedFiles: number;
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

import type { MessageEnvelope } from '../queue/envelope';
import { assertValidEnvelope } from '../queue/envelope';
import type { OwnershipGraphStore } from '../integrations/git/graphOwnershipStore';
import { GIT_SYNC_TARGET_MS } from '../integrations/git/budgets';
import { GitProviderRegistry } from '../integrations/git/providerRegistry';
import type { GitRepositoryResolver } from '../integrations/git/repositoryResolver';
import type { ProviderRepoEvent } from '../integrations/git/types';
import {
  incrementGitSyncBudgetBreach,
  incrementGitSyncPushTruncated,
  incrementGitSyncUnmatchedFiles,
  recordGitSyncDuration,
} from '../telemetry/gitSyncMetrics';

export interface GitSyncDependencies {
  providers: GitProviderRegistry;
  repositories: GitRepositoryResolver;
  graph: OwnershipGraphStore;
}

export interface GitSyncResult {
  /** 'applied'    — at least one File node changed.
   *  'unmatched'  — the provider resolved edits but the graph matched zero File nodes
   *                 (GAP-1b).
   *  'ignored'    — the provider legitimately produced no change to apply. */
  status: 'applied' | 'unmatched' | 'ignored';
  provider: string;
  updatedFiles: number;
  /** W3-04 gapfill (GAP-1b). Paths the provider resolved that matched no File node. Empty
   *  on 'ignored'. */
  unmatchedPaths: string[];
  /** W3-04 gapfill (GAP-2). Monotonic elapsed ms for the whole service call (provider
   *  resolve + repo resolve + graph write). Compared against GIT_SYNC_TARGET_MS. */
  durationMs: number;
  /** W3-04 gapfill (GAP-5). Mirrors ProviderChangeSet; false unless the provider said
   *  otherwise. */
  truncated: boolean;
  rebuildRequired: boolean;
}

export async function syncGitMetadata(
  envelope: MessageEnvelope<ProviderRepoEvent>,
  dependencies: GitSyncDependencies,
): Promise<GitSyncResult> {
  assertValidEnvelope(envelope);
  const started = performance.now();
  const event = envelope.payload;
  if (!envelope.type.startsWith('repo.') || envelope.type !== `repo.${event.type}`) {
    throw new Error('Git synchronization envelope type does not match its normalized event.');
  }

  const provider = dependencies.providers.get(event.provider);
  const changes = await provider.resolveChanges(event, envelope.occurred_at);
  const truncated = changes.truncated ?? false;
  const rebuildRequired = changes.rebuildRequired ?? false;

  // W3-04 gapfill (GAP-2, GAP-5): every exit path (early "ignored" return included) goes
  // through this one place, so duration/budget-breach/truncation telemetry is recorded
  // exactly once per call regardless of which branch below returns.
  function finish(partial: {
    status: GitSyncResult['status'];
    updatedFiles: number;
    unmatchedPaths: string[];
  }): GitSyncResult {
    const durationMs = performance.now() - started;
    const attributes = { org_id: envelope.org_id, provider: event.provider, status: partial.status };
    recordGitSyncDuration(durationMs, attributes);
    if (durationMs > GIT_SYNC_TARGET_MS) {
      incrementGitSyncBudgetBreach(attributes);
    }
    if (truncated || rebuildRequired) {
      incrementGitSyncPushTruncated(attributes);
    }
    return {
      status: partial.status,
      provider: event.provider,
      updatedFiles: partial.updatedFiles,
      unmatchedPaths: partial.unmatchedPaths,
      durationMs,
      truncated,
      rebuildRequired,
    };
  }

  if (changes.refName === null || changes.edits.length === 0) {
    return finish({ status: 'ignored', updatedFiles: 0, unmatchedPaths: [] });
  }

  const repository = await dependencies.repositories.resolve(envelope.org_id, event);
  const result = await dependencies.graph.apply({
    orgId: envelope.org_id,
    provider: event.provider,
    repositoryId: repository.repositoryId,
    refName: changes.refName,
    edits: changes.edits,
  });

  // GAP-1b: name exactly which resolved paths the graph did NOT match, rather than only
  // knowing a count.
  const matchedPaths = new Set(result.matchedPaths);
  const unmatchedPaths = [...new Set(changes.edits.map((edit) => edit.path))].filter(
    (path) => !matchedPaths.has(path),
  );
  if (unmatchedPaths.length > 0) {
    incrementGitSyncUnmatchedFiles(unmatchedPaths.length, {
      org_id: envelope.org_id,
      provider: event.provider,
      status: result.updatedFiles > 0 ? 'applied' : 'unmatched',
    });
  }

  return finish({
    // GAP-1b: a write that matched zero File nodes is 'unmatched', never silently folded
    // into 'ignored' — the two are distinguishable by status, unmatchedPaths, and a metric.
    status: result.updatedFiles > 0 ? 'applied' : 'unmatched',
    updatedFiles: result.updatedFiles,
    unmatchedPaths,
  });
}

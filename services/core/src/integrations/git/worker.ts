import type { Worker } from 'bullmq';
import { createWorker } from '../../queue/bullmq';
import type { GithubInstallationDiscoveryPayload } from '../../queue/bullmq';
import type { MessageEnvelope } from '../../queue/envelope';
import { createOwnershipGraphStore } from './graphOwnershipStore';
import { GitProviderRegistry } from './providerRegistry';
import { GithubProviderAdapter } from './providers/github';
import { PostgresGitRepositoryResolver } from './repositoryResolver';
import { syncGitMetadata, type GitSyncDependencies } from '../../services/gitSyncService';
import type { ProviderRepoEvent } from './types';
import { runInstallationDiscovery } from '../../services/githubInstallationDiscoveryService';

// Duplicated as a literal (rather than importing GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE from
// '../../queue/bullmq') so this routing check keeps working under a test double that mocks that
// entire module (see worker.discoveryRouting.test.ts, which replaces '../../queue/bullmq' with
// only `{ createWorker }`). Must stay in sync with queue/bullmq.ts's
// GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE export.
const GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE = 'github.installation_discovery';

export interface GitSyncWorkerRuntime {
  worker: Worker;
  close(): Promise<void>;
}

async function defaultDependencies(): Promise<GitSyncDependencies> {
  return {
    providers: new GitProviderRegistry([new GithubProviderAdapter()]),
    repositories: new PostgresGitRepositoryResolver(),
    graph: await createOwnershipGraphStore(),
  };
}

export async function startGitSyncWorker(
  dependencies?: GitSyncDependencies,
): Promise<GitSyncWorkerRuntime> {
  const resolved = dependencies ?? (await defaultDependencies());
  const worker = await createWorker(
    'github-sync',
    async (envelope) => {
      // AC-9: discovery runs as job type github.installation_discovery on this SAME
      // existing queue; every other (repo.*) envelope routes to syncGitMetadata exactly
      // as before. QUEUE_NAMES/worker concurrency are unchanged.
      if (envelope.type === GITHUB_INSTALLATION_DISCOVERY_EVENT_TYPE) {
        await runInstallationDiscovery(
          envelope as MessageEnvelope<GithubInstallationDiscoveryPayload>,
        );
        return;
      }
      await syncGitMetadata(envelope as MessageEnvelope<ProviderRepoEvent>, resolved);
    },
    { concurrency: 4 },
  );

  return {
    worker,
    async close() {
      await Promise.allSettled([worker.close(), resolved.graph.close()]);
    },
  };
}

async function main(): Promise<void> {
  const runtime = await startGitSyncWorker();
  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  void main().catch(() => {
    // Avoid serializing an error that could contain provider request context.
    console.error('Git synchronization worker failed to start.');
    process.exit(1);
  });
}

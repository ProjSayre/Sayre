import type { Worker } from 'bullmq';
import { createWorker } from '../../queue/bullmq';
import { createOwnershipGraphStore } from './graphOwnershipStore';
import { GitProviderRegistry } from './providerRegistry';
import { GithubProviderAdapter } from './providers/github';
import { PostgresGitRepositoryResolver } from './repositoryResolver';
import { syncGitMetadata, type GitSyncDependencies } from '../../services/gitSyncService';
import { getRuntimeDb, resolveInstallationOrg } from '../../db/installations';

export interface GitSyncWorkerRuntime {
  worker: Worker;
  close(): Promise<void>;
}

async function defaultDependencies(): Promise<GitSyncDependencies> {
  return {
    providers: new GitProviderRegistry([new GithubProviderAdapter()]),
    installations: {
      resolve: async (installationId) =>
        resolveInstallationOrg(await getRuntimeDb(), installationId),
    },
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
      await syncGitMetadata(envelope, resolved);
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

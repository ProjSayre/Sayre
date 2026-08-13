import type { Worker } from 'bullmq';
import { createWorker } from '../../queue/bullmq';
import type { GithubInstallationDiscoveryPayload } from '../../queue/bullmq';
import type { MessageEnvelope } from '../../queue/envelope';
import { createOwnershipGraphStore } from './graphOwnershipStore';
import { loadGitProviderRegistry } from './providerCatalog';
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

/**
 * W3-04 gapfill (GAP-6, GAP-1b, GAP-4). `overrides` lets a test inject `repositories`/
 * `graph` while still exercising the REAL configuration-driven provider path
 * (`providers` defaults to `loadGitProviderRegistry()`, never a hardcoded adapter
 * literal) — this is what makes AC-11's end-to-end acceptance test meaningful. Any
 * dependency not supplied in `overrides` is built the production way.
 */
export async function startGitSyncWorker(
  overrides?: Partial<GitSyncDependencies>,
): Promise<GitSyncWorkerRuntime> {
  const resolved: GitSyncDependencies = {
    providers: overrides?.providers ?? loadGitProviderRegistry(),
    repositories: overrides?.repositories ?? new PostgresGitRepositoryResolver(),
    graph: overrides?.graph ?? (await createOwnershipGraphStore()),
  };

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
      const result = await syncGitMetadata(envelope as MessageEnvelope<ProviderRepoEvent>, resolved);
      // GAP-1b: the result is consumed, not discarded — an 'unmatched' write (edits
      // resolved but the graph matched zero File nodes) is distinguishable from a
      // legitimate 'ignored' event in the worker's own logs, not just the service
      // return value the old code threw away.
      if (result.status === 'unmatched') {
        // eslint-disable-next-line no-console
        console.warn(
          `[git-sync] provider "${result.provider}" resolved edits that matched zero File ` +
            `nodes (${result.unmatchedPaths.length} unmatched path(s)); org_id=${envelope.org_id}.`,
        );
      }
    },
    { concurrency: 4 },
  );

  // W3-04 gapfill (GAP-4): a terminal (every attempt exhausted) job failure is recorded —
  // org/provider/delivery/attempt/error-name only. Never the payload, never a credential.
  worker.on('failed', (job, error) => {
    const envelope = job?.data as
      | { org_id?: unknown; trace_id?: unknown; payload?: { provider?: unknown } }
      | undefined;
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        message: 'git-sync job failed',
        org_id: envelope?.org_id,
        provider: envelope?.payload?.provider,
        delivery_id: envelope?.trace_id,
        attemptsMade: job?.attemptsMade,
        error_name: error.name,
      }),
    );
  });

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

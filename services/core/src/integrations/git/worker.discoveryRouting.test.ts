// Leading-red test (W7-01, AC-9) for the git-sync worker's envelope routing: discovery runs as
// job type github.installation_discovery on the EXISTING github-sync queue (QUEUE_NAMES
// unchanged), and the worker must still route every repo.* envelope to syncGitMetadata with
// identical behaviour. worker.ts currently has no branch on envelope.type at all — it always
// calls syncGitMetadata — so this fails today (RED-CORRECT: "an unhandled branch").

import { describe, expect, it, vi } from 'vitest';

const syncGitMetadata = vi.fn(async () => ({ status: 'ignored' as const, updatedFiles: 0, unmatchedPaths: [] }));
const runInstallationDiscovery = vi.fn(async () => ({ status: 'complete' as const, pages: 0, discovered: 0, registered: 0, enqueued: 0, sweep: { outcome: 'not_applicable' as const, revoked: 0 } }));

vi.mock('../../services/gitSyncService', () => ({ syncGitMetadata }));
vi.mock('../../services/githubInstallationDiscoveryService', () => ({ runInstallationDiscovery }));

const createWorkerMock = vi.fn(
  async (
    _name: string,
    handler: (envelope: unknown, job: unknown) => Promise<void>,
  ) => {
    // Exposes the handler so the test can invoke it directly against fake envelopes,
    // mirroring how BullMQ would call it per received job.
    (createWorkerMock as unknown as { handler: typeof handler }).handler = handler;
    // W3-04's worker.on('failed', ...) registration (GAP-4) runs against whatever this mock
    // returns, so it needs an `on` even though this test never fires a 'failed' event itself.
    return { close: vi.fn(), on: vi.fn() };
  },
);
vi.mock('../../queue/bullmq', () => ({ createWorker: createWorkerMock }));

vi.mock('./graphOwnershipStore', () => ({ createOwnershipGraphStore: vi.fn(async () => ({ close: vi.fn() })) }));
vi.mock('./providerRegistry', () => ({ GitProviderRegistry: vi.fn() }));
vi.mock('./providers/github', () => ({ GithubProviderAdapter: vi.fn() }));
vi.mock('./repositoryResolver', () => ({ PostgresGitRepositoryResolver: vi.fn() }));

describe('git-sync worker — AC-9 (routes github.installation_discovery vs repo.* envelopes)', () => {
  // @spec AC-9
  it('routes a discovery envelope to runInstallationDiscovery and an ordinary repo.* envelope to syncGitMetadata, on the SAME worker instance', async () => {
    const { startGitSyncWorker } = await import('./worker');
    await startGitSyncWorker({
      providers: {} as never,
      repositories: {} as never,
      graph: { close: vi.fn() } as never,
    });

    const handler = (createWorkerMock as unknown as { handler: (envelope: unknown) => Promise<void> }).handler;
    const discoveryEnvelope = {
      type: 'github.installation_discovery',
      payload: { provider: 'github', type: 'installation_discovery', installation_id: '555', run_id: 'run-1', reason: 'app_install' },
    };
    const repoEnvelope = { type: 'repo.push', payload: {} };

    await handler(discoveryEnvelope);
    expect(runInstallationDiscovery).toHaveBeenCalledWith(discoveryEnvelope);
    expect(syncGitMetadata).not.toHaveBeenCalled();

    await handler(repoEnvelope);
    // AC-9's second half — repo.* still routes to syncGitMetadata "with identical behaviour" —
    // reuses the SAME handler instance the discovery branch above was just proven to exist on,
    // so this only resolves once the worker actually branches on envelope.type at all (today it
    // unconditionally calls syncGitMetadata for every envelope, which is what fails the first
    // half above).
    expect(syncGitMetadata).toHaveBeenCalledWith(repoEnvelope, expect.anything());
    expect(runInstallationDiscovery).toHaveBeenCalledTimes(1); // unchanged by the repo.* call
  });
});

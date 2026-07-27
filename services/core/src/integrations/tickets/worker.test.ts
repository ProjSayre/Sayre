// Unit tests for the `jira-sync` BullMQ consumer's per-org/per-job adapter
// wiring (W3-10). `startTicketSyncWorkers` wires its handlers directly into
// `createWorker(...)` with no exported seam to invoke them standalone, so
// this file mocks `createWorker` (queue/bullmq) to CAPTURE the real handler
// closures for both `jira-sync` and `linear-sync`, then invokes them
// directly with a fake envelope — exercising the actual production code
// path (resolveJiraConnectionContext -> getOrgSecret -> JiraProviderAdapter
// -> syncTicket -> touchLastSynced), not a re-implementation of it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';
import type { MessageEnvelope } from '../../queue/envelope';
import type { TicketSyncDependencies } from '../../services/ticketSyncService';
import type { JiraConnectionContext } from './jira/orgSecrets';

type CapturedHandler = (envelope: MessageEnvelope, job?: Job) => Promise<void>;

// vi.mock(...) factories are hoisted above ALL other module-level code
// (including top-level `const`s) — every value a factory reads must itself
// be created inside vi.hoisted() so it exists before the hoisted factory
// runs. See https://vitest.dev/api/vi.html#vi-hoisted.
const {
  capturedHandlers,
  createWorker,
  resolveJiraConnectionContext,
  getOrgSecret,
  FakeOrgSecretUnavailableError,
  touchLastSynced,
  capturedJiraAdapterCtorArgs,
  FakeJiraProviderAdapter,
  syncTicket,
} = vi.hoisted(() => {
  const capturedHandlers = new Map<string, CapturedHandler>();
  const createWorker = vi.fn(
    async (name: string, handler: CapturedHandler): Promise<Worker> => {
      capturedHandlers.set(name, handler);
      return { close: vi.fn(async () => undefined) } as unknown as Worker;
    },
  );
  const resolveJiraConnectionContext = vi.fn();
  const getOrgSecret = vi.fn();

  class FakeOrgSecretUnavailableError extends Error {
    constructor(message = 'No usable Jira credential is available for this organization.') {
      super(message);
      this.name = 'OrgSecretUnavailableError';
    }
  }

  const touchLastSynced = vi.fn(async () => undefined);
  const capturedJiraAdapterCtorArgs: unknown[][] = [];
  class FakeJiraProviderAdapter {
    provider = 'jira' as const;
    constructor(...args: unknown[]) {
      capturedJiraAdapterCtorArgs.push(args);
    }
    externalIdFromWebhook = vi.fn();
    fetchTicket = vi.fn();
    updateTicket = vi.fn();
  }
  const syncTicket = vi.fn(async () => ({
    provider: 'jira' as const,
    externalTicketId: 'X-1',
    linkedNodes: 0,
  }));

  return {
    capturedHandlers,
    createWorker,
    resolveJiraConnectionContext,
    getOrgSecret,
    FakeOrgSecretUnavailableError,
    touchLastSynced,
    capturedJiraAdapterCtorArgs,
    FakeJiraProviderAdapter,
    syncTicket,
  };
});

vi.mock('../../queue/bullmq', () => ({ createWorker }));
vi.mock('./jira/orgSecrets', () => ({
  resolveJiraConnectionContext,
  getOrgSecret,
  OrgSecretUnavailableError: FakeOrgSecretUnavailableError,
}));
vi.mock('../../db/jiraConnectionStore', () => ({
  jiraConnectionStore: { touchLastSynced },
}));
vi.mock('./providers/jira', () => ({ JiraProviderAdapter: FakeJiraProviderAdapter }));
vi.mock('../../services/ticketSyncService', () => ({ syncTicket }));

import { startTicketSyncWorkers } from './worker';

function makeEnvelope(orgId: string): MessageEnvelope {
  return {
    message_id: 'msg-1',
    idempotency_key: `jira:sync:${orgId}:1`,
    org_id: orgId,
    type: 'ticket.inbound',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    source: 'jira-webhook',
    payload: {
      provider: 'jira',
      direction: 'inbound',
      external_ticket_id: 'PAY-1',
      repository_id: 'repo-1',
      ref_name: 'refs/heads/main',
    },
  };
}

function fakeDependencies(): TicketSyncDependencies {
  return {
    providers: { get: vi.fn() } as unknown as TicketSyncDependencies['providers'],
    cache: { upsert: vi.fn(async () => undefined) } as unknown as TicketSyncDependencies['cache'],
    graph: {
      apply: vi.fn(async () => ({ linkedNodes: 0 })),
      close: vi.fn(async () => undefined),
    } as unknown as TicketSyncDependencies['graph'],
  };
}

beforeEach(() => {
  capturedHandlers.clear();
  capturedJiraAdapterCtorArgs.length = 0;
  createWorker.mockClear();
  resolveJiraConnectionContext.mockReset();
  getOrgSecret.mockReset();
  touchLastSynced.mockClear();
  syncTicket.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('jira-sync worker handler', () => {
  it('no-ops gracefully (no throw) when the org has no active/revoked Jira connection', async () => {
    resolveJiraConnectionContext.mockResolvedValueOnce(null);
    const runtime = await startTicketSyncWorkers(fakeDependencies());
    const jiraHandler = capturedHandlers.get('jira-sync')!;

    await expect(jiraHandler(makeEnvelope('org-a'))).resolves.toBeUndefined();

    expect(syncTicket).not.toHaveBeenCalled();
    expect(touchLastSynced).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('builds a per-org adapter (gateway apiBaseUrl for API calls, siteUrl for browse) and touches last_synced_at on success', async () => {
    const ctx: JiraConnectionContext = {
      cloudId: 'cloud-a',
      apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-a',
      siteUrl: 'https://acme.atlassian.net',
    };
    resolveJiraConnectionContext.mockResolvedValueOnce(ctx);
    getOrgSecret.mockResolvedValueOnce('fresh-access-token');
    const runtime = await startTicketSyncWorkers(fakeDependencies());
    const jiraHandler = capturedHandlers.get('jira-sync')!;

    await jiraHandler(makeEnvelope('org-a'));

    expect(syncTicket).toHaveBeenCalledOnce();
    expect(touchLastSynced).toHaveBeenCalledWith('org-a', expect.any(Date));

    // Constructor args: (loadToken, fetcher, baseUrl, browseBaseUrl).
    const [ctorArgs] = capturedJiraAdapterCtorArgs;
    const [loadToken, , baseUrlFn, browseBaseUrlFn] = ctorArgs as [
      () => Promise<string>,
      unknown,
      () => string,
      () => string,
    ];
    expect(await loadToken()).toBe('fresh-access-token');
    expect(getOrgSecret).toHaveBeenCalledWith('org-a', 'JIRA_ACCESS_TOKEN');
    expect(baseUrlFn()).toBe('https://api.atlassian.test/ex/jira/cloud-a');
    expect(browseBaseUrlFn()).toBe('https://acme.atlassian.net');
    expect(baseUrlFn()).not.toBe(browseBaseUrlFn());
    await runtime.close();
  });

  it('graceful no-op (no throw) when getOrgSecret throws OrgSecretUnavailableError mid-job (revoked between resolve and use)', async () => {
    resolveJiraConnectionContext.mockResolvedValueOnce({
      cloudId: 'cloud-a',
      apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-a',
      siteUrl: 'https://acme.atlassian.net',
    });
    getOrgSecret.mockRejectedValueOnce(new FakeOrgSecretUnavailableError());
    // syncTicket calls `providers.get(...)` normally, but here the loader
    // itself throws before any HTTP call; simulate that by making syncTicket
    // invoke the injected loader (mirroring how the real adapter's request()
    // awaits loadToken() first).
    syncTicket.mockImplementationOnce(async (_envelope: unknown, deps: TicketSyncDependencies) => {
      const jira = (deps.providers as unknown as { get: (p: string) => { fetchTicket: () => Promise<unknown> } }).get?.('jira');
      void jira;
      // Directly invoke the loader captured on the fake adapter to mimic a
      // real request() awaiting loadToken() and having it reject.
      const [ctorArgs] = capturedJiraAdapterCtorArgs;
      const [loadToken] = ctorArgs as [() => Promise<string>];
      await loadToken();
      return { provider: 'jira' as const, externalTicketId: 'X', linkedNodes: 0 };
    });

    const runtime = await startTicketSyncWorkers(fakeDependencies());
    const jiraHandler = capturedHandlers.get('jira-sync')!;

    await expect(jiraHandler(makeEnvelope('org-a'))).resolves.toBeUndefined();
    expect(touchLastSynced).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('rethrows a non-OrgSecretUnavailableError failure (real infra failure -> BullMQ retry/DLQ, not swallowed)', async () => {
    resolveJiraConnectionContext.mockResolvedValueOnce({
      cloudId: 'cloud-a',
      apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-a',
      siteUrl: 'https://acme.atlassian.net',
    });
    getOrgSecret.mockResolvedValueOnce('fresh-token');
    syncTicket.mockRejectedValueOnce(new Error('Neo4j write failed'));

    const runtime = await startTicketSyncWorkers(fakeDependencies());
    const jiraHandler = capturedHandlers.get('jira-sync')!;

    await expect(jiraHandler(makeEnvelope('org-a'))).rejects.toThrow('Neo4j write failed');
    expect(touchLastSynced).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('cross-org: resolves context/secret using ONLY the envelope\'s own org_id', async () => {
    resolveJiraConnectionContext.mockResolvedValueOnce({
      cloudId: 'cloud-b',
      apiBaseUrl: 'https://api.atlassian.test/ex/jira/cloud-b',
      siteUrl: 'https://beta.atlassian.net',
    });
    getOrgSecret.mockResolvedValueOnce('org-b-token');
    const runtime = await startTicketSyncWorkers(fakeDependencies());
    const jiraHandler = capturedHandlers.get('jira-sync')!;

    await jiraHandler(makeEnvelope('org-b'));

    expect(resolveJiraConnectionContext).toHaveBeenCalledWith('org-b');
    expect(resolveJiraConnectionContext).not.toHaveBeenCalledWith('org-a');
    // syncTicket is mocked and never itself invokes the injected loader
    // (that only happens inside the REAL adapter's request()) — invoke the
    // captured loader directly to confirm it closes over 'org-b', not 'org-a'
    // or any other tenant.
    const [ctorArgs] = capturedJiraAdapterCtorArgs;
    const [loadToken] = ctorArgs as [() => Promise<string>];
    await loadToken();
    expect(getOrgSecret).toHaveBeenCalledWith('org-b', 'JIRA_ACCESS_TOKEN');
    expect(getOrgSecret).not.toHaveBeenCalledWith('org-a', expect.anything());
    expect(touchLastSynced).toHaveBeenCalledWith('org-b', expect.any(Date));
    await runtime.close();
  });
});

describe('linear-sync worker handler — regression (must stay UNCHANGED by W3-10)', () => {
  it('calls syncTicket directly with the shared dependencies (no per-org adapter construction, no orgSecrets involvement)', async () => {
    const deps = fakeDependencies();
    const runtime = await startTicketSyncWorkers(deps);
    const linearHandler = capturedHandlers.get('linear-sync')!;

    await linearHandler(makeEnvelope('org-a'));

    expect(syncTicket).toHaveBeenCalledWith(expect.objectContaining({ org_id: 'org-a' }), deps);
    expect(resolveJiraConnectionContext).not.toHaveBeenCalled();
    expect(getOrgSecret).not.toHaveBeenCalled();
    await runtime.close();
  });
});

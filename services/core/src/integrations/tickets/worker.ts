import type { Worker } from 'bullmq';
import { createWorker } from '../../queue/bullmq';
import {
  defaultRequestReferenceMatch,
  syncTicket,
  type TicketSyncDependencies,
} from '../../services/ticketSyncService';
import { createTicketGraphStore } from './graphTicketStore';
import { JiraProviderAdapter } from './providers/jira';
import { LinearProviderAdapter } from './providers/linear';
import { TicketProviderRegistry } from './providerRegistry';
import { PostgresTicketCacheStore } from './ticketCacheStore';
import {
  getOrgSecret,
  OrgSecretUnavailableError,
  resolveJiraConnectionContext,
} from './jira/orgSecrets';
import { jiraConnectionStore } from '../../db/jiraConnectionStore';

export interface TicketSyncWorkerRuntime {
  workers: readonly Worker[];
  close(): Promise<void>;
}

async function defaultDependencies(): Promise<TicketSyncDependencies> {
  return {
    providers: new TicketProviderRegistry([
      new JiraProviderAdapter(),
      new LinearProviderAdapter(),
    ]),
    cache: new PostgresTicketCacheStore(),
    graph: await createTicketGraphStore(),
    requestReferenceMatch: defaultRequestReferenceMatch,
  };
}

export async function startTicketSyncWorkers(
  dependencies?: TicketSyncDependencies,
): Promise<TicketSyncWorkerRuntime> {
  const resolved = dependencies ?? (await defaultDependencies());
  const [jira, linear] = await Promise.all([
    // W3-10: jira-sync resolves credentials + API base PER-ORG PER-JOB via
    // getOrgSecret/resolveJiraConnectionContext -- the shared `resolved`
    // dependencies' TicketProviderRegistry is only overridden for this one
    // call (`{ ...resolved, providers }`), never mutated. A revoked/absent
    // connection (at job start, or discovered mid-job via
    // OrgSecretUnavailableError -- e.g. disconnected between
    // resolveJiraConnectionContext and token use, or a refresh invalid_grant)
    // is a graceful no-op: no throw into BullMQ's retry/DLQ path.
    createWorker('jira-sync', async (envelope) => {
      const orgId = envelope.org_id;
      const ctx = await resolveJiraConnectionContext(orgId);
      if (ctx === null) return;
      try {
        const jiraAdapter = new JiraProviderAdapter(
          () => getOrgSecret(orgId, 'JIRA_ACCESS_TOKEN'),
          undefined,
          () => ctx.apiBaseUrl,
          () => ctx.siteUrl,
        );
        const providers = new TicketProviderRegistry([jiraAdapter]);
        await syncTicket(envelope, { ...resolved, providers });
        await jiraConnectionStore.touchLastSynced(orgId, new Date());
      } catch (error) {
        if (error instanceof OrgSecretUnavailableError) return;
        throw error;
      }
    }, { concurrency: 4 }),
    // linear-sync is UNCHANGED (W3-10 scope: Linear keeps its existing global
    // LINEAR_* env secrets; a per-org Linear connect flow is a documented
    // follow-up, not this ticket).
    createWorker('linear-sync', async (envelope) => {
      await syncTicket(envelope, resolved);
    }, { concurrency: 4 }),
  ]);
  const workers = [jira, linear] as const;
  return {
    workers,
    async close() {
      await Promise.allSettled([
        ...workers.map(async (worker) => worker.close()),
        resolved.graph.close(),
      ]);
    },
  };
}

async function main(): Promise<void> {
  const runtime = await startTicketSyncWorkers();
  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Ticket synchronization workers failed to start.');
    process.exit(1);
  });
}

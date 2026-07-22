import type { Worker } from 'bullmq';
import { createWorker } from '../../queue/bullmq';
import { syncTicket, type TicketSyncDependencies } from '../../services/ticketSyncService';
import { createTicketGraphStore } from './graphTicketStore';
import { JiraProviderAdapter } from './providers/jira';
import { LinearProviderAdapter } from './providers/linear';
import { TicketProviderRegistry } from './providerRegistry';
import { PostgresTicketCacheStore } from './ticketCacheStore';

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
  };
}

export async function startTicketSyncWorkers(
  dependencies?: TicketSyncDependencies,
): Promise<TicketSyncWorkerRuntime> {
  const resolved = dependencies ?? (await defaultDependencies());
  const [jira, linear] = await Promise.all([
    createWorker('jira-sync', async (envelope) => {
      await syncTicket(envelope, resolved);
    }, { concurrency: 4 }),
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

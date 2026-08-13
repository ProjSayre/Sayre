import { createApp } from './app';
import { getConfig, getSecret } from '@sayre/config';
import { assertRuntimeRoleRlsSafe } from './security/assertRuntimeRoleRlsSafe';
import { assertInstallationResolverReady } from './security/assertInstallationResolverReady';
import { assertInitialParseOutboxReady } from './security/assertInitialParseOutboxReady';
import { assertInstallationDiscoveryOutboxReady } from './security/assertInstallationDiscoveryOutboxReady';
import { getInitialParseOutboxDispatcher } from './services/initialParseOutboxDispatcher';
import { setInitialParseOutboxWakeHandler } from './services/initialParseOutboxWake';
import { getInstallationDiscoveryDispatcher } from './services/installationDiscoveryDispatcher';
import { setInstallationDiscoveryWakeHandler } from './services/installationDiscoveryWake';
import { closeSqsClient } from './queue/sqs';
import { closeQueues } from './queue/bullmq';

const portText = getConfig('CORE_PORT');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CORE_PORT must be an integer between 1 and 65535.');
}

async function main(): Promise<void> {
  // CI/production startup gate (Resolved decision Q2, docs/tenant-isolation.md
  // "DSN-role provisioning risk"). No-ops outside NODE_ENV=production/CI=true
  // -- local dev's login role is intentionally a superuser.
  const runtimeDsn = await getSecret('env://DATABASE_RUNTIME_URL');
  await assertRuntimeRoleRlsSafe(runtimeDsn);
  await assertInstallationResolverReady(runtimeDsn);
  await assertInitialParseOutboxReady(runtimeDsn);
  await assertInstallationDiscoveryOutboxReady(runtimeDsn);

  const outboxDispatcher = getInitialParseOutboxDispatcher();
  setInitialParseOutboxWakeHandler(() => outboxDispatcher.kick());
  outboxDispatcher.start();

  // W7-01 (OQ-3): the discovery dispatcher is the only thing that calls BullMQ enqueue() for
  // github.installation_discovery — start it and install its wake handler exactly as the
  // initial-parse dispatcher above.
  const discoveryDispatcher = getInstallationDiscoveryDispatcher();
  setInstallationDiscoveryWakeHandler(() => discoveryDispatcher.kick());
  discoveryDispatcher.start();

  const server = createApp().listen(port, () => console.log(`[core] listening on :${port}`));

  let shutdownPending: Promise<void> | null = null;
  const shutdown = (): void => {
    if (shutdownPending) return;
    shutdownPending = (async () => {
      // Stop accepting callbacks first and let any request transaction finish.
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // No callback can append more work now. Finish the bounded active batch,
      // then destroy the shared SQS client and BullMQ queues before exiting.
      setInitialParseOutboxWakeHandler(null);
      await outboxDispatcher.stop();
      setInstallationDiscoveryWakeHandler(null);
      await discoveryDispatcher.stop();
      await closeSqsClient();
      await closeQueues();
    })();
    void shutdownPending.then(
      () => process.exit(0),
      () => {
        console.error('[core] graceful shutdown failed');
        process.exit(1);
      },
    );
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch(() => {
  console.error('[core] startup failed');
  process.exitCode = 1;
});

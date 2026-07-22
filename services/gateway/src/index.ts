// Process entrypoint: boots the Realtime Service and wires SIGTERM/SIGINT
// graceful shutdown (see server.ts's GatewayHandle.close()).

import { startGateway } from './server';

let shuttingDown = false;

async function main(): Promise<void> {
  const handle = await startGateway();
  console.log(`[gateway] listening on :${handle.port}`);

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[gateway] error during shutdown', err);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[gateway] failed to start', err);
  process.exit(1);
});

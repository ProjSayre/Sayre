// Process boot: creates the http.Server + `ws` server + /health route,
// constructs the ConnectionRegistry, the Redis bus, the SQS consumer, and the
// fan-out wiring. This is the REAL-boot entrypoint (AC8) — for in-process
// tests that need fakes for Redis/SQS/Core, compose the smaller building
// blocks directly (ws/connection.ts's attachConnectionLifecycle,
// fanout/fanout.ts's fanOutGraphUpdated, redis/pubsub.ts's
// createGraphUpdatedBus, sqs/consumer.ts's createRealtimeSqsConsumer) instead
// of calling startGateway(), which always talks to real Redis/SQS/Core.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getGatewayHealth } from './health';
import { getCoreInternalBaseUrl, getGatewayPort, getGatewayRedisChannel, getRealtimeQueueName } from './config';
import {
  attachConnectionLifecycle,
  ConnectionRegistry,
  createPendingConnection,
  UNAUTHENTICATED_CLOSE_CODE,
  type AttachConnectionDeps,
  type GatewayConnection,
} from './ws/connection';
import { createGraphUpdatedBus } from './redis/pubsub';
import { createChatEventBus } from './redis/chatPubsub';
import { chatEventChannel } from './ws/chatEvents';
import { createRealtimeSqsConsumer } from './sqs/consumer';
import { fanOutGraphUpdated } from './fanout/fanout';
import { relayChatEvent } from './fanout/chatFanout';
import { fetchAuthorizedDelta, fetchChatPushAuthorization } from './coreClient';

export interface GatewayHandle {
  port: number;
  close(): Promise<void>;
}

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getGatewayHealth()));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

export async function startGateway(opts?: { port?: number }): Promise<GatewayHandle> {
  const port = opts?.port ?? getGatewayPort();
  const coreBaseUrl = getCoreInternalBaseUrl();
  const registry = new ConnectionRegistry();

  const bus = await createGraphUpdatedBus(getGatewayRedisChannel());
  await bus.subscribe((envelope) =>
    fanOutGraphUpdated(envelope, registry, {
      fetchDelta: fetchAuthorizedDelta,
      coreBaseUrl,
      onUnauthorized: (conn) => conn.socket.close(UNAUTHENTICATED_CLOSE_CODE, 'core rejected token'),
    }),
  );

  const chatBus = await createChatEventBus();
  const chatDeps: AttachConnectionDeps = {
    authorizeChatSubscription: async (conn, conversationId) => {
      try {
        await fetchChatPushAuthorization({
          baseUrl: coreBaseUrl,
          token: conn.token,
          conversationId,
          nodeIds: [],
        });
        return true;
      } catch {
        return false; // fail closed on forbidden AND on unavailable
      }
    },
    acquireChatChannel: (orgId, conversationId) => chatBus.subscribe(chatEventChannel(orgId, conversationId)),
    releaseChatChannel: (orgId, conversationId) => chatBus.unsubscribe(chatEventChannel(orgId, conversationId)),
  };
  chatBus.onEvent((event) =>
    relayChatEvent(event, registry, {
      authorizePush: fetchChatPushAuthorization,
      coreBaseUrl,
      onUnauthorized: (conn) => conn.socket.close(UNAUTHENTICATED_CLOSE_CODE, 'core rejected token'),
      onSubscriptionRevoked: async (conn: GatewayConnection, conversationId: string) => {
        conn.chatSubscriptions.delete(conversationId);
        await chatBus.unsubscribe(chatEventChannel(conn.orgId, conversationId));
      },
    }),
  );

  const consumer = createRealtimeSqsConsumer({
    queueName: getRealtimeQueueName(),
    onEnvelope: (envelope) => bus.publish(envelope),
  });
  consumer.start();

  const server = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, req) => {
    const conn = createPendingConnection(randomUUID(), socket);
    attachConnectionLifecycle(conn, req, registry, chatDeps);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  return {
    port,
    async close(): Promise<void> {
      // Graceful shutdown order: stop pulling new SQS work first, then stop
      // accepting/serving WS traffic, then release the Redis connections, then
      // close the HTTP listener. No SQS message is deleted without having been
      // fanned out (see sqs/consumer.ts's stop()).
      await consumer.stop();
      for (const conn of registry.all()) {
        conn.socket.close(1001, 'server shutting down');
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await bus.close();
      await chatBus.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

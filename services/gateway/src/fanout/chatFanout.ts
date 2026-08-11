// CH-05 — relayChatEvent: per-connection, PER-PUSH RBAC re-filter and send.
// Sibling of fanout/fanout.ts, but re-asks Core on EVERY delivery (progress,
// completed and error alike) rather than only on a delta with citations —
// the ownership half of the re-filter applies to every push, not just ones
// that carry citation node ids (EC-28). Never trusts a subscribe-time check
// for later pushes (.claude/rules/security-multitenancy.md, AC-2/AC-9).

import type { ChatTurnCompletedPush, ChatTurnPush, GatewayToClientMessage } from '@sayre/shared-types';
import type { ConnectionRegistry, GatewayConnection } from '../ws/connection';
import { CHAT_FORBIDDEN_CODE, CHAT_FORBIDDEN_MESSAGE } from '../ws/connection';
import { encodeServerMessage } from '../ws/protocol';
import { citationNodeIds, filterCitations, type DecodedChatEvent } from '../ws/chatEvents';
import { CoreForbiddenError, CoreUnauthorizedError, CoreUnavailableError, fetchChatPushAuthorization } from '../coreClient';

export interface ChatFanOutDeps {
  authorizePush: typeof fetchChatPushAuthorization;
  coreBaseUrl: string;
  onUnauthorized: (conn: GatewayConnection) => void; // close the connection, force re-auth
  onSubscriptionRevoked: (conn: GatewayConnection, conversationId: string) => Promise<void> | void;
  maxConcurrency?: number; // default 16, mirroring fanout/fanout.ts
}

const DEFAULT_MAX_CONCURRENCY = 16;

function sendSafe(conn: GatewayConnection, message: GatewayToClientMessage): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return; // disconnected mid-fan-out -- no-op
  try {
    conn.socket.send(encodeServerMessage(message));
  } catch (err) {
    console.error('[gateway] failed to send chat frame to client; dropping (socket likely closing)', err);
  }
}

function buildPush(push: ChatTurnPush, authorizedNodeIds: ReadonlySet<string>): ChatTurnPush {
  if (push.type !== 'chat.turn.completed') return push;
  return filterCitations(push as ChatTurnCompletedPush, authorizedNodeIds);
}

async function pushToConnection(
  conn: GatewayConnection,
  event: DecodedChatEvent,
  deps: ChatFanOutDeps,
): Promise<void> {
  const nodeIds = citationNodeIds(event.push);
  try {
    const auth = await deps.authorizePush({
      baseUrl: deps.coreBaseUrl,
      token: conn.token,
      conversationId: event.conversationId,
      nodeIds,
    });

    // Defensive: a mismatched response is never trusted.
    if (auth.conversationId !== event.conversationId) {
      console.error('[gateway] chat authorization response conversationId mismatch; dropping push', {
        connectionId: conn.id,
      });
      return;
    }

    const push = buildPush(event.push, new Set(auth.authorizedNodeIds));
    sendSafe(conn, push);
  } catch (err) {
    if (err instanceof CoreUnauthorizedError) {
      deps.onUnauthorized(conn);
      return;
    }
    if (err instanceof CoreForbiddenError) {
      sendSafe(conn, { type: 'error', code: CHAT_FORBIDDEN_CODE, message: CHAT_FORBIDDEN_MESSAGE });
      await deps.onSubscriptionRevoked(conn, event.conversationId);
      return;
    }
    if (err instanceof CoreUnavailableError) {
      console.error('[gateway] Core chat authorization unavailable; skipping this push', {
        conversationId: event.conversationId,
        connectionId: conn.id,
      });
      return;
    }
    throw err;
  }
}

/**
 * Selects registry.matchingChat(event.orgId, event.conversationId) and, for EACH
 * matching connection on EVERY event, re-asks Core over that connection's own
 * token before sending anything.
 */
export async function relayChatEvent(
  event: DecodedChatEvent,
  registry: ConnectionRegistry,
  deps: ChatFanOutDeps,
): Promise<void> {
  const connections = registry.matchingChat(event.orgId, event.conversationId);
  if (connections.length === 0) return;

  const maxConcurrency = deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const workerCount = Math.min(maxConcurrency, connections.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < connections.length) {
      const conn = connections[nextIndex];
      nextIndex += 1;
      await pushToConnection(conn, event, deps);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

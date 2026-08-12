// GatewayConnection + ConnectionRegistry, and the inbound-message state machine
// (auth -> subscribe/unsubscribe). This is the single implementation of
// per-connection lifecycle wiring, used by both server.ts (real boot, real
// Redis/SQS) and tests (an in-process `ws` client/server pair with injected
// fakes) — see attachConnectionLifecycle below.

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { ClientToGatewayMessage, GatewayToClientMessage, OrgRole } from '@sayre/shared-types';
import {
  authenticateConnectionToken,
  devConnectionIdentity,
  extractUpgradeToken,
  isDevOrTestEnvironment,
  type ConnectionIdentity,
} from './auth';
import { decodeClientMessage, encodeServerMessage, isChatChannelMessage, ProtocolError } from './protocol';

export interface GatewayConnection {
  id: string;
  socket: WebSocket;
  orgId: string; // derived at connect from verifySessionToken -- the coarse tenant gate
  roles: OrgRole[]; // from the verified token
  userId: string;
  token: string; // forwarded per push; MUST NOT be logged
  repoSubscriptions: Set<string>;
  chatSubscriptions: Set<string>; // NEW (CH-05) -- conversation ids, owner-verified at subscribe time
  authenticated: boolean;
}

/** A fresh, unauthenticated connection record. Callers must registry.add() it. */
export function createPendingConnection(id: string, socket: WebSocket): GatewayConnection {
  return {
    id,
    socket,
    orgId: '',
    roles: [],
    userId: '',
    token: '',
    repoSubscriptions: new Set<string>(),
    chatSubscriptions: new Set<string>(),
    authenticated: false,
  };
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, GatewayConnection>();

  add(conn: GatewayConnection): void {
    this.connections.set(conn.id, conn);
  }

  remove(id: string): void {
    this.connections.delete(id);
  }

  get(id: string): GatewayConnection | undefined {
    return this.connections.get(id);
  }

  /** authenticated && orgId match && repoId is in the connection's subscriptions. */
  matching(orgId: string, repoId: string): GatewayConnection[] {
    return this.all().filter(
      (conn) => conn.authenticated && conn.orgId === orgId && conn.repoSubscriptions.has(repoId),
    );
  }

  /** authenticated && orgId match && conversationId is in the connection's chat subscriptions. */
  matchingChat(orgId: string, conversationId: string): GatewayConnection[] {
    return this.all().filter(
      (conn) => conn.authenticated && conn.orgId === orgId && conn.chatSubscriptions.has(conversationId),
    );
  }

  all(): GatewayConnection[] {
    return [...this.connections.values()];
  }
}

function applyIdentity(conn: GatewayConnection, identity: ConnectionIdentity): void {
  conn.orgId = identity.orgId;
  conn.roles = identity.roles;
  conn.userId = identity.userId;
  conn.token = identity.token;
  conn.authenticated = true;
}

export interface HandleAuthDeps {
  authenticate: (token: string) => Promise<ConnectionIdentity>;
}

const defaultAuthDeps: HandleAuthDeps = { authenticate: authenticateConnectionToken };

/**
 * Verifies `token` and mutates `conn` in place on success. Returns a `ready`
 * reply on success, or `null` on ANY failure — the caller must close the
 * socket with one generic reason, never leaking which check failed
 * (verifySessionToken's uniform-error contract, mirrored here).
 */
export async function handleAuthFrame(
  conn: GatewayConnection,
  token: string,
  deps: Partial<HandleAuthDeps> = {},
): Promise<GatewayToClientMessage | null> {
  const { authenticate } = { ...defaultAuthDeps, ...deps };
  try {
    const identity = await authenticate(token);
    applyIdentity(conn, identity);
    return { type: 'ready' };
  } catch {
    return null;
  }
}

export function handleSubscribe(conn: GatewayConnection, repoId: string): GatewayToClientMessage {
  if (!conn.authenticated) {
    return {
      type: 'error',
      code: 'unauthenticated',
      message: 'Authenticate before subscribing.',
    };
  }
  conn.repoSubscriptions.add(repoId); // Set — duplicate subscribe is idempotent
  return { type: 'subscribed', repoId };
}

/** No-op if `repoId` was never subscribed (Set.delete is idempotent). */
export function handleUnsubscribe(conn: GatewayConnection, repoId: string): void {
  conn.repoSubscriptions.delete(repoId);
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
export const UNAUTHENTICATED_CLOSE_CODE = 4401;

function sendSafe(socket: WebSocket, message: GatewayToClientMessage): void {
  if (socket.readyState !== socket.OPEN) return; // disconnected mid-fan-out -- no-op, never throws
  try {
    socket.send(encodeServerMessage(message));
  } catch {
    // Half-open/backpressured socket -- drop the frame rather than block or crash.
  }
}

// ---------------------------------------------------------------------------
// CH-05 — per-conversation chat subscriptions.
// ---------------------------------------------------------------------------

/** The error code the client sees for ANY rejected/revoked chat subscription. One code for
 *  "not yours" and "does not exist" alike — CH-03's existence-non-disclosure posture. */
export const CHAT_FORBIDDEN_CODE = 'chat_forbidden';
export const CHAT_FORBIDDEN_MESSAGE = 'Conversation not found.';

export interface ChatSubscriptionDeps {
  /** true iff Core confirms this connection's subject currently owns the conversation. */
  authorizeChatSubscription: (conn: GatewayConnection, conversationId: string) => Promise<boolean>;
  acquireChatChannel: (orgId: string, conversationId: string) => Promise<void>;
  releaseChatChannel: (orgId: string, conversationId: string) => Promise<void>;
}

function chatForbiddenReply(): GatewayToClientMessage {
  return { type: 'error', code: CHAT_FORBIDDEN_CODE, message: CHAT_FORBIDDEN_MESSAGE };
}

export async function handleChatSubscribe(
  conn: GatewayConnection,
  conversationId: string,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<GatewayToClientMessage> {
  if (!conn.authenticated) {
    return {
      type: 'error',
      code: 'unauthenticated',
      message: 'Authenticate before subscribing.',
    };
  }

  // Fail closed: a gateway wired without chat deps refuses chat subscriptions
  // rather than accepting them unverified (EC-20).
  if (!deps.authorizeChatSubscription || !deps.acquireChatChannel) {
    return chatForbiddenReply();
  }

  const authorized = await deps.authorizeChatSubscription(conn, conversationId);
  if (!authorized) {
    return chatForbiddenReply();
  }

  // Synchronously mark the subscription BEFORE awaiting the acquire so two
  // racing subscribes for the same conversation acquire exactly once
  // (EC-9/EC-22) rather than both observing an empty set.
  const isNew = !conn.chatSubscriptions.has(conversationId);
  conn.chatSubscriptions.add(conversationId);
  if (isNew) {
    await deps.acquireChatChannel(conn.orgId, conversationId);
  }

  return { type: 'subscribed', channel: 'chat', conversationId };
}

/** Never-subscribed conversationId -> no-op, no Redis release (EC-10). */
export async function handleChatUnsubscribe(
  conn: GatewayConnection,
  conversationId: string,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<void> {
  if (!conn.chatSubscriptions.delete(conversationId)) return;
  await deps.releaseChatChannel?.(conn.orgId, conversationId);
}

/** Releases every chat channel this connection holds and clears the set. Idempotent.
 *  Every release is individually caught-and-logged so one failure cannot strand the others. */
export async function releaseChatSubscriptions(
  conn: GatewayConnection,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<void> {
  const conversationIds = [...conn.chatSubscriptions];
  conn.chatSubscriptions.clear();
  await Promise.all(
    conversationIds.map(async (conversationId) => {
      try {
        await deps.releaseChatChannel?.(conn.orgId, conversationId);
      } catch (err) {
        console.error('[gateway] failed to release chat channel', { connectionId: conn.id, err });
      }
    }),
  );
}

export interface AttachConnectionDeps extends Partial<HandleAuthDeps>, Partial<ChatSubscriptionDeps> {
  isDevOrTest?: () => boolean;
  devIdentity?: () => ConnectionIdentity;
  authTimeoutMs?: number;
}

/**
 * Wires one connection's full lifecycle:
 *  - header-token auth (if the Authorization: Bearer upgrade header was sent), else
 *  - dev/test auto-accept (devConnectionIdentity(), mirrors authenticate.ts), else
 *  - an auth-timeout window waiting for a first `{ type: 'auth' }` frame — closed
 *    with UNAUTHENTICATED_CLOSE_CODE if none arrives in time.
 * Then dispatches every subsequent frame through the auth -> subscribe/unsubscribe
 * state machine. Registers/deregisters `conn` on the given registry.
 */
export function attachConnectionLifecycle(
  conn: GatewayConnection,
  req: IncomingMessage,
  registry: ConnectionRegistry,
  deps: AttachConnectionDeps = {},
): void {
  const isDevOrTest = deps.isDevOrTest ?? isDevOrTestEnvironment;
  const devIdentity = deps.devIdentity ?? devConnectionIdentity;
  const authTimeoutMs = deps.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const { socket } = conn;

  registry.add(conn);

  let authTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAuthTimer = (): void => {
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }
  };

  const headerToken = extractUpgradeToken(req);
  if (headerToken) {
    void handleAuthFrame(conn, headerToken, deps).then((reply) => {
      if (reply) {
        sendSafe(socket, reply);
      } else {
        socket.close(UNAUTHENTICATED_CLOSE_CODE, 'authentication failed');
      }
    });
  } else if (isDevOrTest()) {
    applyIdentity(conn, devIdentity());
    sendSafe(socket, { type: 'ready' });
  } else {
    authTimer = setTimeout(() => {
      if (!conn.authenticated) {
        socket.close(UNAUTHENTICATED_CLOSE_CODE, 'authentication timeout');
      }
    }, authTimeoutMs);
  }

  socket.on('message', (raw: unknown) => {
    void (async () => {
      let message: ClientToGatewayMessage;
      try {
        message = decodeClientMessage(raw);
      } catch (err) {
        if (err instanceof ProtocolError) {
          sendSafe(socket, { type: 'error', code: 'bad_frame', message: 'Malformed or invalid frame.' });
          return;
        }
        throw err;
      }

      if (message.type === 'auth') {
        const reply = await handleAuthFrame(conn, message.token, deps);
        if (reply) {
          clearAuthTimer();
          sendSafe(socket, reply);
        } else {
          socket.close(UNAUTHENTICATED_CLOSE_CODE, 'authentication failed');
        }
        return;
      }

      // Placed before the repo subscribe/unsubscribe branches below so their
      // `message.repoId` accesses stay type-valid on the narrowed union.
      if (isChatChannelMessage(message)) {
        if (message.type === 'subscribe') {
          sendSafe(socket, await handleChatSubscribe(conn, message.conversationId, deps));
        } else {
          await handleChatUnsubscribe(conn, message.conversationId, deps);
        }
        return;
      }

      if (message.type === 'subscribe') {
        sendSafe(socket, handleSubscribe(conn, message.repoId));
        return;
      }

      handleUnsubscribe(conn, message.repoId);
    })();
  });

  socket.on('close', () => {
    clearAuthTimer();
    registry.remove(conn.id);
    void releaseChatSubscriptions(conn, deps);
  });
}

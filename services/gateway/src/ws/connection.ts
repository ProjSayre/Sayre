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
import { decodeClientMessage, encodeServerMessage, ProtocolError } from './protocol';

export interface GatewayConnection {
  id: string;
  socket: WebSocket;
  orgId: string; // derived at connect from verifySessionToken -- the coarse tenant gate
  roles: OrgRole[]; // from the verified token
  userId: string;
  token: string; // forwarded per push; MUST NOT be logged
  repoSubscriptions: Set<string>;
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

export interface AttachConnectionDeps extends Partial<HandleAuthDeps> {
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
  });
}

// Per-push, per-client RBAC-delegating fan-out. Called once per accepted
// `graph.updated` envelope (after Redis pub/sub delivers it to this gateway
// instance). Selects the connections that coarsely match (org + repo
// subscription), then calls Core's internal endpoint for EACH matching
// connection on EVERY event — never trusting a subscribe-time check for later
// pushes (.claude/rules/security-multitenancy.md, AC3).
//
// W2-03 O-3 (removal / existence-leak boundary): this module deliberately
// NEVER relays itemized `removals` from Core's delta to a client. Whenever the
// delta reports ANY removals (or a full rebuild), the client receives a
// generic `graph.resync` instead and re-fetches the tree over the fully
// authorized REST read path. This is the conservative MVP choice: computing
// "was this now-deleted node ever authorized for this context" is real
// Graph-Query-Service/W2-02 territory (pre-deletion ACL), so until that lands,
// relaying itemized removals risks leaking the existence of a node a client
// was never authorized to see. `graph.delta`'s `removals` field always ships
// empty on the wire for that reason — the field stays in the contract for
// forward-compatibility once W2-02 supplies real authorized-removal data.

import type { GatewayToClientMessage, GraphUpdatedPayload } from '@sayre/shared-types';
import type { MessageEnvelope } from '@sayre/core';
import type { GatewayConnection, ConnectionRegistry } from '../ws/connection';
import { encodeServerMessage } from '../ws/protocol';
import { CoreUnauthorizedError, CoreUnavailableError, fetchAuthorizedDelta } from '../coreClient';

export interface FanOutDeps {
  fetchDelta: typeof fetchAuthorizedDelta;
  coreBaseUrl: string;
  onUnauthorized: (conn: GatewayConnection) => void; // close the connection, force re-auth
  maxConcurrency?: number; // bound Core calls (default 16)
}

const DEFAULT_MAX_CONCURRENCY = 16;

function sendSafe(conn: GatewayConnection, message: GatewayToClientMessage): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return; // disconnected mid-fan-out -- no-op
  try {
    conn.socket.send(encodeServerMessage(message));
  } catch (err) {
    console.error('[gateway] failed to send frame to client; dropping (socket likely closing)', err);
  }
}

async function pushToConnection(
  conn: GatewayConnection,
  envelope: MessageEnvelope<GraphUpdatedPayload>,
  deps: FanOutDeps,
): Promise<void> {
  const { payload } = envelope;
  try {
    const delta = await deps.fetchDelta({
      baseUrl: deps.coreBaseUrl,
      token: conn.token,
      repoId: payload.repository_id,
      change: {
        changedPaths: payload.changed_paths,
        fullRebuild: payload.full_rebuild,
        graphVersion: envelope.graph_version ?? 0,
      },
    });

    // O-3: any removal (or a full rebuild) forces a resync, never itemized removals.
    if (delta.resyncRequired || delta.removals.length > 0) {
      sendSafe(conn, { type: 'graph.resync', repoId: delta.repoId, graphVersion: delta.graphVersion });
      return;
    }

    if (delta.upserts.length === 0) return; // nothing authorized changed for this ctx -- send nothing

    sendSafe(conn, {
      type: 'graph.delta',
      repoId: delta.repoId,
      graphVersion: delta.graphVersion,
      upserts: delta.upserts,
      removals: [], // never populated -- see module header (O-3)
    });
  } catch (err) {
    if (err instanceof CoreUnauthorizedError) {
      deps.onUnauthorized(conn);
      return;
    }
    if (err instanceof CoreUnavailableError) {
      console.error('[gateway] Core delta fetch unavailable; skipping this push', {
        repoId: payload.repository_id,
        connectionId: conn.id,
      });
      return;
    }
    throw err;
  }
}

/**
 * Selects `registry.matching(envelope.org_id, envelope.payload.repository_id)`
 * and pushes to each, bounded by `deps.maxConcurrency` concurrent Core calls so
 * one slow Core response never stalls the whole fan-out.
 */
export async function fanOutGraphUpdated(
  envelope: MessageEnvelope<GraphUpdatedPayload>,
  registry: ConnectionRegistry,
  deps: FanOutDeps,
): Promise<void> {
  const connections = registry.matching(envelope.org_id, envelope.payload.repository_id);
  if (connections.length === 0) return;

  const maxConcurrency = deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const workerCount = Math.min(maxConcurrency, connections.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < connections.length) {
      const conn = connections[nextIndex];
      nextIndex += 1;
      await pushToConnection(conn, envelope, deps);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

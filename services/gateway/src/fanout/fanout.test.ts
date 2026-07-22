import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { GraphUpdatedPayload, RealtimeGraphDelta } from '@sayre/shared-types';
import type { MessageEnvelope } from '@sayre/core';
import { fanOutGraphUpdated } from './fanout';
import { ConnectionRegistry, createPendingConnection, type GatewayConnection } from '../ws/connection';
import { CoreUnauthorizedError, CoreUnavailableError } from '../coreClient';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

function authedConnection(id: string, orgId: string, repoId: string, token = `tok-${id}`): GatewayConnection {
  const conn = createPendingConnection(id, new FakeSocket() as unknown as WebSocket);
  conn.authenticated = true;
  conn.orgId = orgId;
  conn.token = token;
  conn.repoSubscriptions.add(repoId);
  return conn;
}

function envelope(overrides: Partial<GraphUpdatedPayload> = {}, orgId = 'org-a'): MessageEnvelope<GraphUpdatedPayload> {
  return {
    message_id: 'm1',
    idempotency_key: 'm1',
    org_id: orgId,
    type: 'graph.updated',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    source: 'ingestion-worker',
    graph_scope_key: 'repo-1:main',
    graph_version: 5,
    payload: {
      repository_id: 'repo-1',
      ref_name: 'refs/heads/main',
      revision_sha: 'abc123',
      full_rebuild: false,
      changed_paths: ['/src/index.ts'],
      structural_duration_ms: 1200,
      ...overrides,
    },
  };
}

function deltaOf(overrides: Partial<RealtimeGraphDelta> = {}): RealtimeGraphDelta {
  return {
    repoId: 'repo-1',
    graphVersion: 5,
    upserts: [],
    removals: [],
    resyncRequired: false,
    ...overrides,
  };
}

describe('fanOutGraphUpdated', () => {
  it('AC1: pushes exactly one graph.delta to a matching, subscribed connection with only the changed-path nodes', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);

    const fetchDelta = vi.fn(async () =>
      deltaOf({ upserts: [{ id: 'n1', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: null }] }),
    );

    await fanOutGraphUpdated(envelope(), registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized: vi.fn(),
    });

    expect((conn.socket as unknown as FakeSocket).sent).toEqual([
      {
        type: 'graph.delta',
        repoId: 'repo-1',
        graphVersion: 5,
        upserts: [{ id: 'n1', label: 'File', name: 'index.ts', path: '/src/index.ts', parentId: null }],
        removals: [],
      },
    ]);
  });

  it('AC2: an event for org A never reaches a connection subscribed under org B, even to the same repo', async () => {
    const registry = new ConnectionRegistry();
    const connA = authedConnection('a', 'org-a', 'repo-1');
    const connB = authedConnection('b', 'org-b', 'repo-1');
    registry.add(connA);
    registry.add(connB);

    const fetchDelta = vi.fn(async () => deltaOf({ upserts: [{ id: 'n1', label: 'File', name: 'x', path: '/x', parentId: null }] }));

    await fanOutGraphUpdated(envelope({}, 'org-a'), registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized: vi.fn(),
    });

    expect((connA.socket as unknown as FakeSocket).sent).toHaveLength(1);
    expect((connB.socket as unknown as FakeSocket).sent).toHaveLength(0);
    expect(fetchDelta).toHaveBeenCalledTimes(1);
  });

  it('AC3: calls the Core authority once per matching connection per event, and closes on CoreUnauthorizedError', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);
    const onUnauthorized = vi.fn();

    const fetchDelta = vi.fn(async () => {
      throw new CoreUnauthorizedError();
    });

    await fanOutGraphUpdated(envelope(), registry, {
      fetchDelta,
      coreBaseUrl: 'http://core.internal:4000',
      onUnauthorized,
    });

    expect(fetchDelta).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(conn);
    expect((conn.socket as unknown as FakeSocket).sent).toHaveLength(0);
  });

  it('CoreUnavailableError skips that push without throwing and without sending unfiltered data', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);

    const fetchDelta = vi.fn(async () => {
      throw new CoreUnavailableError();
    });

    await expect(
      fanOutGraphUpdated(envelope(), registry, { fetchDelta, coreBaseUrl: 'x', onUnauthorized: vi.fn() }),
    ).resolves.toBeUndefined();
    expect((conn.socket as unknown as FakeSocket).sent).toHaveLength(0);
  });

  it('AC6: full_rebuild delta (resyncRequired) sends graph.resync only', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);

    const fetchDelta = vi.fn(async () => deltaOf({ resyncRequired: true }));

    await fanOutGraphUpdated(envelope({ full_rebuild: true }), registry, {
      fetchDelta,
      coreBaseUrl: 'x',
      onUnauthorized: vi.fn(),
    });

    expect((conn.socket as unknown as FakeSocket).sent).toEqual([
      { type: 'graph.resync', repoId: 'repo-1', graphVersion: 5 },
    ]);
  });

  it('O-3: a delta with removals never relays itemized removals — sends graph.resync instead', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);

    const fetchDelta = vi.fn(async () =>
      deltaOf({
        upserts: [{ id: 'n1', label: 'File', name: 'x', path: '/x', parentId: null }],
        removals: ['node-that-was-deleted'],
      }),
    );

    await fanOutGraphUpdated(envelope(), registry, { fetchDelta, coreBaseUrl: 'x', onUnauthorized: vi.fn() });

    const sent = (conn.socket as unknown as FakeSocket).sent;
    expect(sent).toEqual([{ type: 'graph.resync', repoId: 'repo-1', graphVersion: 5 }]);
    for (const message of sent) {
      expect(JSON.stringify(message)).not.toContain('node-that-was-deleted');
    }
  });

  it('empty upserts and empty removals sends nothing (changed_paths=[] edge case)', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    registry.add(conn);

    const fetchDelta = vi.fn(async () => deltaOf());

    await fanOutGraphUpdated(envelope({ changed_paths: [] }), registry, {
      fetchDelta,
      coreBaseUrl: 'x',
      onUnauthorized: vi.fn(),
    });

    expect((conn.socket as unknown as FakeSocket).sent).toHaveLength(0);
  });

  it('a subscription for a different repo (same org) receives nothing', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-OTHER');
    registry.add(conn);
    const fetchDelta = vi.fn(async () => deltaOf());

    await fanOutGraphUpdated(envelope(), registry, { fetchDelta, coreBaseUrl: 'x', onUnauthorized: vi.fn() });

    expect(fetchDelta).not.toHaveBeenCalled();
    expect((conn.socket as unknown as FakeSocket).sent).toHaveLength(0);
  });

  it('no matching connections short-circuits without calling fetchDelta', async () => {
    const registry = new ConnectionRegistry();
    const fetchDelta = vi.fn(async () => deltaOf());

    await fanOutGraphUpdated(envelope(), registry, { fetchDelta, coreBaseUrl: 'x', onUnauthorized: vi.fn() });

    expect(fetchDelta).not.toHaveBeenCalled();
  });

  it('bounds concurrent Core calls by maxConcurrency', async () => {
    const registry = new ConnectionRegistry();
    for (let i = 0; i < 10; i += 1) {
      registry.add(authedConnection(`c${i}`, 'org-a', 'repo-1'));
    }

    let inFlight = 0;
    let maxObservedInFlight = 0;
    const fetchDelta = vi.fn(async () => {
      inFlight += 1;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return deltaOf();
    });

    await fanOutGraphUpdated(envelope(), registry, {
      fetchDelta,
      coreBaseUrl: 'x',
      onUnauthorized: vi.fn(),
      maxConcurrency: 3,
    });

    expect(fetchDelta).toHaveBeenCalledTimes(10);
    expect(maxObservedInFlight).toBeLessThanOrEqual(3);
  });

  it('a disconnected socket mid-fan-out is a safe no-op, not a crash', async () => {
    const registry = new ConnectionRegistry();
    const conn = authedConnection('c1', 'org-a', 'repo-1');
    (conn.socket as unknown as FakeSocket).readyState = 3; // CLOSED
    registry.add(conn);

    const fetchDelta = vi.fn(async () =>
      deltaOf({ upserts: [{ id: 'n1', label: 'File', name: 'x', path: '/x', parentId: null }] }),
    );

    await expect(
      fanOutGraphUpdated(envelope(), registry, { fetchDelta, coreBaseUrl: 'x', onUnauthorized: vi.fn() }),
    ).resolves.toBeUndefined();
    expect((conn.socket as unknown as FakeSocket).sent).toHaveLength(0);
  });
});

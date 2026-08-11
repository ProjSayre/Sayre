import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoreForbiddenError,
  CoreUnauthorizedError,
  CoreUnavailableError,
  fetchAuthorizedDelta,
  fetchChatPushAuthorization,
} from './coreClient';

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchAuthorizedDelta', () => {
  it('happy path: POSTs to /internal/realtime/graph-delta with a Bearer token and repoId/changedPaths/fullRebuild/graphVersion only (never org_id)', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, {
        repoId: 'repo-1',
        graphVersion: 3,
        upserts: [],
        removals: [],
        resyncRequired: false,
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const delta = await fetchAuthorizedDelta({
      baseUrl: 'http://core.internal:4000',
      token: 'tok-1',
      repoId: 'repo-1',
      change: { changedPaths: ['/a'], fullRebuild: false, graphVersion: 3 },
    });

    expect(delta.repoId).toBe('repo-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core.internal:4000/internal/realtime/graph-delta');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      repoId: 'repo-1',
      changedPaths: ['/a'],
      fullRebuild: false,
      graphVersion: 3,
    });
    expect(sentBody.org_id).toBeUndefined();
    expect(sentBody.orgId).toBeUndefined();
  });

  it('omits the Authorization header entirely when token is empty (dev/test fallback identity)', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { repoId: 'r', graphVersion: 0, upserts: [], removals: [], resyncRequired: false }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchAuthorizedDelta({
      baseUrl: 'http://core.internal:4000',
      token: '',
      repoId: 'repo-1',
      change: { changedPaths: [], fullRebuild: false, graphVersion: 0 },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('maps a 401 response to CoreUnauthorizedError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })) as unknown as typeof fetch;

    await expect(
      fetchAuthorizedDelta({
        baseUrl: 'http://core.internal:4000',
        token: 'expired',
        repoId: 'repo-1',
        change: { changedPaths: [], fullRebuild: false, graphVersion: 0 },
      }),
    ).rejects.toBeInstanceOf(CoreUnauthorizedError);
  });

  it('maps a non-2xx-non-401 response to CoreUnavailableError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;

    await expect(
      fetchAuthorizedDelta({
        baseUrl: 'http://core.internal:4000',
        token: 'tok-1',
        repoId: 'repo-1',
        change: { changedPaths: [], fullRebuild: false, graphVersion: 0 },
      }),
    ).rejects.toBeInstanceOf(CoreUnavailableError);
  });

  it('maps a network error (connection refused) to CoreUnavailableError, never logging the token', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      fetchAuthorizedDelta({
        baseUrl: 'http://core.internal:4000',
        token: 'secret-token',
        repoId: 'repo-1',
        change: { changedPaths: [], fullRebuild: false, graphVersion: 0 },
      }),
    ).rejects.toBeInstanceOf(CoreUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// CH-05 — the internal chat-authorization call. Authored by `red` from
// .pipeline/spec.md before any implementation exists. Every case above this
// line predates CH-05 and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

describe('fetchChatPushAuthorization', () => {
  // @spec AC-8
  it('AC-8: POSTs to /internal/realtime/chat-authorization with a Bearer token and a body of EXACTLY { conversationId, nodeIds }', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { conversationId: CONVERSATION_ID, authorizedNodeIds: ['n1'] }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const authorization = await fetchChatPushAuthorization({
      baseUrl: 'http://core.internal:4000',
      token: 'tok-1',
      conversationId: CONVERSATION_ID,
      nodeIds: ['n1', 'n2'],
    });

    expect(authorization).toEqual({ conversationId: CONVERSATION_ID, authorizedNodeIds: ['n1'] });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://core.internal:4000/internal/realtime/chat-authorization');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody).toEqual({ conversationId: CONVERSATION_ID, nodeIds: ['n1', 'n2'] });
    expect(Object.keys(sentBody).sort()).toEqual(['conversationId', 'nodeIds']);
    expect(sentBody.org_id).toBeUndefined();
    expect(sentBody.orgId).toBeUndefined();
    expect(sentBody.userId).toBeUndefined();
    expect(sentBody.token).toBeUndefined();
    expect(init.body as string).not.toContain('tok-1');
  });

  // @spec EC-28
  it('EC-28: an empty nodeIds list is still POSTed — Core is asked for the ownership half of the re-filter', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { conversationId: CONVERSATION_ID, authorizedNodeIds: [] }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const authorization = await fetchChatPushAuthorization({
      baseUrl: 'http://core.internal:4000',
      token: 'tok-1',
      conversationId: CONVERSATION_ID,
      nodeIds: [],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      conversationId: CONVERSATION_ID,
      nodeIds: [],
    });
    expect(authorization.authorizedNodeIds).toEqual([]);
  });

  // @spec AC-8
  it('AC-8: omits the Authorization header entirely when the token is empty (dev/test fallback identity)', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { conversationId: CONVERSATION_ID, authorizedNodeIds: [] }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchChatPushAuthorization({
      baseUrl: 'http://core.internal:4000',
      token: '',
      conversationId: CONVERSATION_ID,
      nodeIds: [],
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  // @spec EC-13
  it('EC-13: maps a 401 response to CoreUnauthorizedError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })) as unknown as typeof fetch;

    await expect(
      fetchChatPushAuthorization({
        baseUrl: 'http://core.internal:4000',
        token: 'expired',
        conversationId: CONVERSATION_ID,
        nodeIds: [],
      }),
    ).rejects.toBeInstanceOf(CoreUnauthorizedError);
  });

  // @spec EC-14
  it('EC-14: maps BOTH 403 and 404 to the same CoreForbiddenError — absent is never distinguished from unowned', async () => {
    for (const status of [403, 404]) {
      globalThis.fetch = vi.fn(async () => jsonResponse(status, { error: 'nope' })) as unknown as typeof fetch;

      await expect(
        fetchChatPushAuthorization({
          baseUrl: 'http://core.internal:4000',
          token: 'tok-1',
          conversationId: CONVERSATION_ID,
          nodeIds: [],
        }),
      ).rejects.toBeInstanceOf(CoreForbiddenError);
    }
  });

  // @spec EC-12
  it('EC-12: maps a 500 (and any other non-2xx) to CoreUnavailableError', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;

    await expect(
      fetchChatPushAuthorization({
        baseUrl: 'http://core.internal:4000',
        token: 'tok-1',
        conversationId: CONVERSATION_ID,
        nodeIds: ['n1'],
      }),
    ).rejects.toBeInstanceOf(CoreUnavailableError);
  });

  // @spec EC-12
  it('EC-12: maps a network error to CoreUnavailableError and never puts the bearer token in the error or a log', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const rejection = await fetchChatPushAuthorization({
      baseUrl: 'http://core.internal:4000',
      token: 'tok-super-secret-value',
      conversationId: CONVERSATION_ID,
      nodeIds: ['n1'],
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CoreUnavailableError);
    expect(String((rejection as Error).message)).not.toContain('tok-super-secret-value');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('tok-super-secret-value');
  });
});

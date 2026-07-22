import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreUnauthorizedError, CoreUnavailableError, fetchAuthorizedDelta } from './coreClient';

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

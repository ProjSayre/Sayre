import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const REPO_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('provider-state same-origin route', () => {
  it('forwards only scope fields and inbound bearer auth to Core', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            repositoryId: REPO_ID,
            refName: 'refs/heads/main',
            revisionSha: 'a'.repeat(40),
            surface: 'product',
            status: 'degraded',
            reasonCode: 'timeout',
            updatedAt: '2026-07-22T04:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      `http://web.local/api/provider-state/${REPO_ID}?refName=refs%2Fheads%2Fmain&surface=product&orgId=attacker`,
      { headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await GET(request, { params: { repoId: REPO_ID } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'degraded' });
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      `http://core.internal:4000/repos/${REPO_ID}/provider-state?refName=refs%2Fheads%2Fmain&surface=product`,
    );
    expect(init?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer signed-session',
    });
    expect(String(target)).not.toContain('attacker');
  });

  it('rejects malformed scope before making an upstream request', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/provider-state/not-a-uuid?refName=main&surface=unknown',
    );

    const response = await GET(request, { params: { repoId: 'not-a-uuid' } });

    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns a sanitized 502 when Core is unavailable or returns malformed JSON', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    for (const upstream of [
      vi.fn(async () => {
        throw new Error('private endpoint failed');
      }),
      vi.fn(async () => new Response('not-json', { status: 500 })),
    ]) {
      vi.stubGlobal('fetch', upstream);
      const request = new NextRequest(
        `http://web.local/api/provider-state/${REPO_ID}?refName=refs%2Fheads%2Fmain&surface=product`,
      );
      const response = await GET(request, { params: { repoId: REPO_ID } });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'provider state unavailable' });
    }
  });
});

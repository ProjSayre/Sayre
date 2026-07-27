import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('allowlisted Core browser-for-frontend route', () => {
  it('forwards a stored bearer session while dropping unknown query fields', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        Response.json({
          authorization: 'server-filtered',
          repositories: [],
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/repositories?orgId=attacker',
      { headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await GET(request, { params: { path: ['repositories'] } });

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/repositories');
    expect(requestHeaders(init).get('authorization')).toBe(
      'Bearer signed-session',
    );
    expect(String(target)).not.toContain('attacker');
  });

  it('forwards only the admin GitHub status read contract', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        Response.json({
          authorization: 'server-filtered',
          installations: [],
          repositories: [],
          updatedAt: '2026-07-26T16:00:00.000Z',
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/integrations/github/status?orgId=attacker',
      { headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await GET(request, {
      params: { path: ['integrations', 'github', 'status'] },
    });

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      'http://core.internal:4000/integrations/github/status',
    );
    expect(requestHeaders(init).get('authorization')).toBe(
      'Bearer signed-session',
    );
    expect(String(target)).not.toContain('attacker');
  });

  it('follows only the public GitHub login redirect contract', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/login/oauth/authorize' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/auth/github/login?redirect_to=%2Fproduct&org_id=attacker',
    );

    const response = await GET(request, {
      params: { path: ['auth', 'github', 'login'] },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://github.com/login/oauth/authorize',
    );
    const [target] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      'http://core.internal:4000/auth/github/login?redirect_to=%2Fproduct',
    );
  });

  it('forwards an onboarding execution without accepting tenant input', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        Response.json({
          sandbox: 'container',
          status: 'succeeded',
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/repos/repo%201/onboarding-steps/step%2F1/execute?ref=refs%2Fheads%2Fmain&org_id=attacker',
      {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session' },
      },
    );

    const response = await POST(request, {
      params: {
        path: [
          'repos',
          'repo 1',
          'onboarding-steps',
          'step/1',
          'execute',
        ],
      },
    });

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(
      'http://core.internal:4000/repos/repo%201/onboarding-steps/step%2F1/execute?ref=refs%2Fheads%2Fmain',
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(requestHeaders(init).get('authorization')).toBe(
      'Bearer signed-session',
    );
  });

  it('rejects routes outside the explicit browser contract', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/internal/realtime/graph-delta',
    );

    const response = await POST(request, {
      params: { path: ['internal', 'realtime', 'graph-delta'] },
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

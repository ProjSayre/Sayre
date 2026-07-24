import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DELETE,
  GET,
  POST,
  PUT,
} from './[[...path]]/route';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('MCP settings web adapter', () => {
  it('forwards only the bearer credential and maps the closed route set', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000/');
    const upstream = vi.fn(async () =>
      Response.json({ keys: [], rateLimitPerMinute: 60 }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest('http://web.local/api/mcp-settings', {
      headers: {
        authorization: 'Bearer signed-session',
        cookie: 'forged=value',
        'x-org-id': 'forged-org',
      },
    });

    const response = await GET(request, { params: {} });

    expect(response.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(url).toBe('http://core.internal:4000/settings/mcp');
    expect(headers.get('authorization')).toBe('Bearer signed-session');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-org-id')).toBeNull();
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
  });

  it('proxies issue, revoke, and rate-policy requests to exact endpoints', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', upstream);
    const keyId = '11111111-1111-4111-8111-111111111111';

    await POST(
      new NextRequest('http://web.local/api/mcp-settings/keys', {
        method: 'POST',
        body: '{}',
      }),
      { params: { path: ['keys'] } },
    );
    await PUT(
      new NextRequest('http://web.local/api/mcp-settings/rate-limit', {
        method: 'PUT',
        body: '{}',
      }),
      { params: { path: ['rate-limit'] } },
    );
    await DELETE(
      new NextRequest(`http://web.local/api/mcp-settings/keys/${keyId}`, {
        method: 'DELETE',
      }),
      { params: { path: ['keys', keyId] } },
    );

    const calls = upstream.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls.map(([url]) => url)).toEqual([
      'http://core.internal:4000/settings/mcp/keys',
      'http://core.internal:4000/settings/mcp/rate-limit',
      `http://core.internal:4000/settings/mcp/keys/${keyId}`,
    ]);
    expect(
      calls.map(([, init]) => init.method),
    ).toEqual(['POST', 'PUT', 'DELETE']);
  });

  it('rejects unknown paths and oversized issue bodies without upstream I/O', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    const unknown = await POST(
      new NextRequest('http://web.local/api/mcp-settings/nope', {
        method: 'POST',
        body: '{}',
      }),
      { params: { path: ['nope'] } },
    );
    const oversized = await POST(
      new NextRequest('http://web.local/api/mcp-settings/keys', {
        method: 'POST',
        body: 'x'.repeat(32_769),
      }),
      { params: { path: ['keys'] } },
    );

    expect(unknown.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });
});

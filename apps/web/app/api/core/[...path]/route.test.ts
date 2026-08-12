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

  it('follows only the admin Jira connect redirect contract', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://auth.atlassian.com/authorize?client_id=x' },
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/integrations/jira/connect?org_id=attacker',
      { headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await GET(request, {
      params: { path: ['integrations', 'jira', 'connect'] },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://auth.atlassian.com/authorize?client_id=x',
    );
    const [target] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/integrations/jira/connect');
  });

  it('forwards only the admin Jira status read contract', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        Response.json({
          authorization: 'server-filtered',
          connection: null,
          updatedAt: '2026-07-27T00:00:00.000Z',
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/integrations/jira/status?orgId=attacker',
      { headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await GET(request, {
      params: { path: ['integrations', 'jira', 'status'] },
    });

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/integrations/jira/status');
    expect(requestHeaders(init).get('authorization')).toBe('Bearer signed-session');
    expect(String(target)).not.toContain('attacker');
  });

  it('forwards only the admin Jira disconnect contract', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () =>
        Response.json({
          authorization: 'server-filtered',
          connection: null,
          updatedAt: '2026-07-27T00:00:00.000Z',
        }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/integrations/jira/disconnect?org_id=attacker',
      { method: 'POST', headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await POST(request, {
      params: { path: ['integrations', 'jira', 'disconnect'] },
    });

    expect(response.status).toBe(200);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/integrations/jira/disconnect');
    expect(init?.method).toBe('POST');
    expect(requestHeaders(init).get('authorization')).toBe('Bearer signed-session');
    expect(String(target)).not.toContain('attacker');
  });

  // CH-03 — the four "Ask Sayre" chat routes (authored by `red` from spec.md).

  // @spec AC-13
  it('forwards a chat conversation creation with its POST body byte-identical', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () => Response.json({ conversation: { id: 'c1' } }, { status: 201 }),
    );
    vi.stubGlobal('fetch', upstream);
    const payload = JSON.stringify({ title: 'Auth spelunking' });
    const request = new NextRequest(
      'http://web.local/api/core/chat/conversations?orgId=attacker',
      {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session', 'content-type': 'application/json' },
        body: payload,
      },
    );

    const response = await POST(request, { params: { path: ['chat', 'conversations'] } });

    expect(response.status).toBe(201);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/chat/conversations');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(payload);
    expect(requestHeaders(init).get('content-type')).toBe('application/json');
    expect(requestHeaders(init).get('authorization')).toBe('Bearer signed-session');
    expect(String(target)).not.toContain('attacker');
  });

  // @spec AC-13
  it('forwards a chat turn POST body byte-identical to the conversation turns path', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(
      async () => Response.json({ conversationId: 'c 1' }, { status: 202 }),
    );
    vi.stubGlobal('fetch', upstream);
    const payload = JSON.stringify({
      idempotencyKey: 'client-turn-0001',
      question: 'How does login work?',
      scope: { view: 'technical', anchorNodeId: 'file-42' },
    });
    const request = new NextRequest(
      'http://web.local/api/core/chat/conversations/c%201/turns?org_id=attacker',
      {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session', 'content-type': 'application/json' },
        body: payload,
      },
    );

    const response = await POST(request, {
      params: { path: ['chat', 'conversations', 'c 1', 'turns'] },
    });

    expect(response.status).toBe(202);
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe('http://core.internal:4000/chat/conversations/c%201/turns');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(payload);
    expect(String(target)).not.toContain('attacker');
  });

  // @spec AC-13
  it('forwards only `limit` when listing conversations, and no query at all when reading one', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ conversations: [] }));
    vi.stubGlobal('fetch', upstream);

    const listResponse = await GET(
      new NextRequest('http://web.local/api/core/chat/conversations?limit=25&orgId=attacker&userId=attacker', {
        headers: { authorization: 'Bearer signed-session' },
      }),
      { params: { path: ['chat', 'conversations'] } },
    );
    expect(listResponse.status).toBe(200);
    expect(String(upstream.mock.calls[0]![0])).toBe(
      'http://core.internal:4000/chat/conversations?limit=25',
    );

    await GET(
      new NextRequest('http://web.local/api/core/chat/conversations/c%201?limit=25', {
        headers: { authorization: 'Bearer signed-session' },
      }),
      { params: { path: ['chat', 'conversations', 'c 1'] } },
    );
    expect(String(upstream.mock.calls[1]![0])).toBe(
      'http://core.internal:4000/chat/conversations/c%201',
    );
  });

  // @spec AC-13
  it('still forwards a bodyless POST without inventing a body or a content-type', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ connection: null }));
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/core/integrations/jira/disconnect',
      { method: 'POST', headers: { authorization: 'Bearer signed-session' } },
    );

    const response = await POST(request, {
      params: { path: ['integrations', 'jira', 'disconnect'] },
    });

    expect(response.status).toBe(200);
    const [, init] = upstream.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(requestHeaders(init).get('content-type')).toBeNull();

    // Same rule on the new chat lane: nothing sent, nothing forwarded.
    await POST(
      new NextRequest('http://web.local/api/core/chat/conversations', {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session' },
      }),
      { params: { path: ['chat', 'conversations'] } },
    );
    const [, chatInit] = upstream.mock.calls[1]!;
    expect(chatInit?.body).toBeUndefined();
    expect(requestHeaders(chatInit).get('content-type')).toBeNull();
  });

  // @spec EC-22
  it('404s an unrecognised chat sub-path without reaching core, while the real turns path is routed', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ conversationId: 'x' }));
    vi.stubGlobal('fetch', upstream);

    const unrecognised = await POST(
      new NextRequest('http://web.local/api/core/chat/conversations/x/turns/y', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: { path: ['chat', 'conversations', 'x', 'turns', 'y'] } },
    );

    expect(unrecognised.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();

    // Positive control: the allowlist is narrow, not absent.
    await POST(
      new NextRequest('http://web.local/api/core/chat/conversations/x/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: { path: ['chat', 'conversations', 'x', 'turns'] } },
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  // @spec EC-22
  it('413s a chat POST body over the 64 KB bound without reaching core', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const oversized = JSON.stringify({
      idempotencyKey: 'client-turn-0001',
      question: 'q'.repeat(64 * 1024 + 1),
    });
    const request = new NextRequest(
      'http://web.local/api/core/chat/conversations/c1/turns',
      {
        method: 'POST',
        headers: { authorization: 'Bearer signed-session', 'content-type': 'application/json' },
        body: oversized,
      },
    );

    const response = await POST(request, {
      params: { path: ['chat', 'conversations', 'c1', 'turns'] },
    });

    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
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

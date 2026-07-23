import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT } from './[[...purpose]]/route';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('provider settings web adapter', () => {
  it('forwards only the verified bearer header and cannot forge tenant scope', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    const upstream = vi.fn(async () =>
      Response.json({
        settings: { generation: null, embedding: null },
        credentialOptions: [],
        endpointOptions: [],
        tradeoffs: {},
      }),
    );
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest('http://web.local/api/provider-settings', {
      headers: {
        authorization: 'Bearer signed-session',
        cookie: 'unrelated=value',
        'x-org-id': 'forged-org',
        'x-roles': 'owner',
      },
    });

    const response = await GET(request, { params: {} });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(url).toBe('http://core.internal:4000/settings/model-providers');
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
    expect(headers.get('authorization')).toBe('Bearer signed-session');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-org-id')).toBeNull();
    expect(headers.get('x-roles')).toBeNull();
  });

  it('shapes a bounded PUT and applies the fixed timeout and JSON-only headers', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000/');
    const timeoutSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutSignal);
    const upstream = vi.fn(async () =>
      Response.json({
        purpose: 'embedding',
        provider: 'openai_compatible',
        model: 'local-model',
      }),
    );
    vi.stubGlobal('fetch', upstream);
    const body = JSON.stringify({
      provider: 'openai_compatible',
      model: 'local-model',
      credentialReferenceId: null,
      endpointId: 'approved-endpoint',
    });
    const request = new NextRequest(
      'http://web.local/api/provider-settings/embedding',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer signed-session',
          cookie: 'scope=forged',
          'content-type': 'text/plain',
          'x-org-id': 'forged-org',
        },
        body,
      },
    );

    const response = await PUT(request, {
      params: { purpose: ['embedding'] },
    });

    expect(response.status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(5_000);
    const [url, init] = upstream.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(url).toBe(
      'http://core.internal:4000/settings/model-providers/embedding',
    );
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(body);
    expect(init.signal).toBe(timeoutSignal);
    expect(init.redirect).toBe('manual');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer signed-session');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-org-id')).toBeNull();
  });

  it('rejects an oversized update before making an upstream request', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const request = new NextRequest(
      'http://web.local/api/provider-settings/generation',
      {
        method: 'PUT',
        body: 'x'.repeat(16_385),
      },
    );

    const response = await PUT(request, {
      params: { purpose: ['generation'] },
    });

    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'Request too large.' });
  });

  it('rejects an oversized upstream body with a fixed response', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    let cancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_145));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(oversizedBody)),
    );

    const response = await GET(
      new NextRequest('http://web.local/api/provider-settings'),
      { params: {} },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Provider settings service unavailable.',
    });
    expect(cancelled).toBe(true);
  });

  it('returns fixed errors for invalid paths and upstream failures', async () => {
    vi.stubEnv('CORE_INTERNAL_BASE_URL', 'http://core.internal:4000');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sensitive internal upstream detail');
      }),
    );
    const request = new NextRequest(
      'http://web.local/api/provider-settings/generation',
      { method: 'PUT', body: '{}' },
    );

    const invalidPath = await PUT(request, { params: {} });
    const unavailable = await PUT(
      new NextRequest('http://web.local/api/provider-settings/generation', {
        method: 'PUT',
        body: '{}',
      }),
      { params: { purpose: ['generation'] } },
    );

    expect(invalidPath.status).toBe(404);
    expect(await invalidPath.json()).toEqual({ error: 'Not found.' });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({
      error: 'Provider settings service unavailable.',
    });
  });
});

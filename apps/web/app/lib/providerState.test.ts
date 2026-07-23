import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderState, type ProviderStateSelection } from './providerState';

const SELECTION: ProviderStateSelection = {
  repositoryId: '22222222-2222-4222-8222-222222222222',
  refName: 'refs/heads/main',
  surface: 'product',
};

const DEGRADED = {
  repositoryId: SELECTION.repositoryId,
  refName: SELECTION.refName,
  revisionSha: 'a'.repeat(40),
  surface: 'product',
  status: 'degraded',
  reasonCode: 'timeout',
  updatedAt: '2026-07-22T04:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchProviderState', () => {
  it('encodes only the selected repo/ref/surface and accepts the closed response', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(DEGRADED), { status: 200 }),
    );
    const controller = new AbortController();

    await expect(
      fetchProviderState(SELECTION, controller.signal, fetcher),
    ).resolves.toEqual(DEGRADED);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      '/api/provider-state/22222222-2222-4222-8222-222222222222?refName=refs%2Fheads%2Fmain&surface=product',
    );
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    expect(String(url)).not.toMatch(/orgId|endpoint|prompt|model/);
  });

  it('fails closed on auth/server responses and malformed or expanded payloads', async () => {
    const controller = new AbortController();
    for (const response of [
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
      new Response(JSON.stringify({ ...DEGRADED, rawError: 'private provider text' }), {
        status: 200,
      }),
      new Response(JSON.stringify({ ...DEGRADED, reasonCode: 'private provider text' }), {
        status: 200,
      }),
      new Response(JSON.stringify({ ...DEGRADED, repositoryId: 'other' }), { status: 200 }),
    ]) {
      await expect(
        fetchProviderState(
          SELECTION,
          controller.signal,
          vi.fn(async () => response),
        ),
      ).resolves.toBeNull();
    }
  });
});

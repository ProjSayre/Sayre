import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderStateBanner,
  ProviderStateStatus,
} from './ProviderStateBanner';
import type { ProviderStateSelection } from '../lib/providerState';

const SELECTION: ProviderStateSelection = {
  repositoryId: '22222222-2222-4222-8222-222222222222',
  refName: 'refs/heads/main',
  surface: 'product',
};

const BASE_STATE = {
  repositoryId: SELECTION.repositoryId,
  refName: SELECTION.refName,
  revisionSha: 'a'.repeat(40),
  surface: 'product' as const,
  reasonCode: null,
  updatedAt: '2026-07-22T04:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ProviderStateBanner', () => {
  it('renders generating/degraded/failed copy while ready/null stay absent', () => {
    expect(renderToStaticMarkup(<ProviderStateBanner state={null} />)).toBe('');
    expect(
      renderToStaticMarkup(
        <ProviderStateBanner state={{ ...BASE_STATE, status: 'ready' }} />,
      ),
    ).toBe('');
    expect(renderToStaticMarkup(<ProviderStateBanner state={null} loading />)).toContain(
      'Generating semantic view',
    );
    expect(
      renderToStaticMarkup(
        <ProviderStateBanner state={{ ...BASE_STATE, status: 'generating' }} />,
      ),
    ).toContain('Generating semantic view');
    expect(
      renderToStaticMarkup(
        <ProviderStateBanner
          state={{
            ...BASE_STATE,
            status: 'degraded',
            reasonCode: 'timeout',
          }}
        />,
      ),
    ).toContain('temporarily degraded');
    expect(
      renderToStaticMarkup(
        <ProviderStateBanner
          state={{
            ...BASE_STATE,
            status: 'failed',
            reasonCode: 'provider_error',
          }}
        />,
      ),
    ).toContain('generation failed');
  });

  it('carries a Core-shaped persisted degraded row through fetch to rendered canvas status', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...BASE_STATE,
            status: 'degraded',
            reasonCode: 'timeout',
          }),
          { status: 200 },
        ),
      ),
    );
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<ProviderStateStatus selection={SELECTION} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain('temporarily degraded');
    expect(rendered).toContain('Structural data is still available');
    expect(rendered).not.toContain('timeout');
    expect(rendered).not.toMatch(/endpoint|prompt|model/i);
    act(() => renderer!.unmount());
  });

  it('aborts an in-flight request when the selected repository changes', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return new Promise<Response>(() => undefined);
      }),
    );
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<ProviderStateStatus selection={SELECTION} />);
    });
    await act(async () => {
      renderer!.update(
        <ProviderStateStatus
          selection={{
            ...SELECTION,
            repositoryId: '33333333-3333-4333-8333-333333333333',
          }}
        />,
      );
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    act(() => renderer!.unmount());
    expect(signals[1]?.aborted).toBe(true);
  });

  it('ignores an old selection response that arrives after the selection changes', async () => {
    vi.useFakeTimers();
    let resolveOld: ((response: Response) => void) | undefined;
    const nextRepositoryId = '33333333-3333-4333-8333-333333333333';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        if (String(url).includes(SELECTION.repositoryId)) {
          return new Promise<Response>((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...BASE_STATE,
              repositoryId: nextRepositoryId,
              status: 'degraded',
              reasonCode: 'timeout',
            }),
            { status: 200 },
          ),
        );
      }),
    );
    let renderer: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<ProviderStateStatus selection={SELECTION} />);
    });
    await act(async () => {
      renderer!.update(
        <ProviderStateStatus
          selection={{ ...SELECTION, repositoryId: nextRepositoryId }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain('temporarily degraded');

    await act(async () => {
      resolveOld?.(
        new Response(
          JSON.stringify({
            ...BASE_STATE,
            status: 'failed',
            reasonCode: 'provider_error',
          }),
          { status: 200 },
        ),
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain('temporarily degraded');
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('generation failed');
    act(() => renderer!.unmount());
  });

  it('fails silently for auth, server, malformed JSON, and network errors', async () => {
    vi.useFakeTimers();
    const failures: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
      async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
      async () => new Response(JSON.stringify({ error: 'server' }), { status: 500 }),
      async () => new Response('not-json', { status: 200 }),
      async () => {
        throw new Error('private network detail');
      },
    ];

    for (const fail of failures) {
      vi.stubGlobal('fetch', vi.fn(fail));
      let renderer: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<ProviderStateStatus selection={SELECTION} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer!.toJSON()).toBeNull();
      act(() => renderer!.unmount());
    }
  });
});

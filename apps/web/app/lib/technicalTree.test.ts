import { describe, expect, it, vi } from 'vitest';
import { rendererForVisibleNodeCount, toPresentationGraph } from './scaleGraph';
import {
  TechnicalTreeRequestError,
  TechnicalTreeResponseError,
  fetchTechnicalTree,
  normalizeRepositoryIdParam,
  parseTechnicalTreeResponse,
  toAuthorizedCanvasPayload,
  toReactFlowElements,
  type TechnicalTreeResponse,
} from './technicalTree';

const FULL_PARSE_RESPONSE: TechnicalTreeResponse = {
  authorization: 'server-filtered',
  visibleNodeCount: 4,
  nodes: [
    { id: 'folder-root', label: 'Folder', name: 'fixture', path: '', parentId: null },
    {
      id: 'folder-src',
      label: 'Folder',
      name: 'src',
      path: 'src',
      parentId: 'folder-root',
    },
    {
      id: 'file-app',
      label: 'File',
      name: 'app.ts',
      path: 'src/app.ts',
      parentId: 'folder-src',
    },
    {
      id: 'file-util',
      label: 'File',
      name: 'util.ts',
      path: 'src/util.ts',
      parentId: 'folder-src',
    },
  ],
  edges: [
    {
      id: 'CONTAINS:folder-root:folder-src',
      type: 'CONTAINS',
      source: 'folder-root',
      target: 'folder-src',
    },
    {
      id: 'CONTAINS:folder-src:file-app',
      type: 'CONTAINS',
      source: 'folder-src',
      target: 'file-app',
    },
    {
      id: 'CONTAINS:folder-src:file-util',
      type: 'CONTAINS',
      source: 'folder-src',
      target: 'file-util',
    },
    {
      id: 'IMPORTS:file-app:file-util',
      type: 'IMPORTS',
      source: 'file-app',
      target: 'file-util',
    },
  ],
};

function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(FULL_PARSE_RESPONSE)) as Record<string, unknown>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Technical Tree full-parse-to-render contract', () => {
  it('turns an authorized full-parse-shaped response into both renderer contracts', () => {
    const parsed = parseTechnicalTreeResponse(FULL_PARSE_RESPONSE);
    const payload = toAuthorizedCanvasPayload(parsed);
    const reactFlow = toReactFlowElements(payload);
    const sigma = toPresentationGraph(payload);

    expect(payload.authorization).toBe('server-filtered');
    expect(payload.visibleNodeCount).toBe(4);
    expect(new Set(payload.nodes.map((node) => node.kind))).toEqual(
      new Set(['Folder', 'File']),
    );
    expect(payload.edges.map((edge) => edge.relationship)).toContain('IMPORTS');
    expect(payload.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true,
    );
    expect(reactFlow.nodes).toHaveLength(4);
    expect(reactFlow.edges.find((edge) => edge.id.startsWith('IMPORTS'))?.animated).toBe(true);
    expect(sigma.order).toBe(4);
    expect(sigma.size).toBe(4);
    expect(rendererForVisibleNodeCount(payload.visibleNodeCount)).toBe('react-flow');
  });

  it('accepts an authorized node whose parent was hidden by server-side RBAC', () => {
    const value = cloneFixture();
    const nodes = value.nodes as Array<Record<string, unknown>>;
    nodes[1].parentId = 'hidden-parent';

    expect(parseTechnicalTreeResponse(value).nodes[1].parentId).toBe('hidden-parent');
  });

  it('supports an empty authorized repository projection', () => {
    const parsed = parseTechnicalTreeResponse({
      authorization: 'server-filtered',
      visibleNodeCount: 0,
      nodes: [],
      edges: [],
    });

    expect(toAuthorizedCanvasPayload(parsed)).toEqual({
      authorization: 'server-filtered',
      visibleNodeCount: 0,
      nodes: [],
      edges: [],
    });
  });
});

describe('repository selection', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['   ', null],
    [['repo-a', 'repo-b'], null],
    [' repo-a ', 'repo-a'],
  ])('normalizes %j to %j', (value, expected) => {
    expect(normalizeRepositoryIdParam(value)).toBe(expected);
  });
});

describe('Technical Tree response validation', () => {
  it.each([
    ['missing server marker', (value: Record<string, unknown>) => delete value.authorization],
    ['count mismatch', (value: Record<string, unknown>) => (value.visibleNodeCount = 3)],
    [
      'non-renderable node',
      (value: Record<string, unknown>) =>
        (((value.nodes as Array<Record<string, unknown>>)[2].label = 'Function')),
    ],
    [
      'graph-internal edge',
      (value: Record<string, unknown>) =>
        (((value.edges as Array<Record<string, unknown>>)[3].type = 'CALLS')),
    ],
    [
      'dangling edge',
      (value: Record<string, unknown>) =>
        (((value.edges as Array<Record<string, unknown>>)[0].target = 'hidden-node')),
    ],
    [
      'duplicate node id',
      (value: Record<string, unknown>) =>
        (((value.nodes as Array<Record<string, unknown>>)[1].id = 'folder-root')),
    ],
    [
      'duplicate edge id',
      (value: Record<string, unknown>) =>
        (((value.edges as Array<Record<string, unknown>>)[1].id =
          'CONTAINS:folder-root:folder-src')),
    ],
    [
      'invalid import endpoint kind',
      (value: Record<string, unknown>) =>
        (((value.edges as Array<Record<string, unknown>>)[3].source = 'folder-src')),
    ],
    [
      'invalid containment source kind',
      (value: Record<string, unknown>) =>
        (((value.edges as Array<Record<string, unknown>>)[0].source = 'file-app')),
    ],
  ])('rejects %s', (_name, mutate) => {
    const value = cloneFixture();
    mutate(value);

    expect(() => parseTechnicalTreeResponse(value)).toThrow(TechnicalTreeResponseError);
  });
});

describe('fetchTechnicalTree', () => {
  it('requests the same-origin Core route without any client-supplied tenant identity', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(FULL_PARSE_RESPONSE));
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const controller = new AbortController();

    const payload = await fetchTechnicalTree(' repo/with space ', {
      fetchImpl,
      signal: controller.signal,
    });

    expect(payload.visibleNodeCount).toBe(4);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/core/repos/repo%2Fwith%20space/technical-tree?');
    expect(url).toContain('width=2000000');
    expect(url).not.toMatch(/org_?id/i);
    expect(init.signal).toBe(controller.signal);
    expect(init.credentials).toBe('same-origin');
  });

  it('returns a safe authorization error without reading an error response body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secret: 'do not echo' }, 403)) as unknown as typeof fetch;

    const error = await fetchTechnicalTree('repo-1', { fetchImpl }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(TechnicalTreeRequestError);
    expect(error).toMatchObject({
      message: 'You do not have access to this repository.',
      status: 403,
    });
    expect(String(error)).not.toContain('secret');
  });

  it('uses a distinct safe sign-in error for an unauthenticated request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401)) as unknown as typeof fetch;

    await expect(fetchTechnicalTree('repo-1', { fetchImpl })).rejects.toMatchObject({
      message: 'Sign in to view this repository.',
      status: 401,
    });
  });

  it('rejects a missing repository before issuing a request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(FULL_PARSE_RESPONSE)) as unknown as typeof fetch;

    await expect(fetchTechnicalTree('   ', { fetchImpl })).rejects.toBeInstanceOf(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates a network failure for the canvas to convert to its generic safe state', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network offline');
    }) as unknown as typeof fetch;

    await expect(fetchTechnicalTree('repo-1', { fetchImpl })).rejects.toThrow('network offline');
  });

  it('rejects invalid JSON and invalid viewports', async () => {
    const invalidJson = vi.fn(
      async () => new Response('{', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(fetchTechnicalTree('repo-1', { fetchImpl: invalidJson })).rejects.toBeInstanceOf(
      TechnicalTreeResponseError,
    );
    await expect(
      fetchTechnicalTree('repo-1', {
        fetchImpl: invalidJson,
        viewport: { x: 0, y: 0, width: 0, height: 100, zoom: 1 },
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(invalidJson).toHaveBeenCalledTimes(1);
  });
});

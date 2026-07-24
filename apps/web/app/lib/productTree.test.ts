import { describe, expect, it, vi } from 'vitest';
import { rendererForVisibleNodeCount } from './scaleGraph';
import {
  ProductTreeResponseError,
  fetchProductTree,
  parseProductTreeResponse,
  selectedFeaturePanel,
  toProductTreePresentation,
  type ProductTreeResponse,
} from './productTree';

const response: ProductTreeResponse = {
  authorization: 'server-filtered',
  repoId: 'repo-1',
  refName: 'refs/heads/main',
  visibleNodeCount: 3,
  nodes: [
    {
      id: 'api',
      label: 'File',
      name: 'route.ts',
      path: '/services/api/route.ts',
      parentId: null,
    },
    {
      id: 'shared',
      label: 'File',
      name: 'checkout.ts',
      path: '/packages/shared/checkout.ts',
      parentId: null,
    },
    {
      id: 'web',
      label: 'File',
      name: 'Checkout.tsx',
      path: '/apps/web/Checkout.tsx',
      parentId: null,
    },
  ],
  features: [{
    id: 'checkout',
    name: 'Checkout',
    description: 'Completes checkout across the stack.',
    team: 'Commerce',
    memberIds: ['api', 'shared', 'web'],
    filesIncluded: [
      { id: 'api', name: 'route.ts', path: '/services/api/route.ts' },
      { id: 'shared', name: 'checkout.ts', path: '/packages/shared/checkout.ts' },
      { id: 'web', name: 'Checkout.tsx', path: '/apps/web/Checkout.tsx' },
    ],
    recentEdits: [{
      fileId: 'web',
      filePath: '/apps/web/Checkout.tsx',
      editedAt: '2026-07-22T12:00:00Z',
      editorName: 'Ada',
      editorLogin: 'ada',
      pullRequestTitle: 'Ship checkout',
      pullRequestUrl: 'https://example.test/pull/17',
    }],
  }],
};

function largeResponse(nodeCount: number): ProductTreeResponse {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `file-${index}`,
    label: 'File' as const,
    name: `file-${index}.ts`,
    path: `/src/file-${index}.ts`,
    parentId: null,
  }));
  return {
    authorization: 'server-filtered',
    repoId: 'repo-1',
    refName: 'refs/heads/main',
    visibleNodeCount: nodeCount,
    nodes,
    features: [{
      id: 'large-feature',
      name: 'Large feature',
      description: null,
      team: null,
      memberIds: nodes.map(({ id }) => id),
      filesIncluded: nodes.map(({ id, name, path }) => ({ id, name, path })),
      recentEdits: [],
    }],
  };
}

describe('parseProductTreeResponse', () => {
  it('accepts an authorized real-data Feature cluster spanning three code areas', () => {
    expect(parseProductTreeResponse(response)).toEqual(response);
  });

  it('normalizes missing optional Feature metadata to null', () => {
    const value = structuredClone(response) as unknown as {
      features: Array<Record<string, unknown>>;
    };
    delete value.features[0]?.description;
    delete value.features[0]?.team;

    const parsed = parseProductTreeResponse(value);

    expect(parsed.features[0]).toMatchObject({
      description: null,
      team: null,
    });
  });

  it.each([
    ['unfiltered marker', { ...response, authorization: 'client-filtered' }],
    ['visible count mismatch', { ...response, visibleNodeCount: 4 }],
    ['non-canvas node', {
      ...response,
      nodes: [{ ...response.nodes[0], label: 'Feature' }],
    }],
    ['dangling member', {
      ...response,
      features: [{
        ...response.features[0],
        memberIds: ['api', 'hidden'],
        filesIncluded: [
          response.features[0]!.filesIncluded[0],
          { id: 'hidden', name: 'secret.ts', path: '/private/secret.ts' },
        ],
      }],
    }],
    ['hidden-file edit', {
      ...response,
      features: [{
        ...response.features[0],
        recentEdits: [{
          ...response.features[0]!.recentEdits[0],
          fileId: 'hidden',
          filePath: '/private/secret.ts',
        }],
      }],
    }],
    ['unsafe PR URL', {
      ...response,
      features: [{
        ...response.features[0],
        recentEdits: [{
          ...response.features[0]!.recentEdits[0],
          pullRequestUrl: 'javascript:alert(1)',
        }],
      }],
    }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseProductTreeResponse(value)).toThrow(
      ProductTreeResponseError,
    );
  });
});

describe('Product Tree presentation', () => {
  it('draws one dashed-boundary contract around all authorized cluster members', () => {
    const presentation = toProductTreePresentation(response);

    expect(presentation.canvas.authorization).toBe('server-filtered');
    expect(presentation.canvas.nodes).toHaveLength(3);
    expect(new Set(presentation.canvas.nodes.map(({ kind }) => kind))).toEqual(
      new Set(['File']),
    );
    expect(presentation.boundaries).toEqual([
      expect.objectContaining({
        id: 'checkout',
        label: 'Checkout',
        memberIds: ['api', 'shared', 'web'],
      }),
    ]);
    expect(presentation.boundaries[0]!.width).toBeGreaterThan(0);
    expect(presentation.boundaries[0]!.height).toBeGreaterThan(0);
  });

  it('keeps overlapping membership explicit without duplicating a drawable File', () => {
    const overlapping: ProductTreeResponse = structuredClone(response);
    overlapping.features.push({
      id: 'payments',
      name: 'Payments',
      description: null,
      team: null,
      memberIds: ['shared'],
      filesIncluded: [{
        id: 'shared',
        name: 'checkout.ts',
        path: '/packages/shared/checkout.ts',
      }],
      recentEdits: [],
    });
    const presentation = toProductTreePresentation(overlapping);

    expect(presentation.canvas.nodes).toHaveLength(3);
    expect(presentation.boundaries).toHaveLength(2);
    expect(
      presentation.boundaries.every(({ width, height }) => width > 0 && height > 0),
    ).toBe(true);
  });

  it('uses W2-01 renderer thresholds at 500 and 501 Product nodes', () => {
    const atThreshold = toProductTreePresentation(largeResponse(500));
    const overThreshold = toProductTreePresentation(largeResponse(501));

    expect(rendererForVisibleNodeCount(atThreshold.canvas.visibleNodeCount)).toBe(
      'react-flow',
    );
    expect(rendererForVisibleNodeCount(overThreshold.canvas.visibleNodeCount)).toBe(
      'sigma',
    );
    expect(overThreshold.boundaries[0]?.memberIds).toHaveLength(501);
  });

  it('turns a boundary selection into the four-field panel data source', () => {
    expect(selectedFeaturePanel(response, null)).toBeNull();
    expect(selectedFeaturePanel(response, 'checkout')).toEqual(response.features[0]);
    expect(selectedFeaturePanel(response, 'hidden')).toBeNull();
  });
});

describe('fetchProductTree', () => {
  it('requests the same-origin Core rewrite and returns a presentation', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const result = await fetchProductTree('repo/one', 'refs/heads/release', {
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/core/repos/repo%2Fone/product-tree?ref=refs%2Fheads%2Frelease',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'GET',
      }),
    );
    expect(result.response).toEqual(response);
  });

  it.each([
    [401, 'Sign in to view this repository.'],
    [403, 'You do not have access to this repository.'],
    [500, 'The Product Tree could not be loaded.'],
  ])('maps HTTP %i to a safe request error', async (status, message) => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status }));

    await expect(
      fetchProductTree('repo-1', 'main', { fetchImpl }),
    ).rejects.toMatchObject({ status, message });
  });

  it('rejects malformed JSON instead of rendering partial data', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    await expect(
      fetchProductTree('repo-1', 'main', { fetchImpl }),
    ).rejects.toBeInstanceOf(ProductTreeResponseError);
  });
});

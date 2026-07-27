import { describe, expect, it, vi } from 'vitest';
import {
  OnboardingTreeResponseError,
  fetchOnboardingTree,
  parseOnboardingTreeResponse,
  runOnboardingStep,
  toOnboardingTreePresentation,
} from './onboardingTree';

const response = {
  authorization: 'server-filtered' as const,
  repoId: 'repo-1',
  refName: 'refs/heads/main',
  revisionSha: 'a'.repeat(40),
  visibleNodeCount: 2,
  nodes: [
    {
      id: 'root',
      label: 'Folder' as const,
      name: 'fixture',
      path: '',
      parentId: null,
    },
    {
      id: 'readme',
      label: 'File' as const,
      name: 'README.md',
      path: 'README.md',
      parentId: 'root',
    },
  ],
  edges: [
    {
      id: 'CONTAINS:root:readme',
      type: 'CONTAINS' as const,
      source: 'root',
      target: 'readme',
    },
  ],
  steps: [
    {
      id: 'step-1',
      sequence: 0,
      command: 'printf ready',
      requires: [],
    },
    {
      id: 'step-2',
      sequence: 1,
      command: 'node --version',
      requires: ['step-1'],
    },
  ],
};

describe('Onboarding Tree client contract', () => {
  it('keeps EnvStep metadata out of Folder/File canvas nodes', () => {
    const presentation = toOnboardingTreePresentation(
      parseOnboardingTreeResponse(response),
    );

    expect(presentation.canvas.nodes.some(({ id }) => id.startsWith('step-'))).toBe(
      false,
    );
  });

  it('lays out by prerequisite layer instead of directory depth', () => {
    // page imports money, so money is a prerequisite and must sit to its left.
    const parsed = parseOnboardingTreeResponse({
      ...response,
      visibleNodeCount: 3,
      nodes: [
        ...response.nodes,
        {
          id: 'money',
          label: 'File',
          name: 'money.ts',
          path: 'deep/nested/money.ts',
          parentId: 'root',
        },
      ],
      edges: [
        ...response.edges,
        {
          id: 'IMPORTS:readme:money',
          type: 'IMPORTS',
          source: 'readme',
          target: 'money',
        },
      ],
    });
    const presentation = toOnboardingTreePresentation(parsed);

    const byId = Object.fromEntries(
      presentation.canvas.nodes.map((node) => [node.id, node]),
    );
    // Directory depth would put the deeply nested file on the right; the
    // prerequisite ordering puts it first because it is the dependency.
    expect(byId.money.x).toBeLessThan(byId.readme.x);
    expect(presentation.prerequisite.layerCount).toBe(2);
    expect(presentation.canvas.edges).toEqual([
      {
        id: 'PREREQUISITE:money:readme',
        source: 'money',
        target: 'readme',
        relationship: 'PREREQUISITE',
      },
    ]);
  });

  it('renders files only, so folders never appear on the onboarding canvas', () => {
    const presentation = toOnboardingTreePresentation(
      parseOnboardingTreeResponse(response),
    );
    expect(presentation.canvas.nodes.map(({ kind }) => kind)).toEqual(['File']);
    expect(presentation.canvas.nodes.map(({ id }) => id)).toEqual(['readme']);
  });

  it('rejects an edge endpoint outside the authorized node set', () => {
    // A dangling endpoint means the server filtered a node out of `nodes` but
    // left it reachable through an edge, which would leak hidden structure.
    expect(() =>
      parseOnboardingTreeResponse({
        ...response,
        edges: [
          {
            id: 'IMPORTS:readme:hidden',
            type: 'IMPORTS',
            source: 'readme',
            target: 'hidden',
          },
        ],
      }),
    ).toThrow(OnboardingTreeResponseError);
  });

  it('rejects duplicate edge identifiers and unknown relationship types', () => {
    expect(() =>
      parseOnboardingTreeResponse({
        ...response,
        edges: [response.edges[0], response.edges[0]],
      }),
    ).toThrow(OnboardingTreeResponseError);
    expect(() =>
      parseOnboardingTreeResponse({
        ...response,
        edges: [{ ...response.edges[0], type: 'CALLS' }],
      }),
    ).toThrow(OnboardingTreeResponseError);
  });

  it('rejects a response with no edges array at all', () => {
    const { edges: _edges, ...withoutEdges } = response;
    expect(() => parseOnboardingTreeResponse(withoutEdges)).toThrow(
      OnboardingTreeResponseError,
    );
  });

  it('rejects gapped or forward-pointing prerequisite workflows', () => {
    expect(() =>
      parseOnboardingTreeResponse({
        ...response,
        steps: [{ ...response.steps[1], sequence: 1, requires: [] }],
      }),
    ).toThrow(OnboardingTreeResponseError);
    expect(() =>
      parseOnboardingTreeResponse({
        ...response,
        steps: [
          { ...response.steps[0], requires: ['step-2'] },
          response.steps[1],
        ],
      }),
    ).toThrow(OnboardingTreeResponseError);
  });

  it('fetches the selected ref and validates the response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await fetchOnboardingTree('repo-1', 'refs/heads/release', {
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.response.steps).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/core/repos/repo-1/onboarding-tree?ref=refs%2Fheads%2Frelease',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('posts only a step identity; no command is accepted by the client call', async () => {
    const execution = {
      sandbox: 'container',
      status: 'succeeded',
      exitCode: 0,
      stdout: 'ready',
      stderr: '',
      durationMs: 8,
      stepId: 'step-1',
      sequence: 0,
      revisionSha: 'a'.repeat(40),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(execution), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      runOnboardingStep(
        'repo-1',
        'refs/heads/main',
        'step-1',
        fetchImpl as typeof fetch,
      ),
    ).resolves.toEqual(execution);
    const init = (
      fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit]>
    )[0]?.[1];
    expect(init).toMatchObject({ method: 'POST' });
    expect(init).not.toHaveProperty('body');
  });
});

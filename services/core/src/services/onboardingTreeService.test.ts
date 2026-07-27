import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  GraphEdge,
  OnboardingGraphProjection,
  OnboardingGraphQueryService,
} from '../graph-query/types';
import type { OnboardingSandboxRunner } from './onboardingSandboxService';
import {
  OnboardingStepNotFoundError,
  executeOnboardingStep,
  getOnboardingTree,
} from './onboardingTreeService';

const context: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: 'org-1',
  roles: ['admin'],
};

const projection: OnboardingGraphProjection = {
  revisionSha: 'a'.repeat(40),
  nodes: [{
    id: 'root',
    label: 'Folder',
    name: 'fixture',
    path: '',
    parentId: null,
  }],
  steps: [{
    id: 'step-1',
    sequence: 0,
    command: 'printf ready',
    requires: [],
  }],
};

const edges: GraphEdge[] = [
  { id: 'IMPORTS:a:b', type: 'IMPORTS', source: 'root', target: 'root' },
];

function graph(
  value: OnboardingGraphProjection | null = projection,
  structuralEdges: GraphEdge[] = edges,
) {
  return {
    getOnboardingProjection: vi.fn(async () => value),
    getStructuralEdges: vi.fn(async () => structuralEdges),
  } satisfies OnboardingGraphQueryService;
}

describe('Onboarding Tree service boundary', () => {
  it('returns only the server-filtered Folder/File projection and ordered metadata', async () => {
    const store = graph();

    await expect(
      getOnboardingTree(' repo-1 ', 'main', context, store),
    ).resolves.toEqual({
      authorization: 'server-filtered',
      repoId: 'repo-1',
      refName: 'refs/heads/main',
      revisionSha: projection.revisionSha,
      visibleNodeCount: 1,
      nodes: projection.nodes,
      edges,
      steps: projection.steps,
    });
    expect(store.getOnboardingProjection).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      context,
    );
  });

  it('re-authorizes edges against exactly the projected node set', async () => {
    const store = graph();

    await getOnboardingTree(' repo-1 ', 'main', context, store);

    // Scoping the edge query to the ids the projection already returned is what
    // keeps an edge from referencing a node the caller was never granted.
    expect(store.getStructuralEdges).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      projection.nodes.map(({ id }) => id),
      context,
    );
  });

  it('returns an empty edge set rather than failing when nothing is authorized', async () => {
    const store = graph(projection, []);

    await expect(
      getOnboardingTree('repo-1', 'main', context, store),
    ).resolves.toMatchObject({ edges: [] });
  });

  it('executes only the command resolved from the authorized current graph', async () => {
    const sandbox = {
      run: vi.fn(async () => ({
        sandbox: 'container' as const,
        status: 'succeeded' as const,
        exitCode: 0,
        stdout: 'ready',
        stderr: '',
        durationMs: 9,
      })),
    } satisfies OnboardingSandboxRunner;

    const result = await executeOnboardingStep(
      'repo-1',
      'step-1',
      'refs/heads/main',
      context,
      { graph: graph(), sandbox },
    );

    expect(sandbox.run).toHaveBeenCalledWith('printf ready');
    expect(result).toMatchObject({
      stepId: 'step-1',
      sequence: 0,
      revisionSha: projection.revisionSha,
      sandbox: 'container',
    });
  });

  it('fails closed before sandbox execution for an unknown step', async () => {
    const sandbox: OnboardingSandboxRunner = { run: vi.fn() };

    await expect(
      executeOnboardingStep('repo-1', 'missing', 'main', context, {
        graph: graph(),
        sandbox,
      }),
    ).rejects.toBeInstanceOf(OnboardingStepNotFoundError);
    expect(sandbox.run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
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

function graph(value: OnboardingGraphProjection | null = projection) {
  return {
    getOnboardingProjection: vi.fn(async () => value),
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
      steps: projection.steps,
    });
    expect(store.getOnboardingProjection).toHaveBeenCalledWith(
      'repo-1',
      'refs/heads/main',
      context,
    );
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

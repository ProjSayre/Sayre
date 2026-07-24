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

    expect(presentation.canvas.nodes.map(({ kind }) => kind)).toEqual([
      'Folder',
      'File',
    ]);
    expect(presentation.canvas.nodes.some(({ id }) => id.startsWith('step-'))).toBe(
      false,
    );
    expect(presentation.canvas.edges).toEqual([
      {
        id: 'CONTAINS:root:readme',
        source: 'root',
        target: 'readme',
        relationship: 'CONTAINS',
      },
    ]);
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

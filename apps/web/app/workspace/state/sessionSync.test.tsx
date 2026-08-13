// Leading-red tests (W7-01, AC-16/EC-22) for WorkspaceSessionProvider's new `sync` field and its
// re-poll behavior. Mirrors focusedProviders.test.tsx's WorkspaceProvider + react-test-renderer +
// act() convention (this package's vitest config runs with environment: 'node', so
// renderToStaticMarkup/react-test-renderer are used instead of DOM-based testing-library, which
// isn't a dependency here).
//
// Today, `source.repositories()` returns a bare Repository[] and the re-poll effect's condition
// is `catalog.some(item => item.readiness === 'registered')` — it has no notion of `sync` at all,
// so a large installation that is still importing (catalog empty, no repository rows yet) is
// never re-polled. Every assertion below fails today (RED-CORRECT).

import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from './WorkspaceProvider';
import { useWorkspaceSession } from './session';
import type { WorkspaceDataSource } from '../dataSource';
import type { Repository } from '../types';

(globalThis as unknown as { React: typeof React }).React = React;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface RepositoryImportSyncLike {
  status: 'idle' | 'importing' | 'stalled' | 'failed';
  updatedAt: string | null;
  discoveredRepositories: number | null;
  registeredRepositories: number | null;
}

function makeSource(
  responses: Array<{ repositories: Repository[]; sync: RepositoryImportSyncLike }>,
): WorkspaceDataSource & { callCount: () => number } {
  let call = 0;
  const repositories = vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    // W7-01's new contract: repositories() resolves { repositories, sync } — cast through
    // `unknown` since the current WorkspaceDataSource type still declares Repository[].
    return response as unknown as Repository[];
  });
  return {
    id: 'live',
    githubInstallUrl: '#',
    jiraConnectUrl: '#',
    viewer: { name: 'x', initials: 'X', email: 'x@example.com', org: 'Acme' },
    repositories,
    technicalTree: vi.fn(),
    productTree: vi.fn(),
    onboardingTree: vi.fn(),
    runOnboardingStep: vi.fn(),
    providerState: vi.fn(),
    nodeOverlay: vi.fn(),
    saveAgentSkillMd: vi.fn(),
    providerSettings: vi.fn(async () => {
      throw Object.assign(new Error('unauthenticated'), { status: 401 });
    }),
    saveProviderSetting: vi.fn(),
    mcpSettings: vi.fn(),
    issueMcpKey: vi.fn(),
    revokeMcpKey: vi.fn(),
    saveMcpRateLimit: vi.fn(),
    githubIntegrationStatus: vi.fn(),
    jiraIntegrationStatus: vi.fn(),
    disconnectJira: vi.fn(),
    callCount: () => call,
  } as unknown as WorkspaceDataSource & { callCount: () => number };
}

describe('WorkspaceSessionProvider — AC-16 (re-polls while a sync is in flight, even with an empty catalog)', () => {
  // @spec AC-16
  it('re-polls the catalog ~2.5s later while sync.status is "importing", even though no repository has been registered yet', async () => {
    const source = makeSource([
      { repositories: [], sync: { status: 'importing', updatedAt: null, discoveredRepositories: 0, registeredRepositories: 0 } },
      { repositories: [], sync: { status: 'importing', updatedAt: null, discoveredRepositories: 40, registeredRepositories: 12 } },
    ]);

    let latestSession: ReturnType<typeof useWorkspaceSession> | undefined;
    function Probe() {
      const [, force] = useState(0);
      latestSession = useWorkspaceSession();
      // Re-render occasionally so the probe reflects context updates during the test.
      React.useEffect(() => {
        const id = setInterval(() => force((v) => v + 1), 50);
        return () => clearInterval(id);
      }, []);
      return null;
    }

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WorkspaceProvider source={source}>
          <Probe />
        </WorkspaceProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(source.callCount()).toBe(1);
    expect((latestSession as unknown as { sync: RepositoryImportSyncLike }).sync?.status).toBe('importing');

    await act(async () => {
      vi.advanceTimersByTime(2_600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(source.callCount()).toBeGreaterThanOrEqual(2);
    await act(async () => renderer!.unmount());
  });
});

describe('WorkspaceSessionProvider — EC-22 (polling stops once sync returns to idle)', () => {
  // @spec EC-22
  it('stops re-polling once sync.status is "idle" and no repository is still "registered"', async () => {
    const source = makeSource([
      { repositories: [], sync: { status: 'importing', updatedAt: null, discoveredRepositories: 0, registeredRepositories: 0 } },
      { repositories: [], sync: { status: 'idle', updatedAt: '2026-08-12T18:00:00Z', discoveredRepositories: 5, registeredRepositories: 5 } },
    ]);

    await act(async () => {
      TestRenderer.create(
        <WorkspaceProvider source={source}>
          <div />
        </WorkspaceProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(2_600);
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsAfterFirstPoll = source.callCount();
    expect(callsAfterFirstPoll).toBe(2); // importing -> one re-poll -> now idle

    await act(async () => {
      vi.advanceTimersByTime(10_000); // well past several more 2.5s intervals
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(source.callCount()).toBe(callsAfterFirstPoll); // no further polling once idle
  });
});

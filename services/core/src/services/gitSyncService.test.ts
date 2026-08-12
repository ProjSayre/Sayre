import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { makeEnvelope } from '../queue/envelope';
import { FakeHubProviderAdapter } from '../integrations/git/__fixtures__/fakehubProvider';
import { GitProviderRegistry } from '../integrations/git/providerRegistry';
import { GithubProviderAdapter } from '../integrations/git/providers/github';
import type { OwnershipGraphStore } from '../integrations/git/graphOwnershipStore';
import type { GitRepositoryResolver } from '../integrations/git/repositoryResolver';
import type { ProviderRepoEvent } from '../integrations/git/types';
import { syncGitMetadata } from './gitSyncService';

afterEach(() => {
  resetConfigForTests();
});

describe('syncGitMetadata', () => {
  it('uses server-derived scope and applies a provider-resolved merged-PR edit', async () => {
    const changes = {
      refName: 'refs/heads/main',
      edits: [{
        path: 'src/a.ts',
        commitSha: 'merge-sha',
        commitMessage: 'Merge PR 17',
        editedAt: '2026-07-22T12:00:00Z',
        author: { name: null, email: null, login: 'fake-user' },
        pullRequest: {
          number: 17,
          title: 'Ship it',
          url: 'https://fakehub.test/pr/17',
          mergedAt: '2026-07-22T12:00:00Z',
        },
      }],
    };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'pull_request',
      repo: {
        provider_repo_id: 'provider-repo',
        full_name: 'acme/repo',
        repo_id: 'untrusted-payload-repo',
      },
      ref: 'feature',
      installation_id: 'installation',
      delivery_id: 'delivery',
      payload: { action: 'closed' },
    };
    const resolve = vi.fn(async () => ({ repositoryId: 'server-repository-id' }));
    const repositories: GitRepositoryResolver = { resolve };
    const apply = vi.fn(async () => ({ updatedFiles: 1 }));
    const graph: OwnershipGraphStore = { apply, close: vi.fn(async () => undefined) };
    const envelope = makeEnvelope({
      org_id: 'server-org-id',
      type: 'repo.pull_request',
      source: 'fakehub-webhook',
      payload: event,
      occurred_at: '2026-07-22T12:00:01Z',
    });

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([new FakeHubProviderAdapter(changes)]),
      installations: { resolve: vi.fn() },
      repositories,
      graph,
    });

    expect(resolve).toHaveBeenCalledWith('server-org-id', event);
    expect(apply).toHaveBeenCalledWith({
      orgId: 'server-org-id',
      provider: 'fakehub',
      repositoryId: 'server-repository-id',
      refName: 'refs/heads/main',
      edits: changes.edits,
    });
    expect(result).toEqual({ status: 'applied', provider: 'fakehub', updatedFiles: 1 });
  });

  it('ignores provider events that produce no file changes before database access', async () => {
    const repositories: GitRepositoryResolver = { resolve: vi.fn() };
    const graph: OwnershipGraphStore = {
      apply: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const event: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'branch',
      repo: { provider_repo_id: '1', full_name: 'a/b', repo_id: null },
      ref: 'refs/heads/new',
      installation_id: 'i',
      delivery_id: 'd',
      payload: {},
    };
    const envelope = makeEnvelope({
      org_id: 'server-org-id',
      type: 'repo.branch',
      source: 'fakehub-webhook',
      payload: event,
    });

    await expect(syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([
        new FakeHubProviderAdapter({ refName: null, edits: [] }),
      ]),
      installations: { resolve: vi.fn() },
      repositories,
      graph,
    })).resolves.toEqual({ status: 'ignored', provider: 'fakehub', updatedFiles: 0 });
    expect(repositories.resolve).not.toHaveBeenCalled();
    expect(graph.apply).not.toHaveBeenCalled();
  });

  it('maps a merged GitHub PR to its corresponding File paths end to end', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const event: ProviderRepoEvent = {
      provider: 'github',
      type: 'pull_request',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'feature/widgets',
      installation_id: '99',
      delivery_id: 'delivery-merged',
      payload: {
        action: 'closed',
        number: 21,
        pull_request: {
          merged: true,
          merged_at: '2026-07-22T12:00:00Z',
          merge_commit_sha: 'merge-21',
          title: 'Merge widgets',
          html_url: 'https://github.test/acme/widgets/pull/21',
          head: { ref: 'feature/widgets', sha: 'head-21' },
          base: { ref: 'main', sha: 'base-21' },
          user: { login: 'octocat' },
        },
      },
    };
    const graph: OwnershipGraphStore = {
      apply: vi.fn(async () => ({ updatedFiles: 2 })),
      close: vi.fn(async () => undefined),
    };
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'repo.pull_request',
      source: 'github-webhook',
      payload: event,
    });

    const result = await syncGitMetadata(envelope, {
      providers: new GitProviderRegistry([
        new GithubProviderAdapter(
          async () => 'ephemeral-token',
          async () => new Response(JSON.stringify([
            { filename: 'src/api.ts' },
            { filename: 'src/widget.ts' },
          ]), { status: 200 }),
        ),
      ]),
      installations: {
        resolve: async () => ({ orgId: 'server-org', active: true }),
      },
      repositories: { resolve: async () => ({ repositoryId: 'repo-id' }) },
      graph,
    });

    expect(graph.apply).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'server-org',
      provider: 'github',
      repositoryId: 'repo-id',
      refName: 'refs/heads/main',
      edits: [
        expect.objectContaining({ path: 'src/api.ts', pullRequest: expect.objectContaining({ number: 21 }) }),
        expect.objectContaining({ path: 'src/widget.ts', pullRequest: expect.objectContaining({ number: 21 }) }),
      ],
    }));
    expect(result).toEqual({ status: 'applied', provider: 'github', updatedFiles: 2 });
  });

  function githubPullRequestEvent(installationId = '99'): ProviderRepoEvent {
    return {
      provider: 'github',
      type: 'pull_request',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'feature/widgets',
      installation_id: installationId,
      delivery_id: 'delivery-revocation-boundary',
      payload: {
        action: 'closed',
        number: 21,
        pull_request: {
          merged: true,
          merged_at: '2026-07-22T12:00:00Z',
          merge_commit_sha: 'merge-21',
          title: 'Merge widgets',
          html_url: 'https://github.test/acme/widgets/pull/21',
          head: { ref: 'feature/widgets', sha: 'head-21' },
          base: { ref: 'main', sha: 'base-21' },
          user: { login: 'octocat' },
        },
      },
    };
  }

  function guardedGithubDependencies(resolveInstallation: ReturnType<typeof vi.fn>) {
    const mintToken = vi.fn(async () => 'must-not-be-minted');
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify([{ filename: 'src/api.ts' }]),
      { status: 200 },
    ));
    const resolveRepository = vi.fn(async () => ({ repositoryId: 'repo-id' }));
    const apply = vi.fn(async () => ({ updatedFiles: 1 }));
    return {
      dependencies: {
        providers: new GitProviderRegistry([new GithubProviderAdapter(mintToken, fetcher)]),
        installations: { resolve: resolveInstallation },
        repositories: { resolve: resolveRepository },
        graph: { apply, close: vi.fn(async () => undefined) } as OwnershipGraphStore,
      },
      mintToken,
      fetcher,
      resolveRepository,
      apply,
    };
  }

  // @spec AC-1
  it.each([
    ['revoked or suspended', { orgId: 'server-org', active: false }],
    ['unknown', null],
    ['bound to another tenant', { orgId: 'other-org', active: true }],
  ])('ignores queued GitHub work when its installation is %s before provider or write side effects', async (_label, resolution) => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const resolveInstallation = vi.fn(async () => resolution);
    const guarded = guardedGithubDependencies(resolveInstallation);
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'repo.pull_request',
      source: 'github-webhook',
      payload: githubPullRequestEvent(),
    });

    await expect(syncGitMetadata(envelope, guarded.dependencies)).resolves.toEqual({
      status: 'ignored',
      provider: 'github',
      updatedFiles: 0,
    });
    expect(resolveInstallation).toHaveBeenCalledWith(99);
    expect(guarded.mintToken).not.toHaveBeenCalled();
    expect(guarded.fetcher).not.toHaveBeenCalled();
    expect(guarded.resolveRepository).not.toHaveBeenCalled();
    expect(guarded.apply).not.toHaveBeenCalled();
  });

  // @spec AC-2 EC-2
  it('checks an active GitHub installation while leaving non-GitHub providers independent', async () => {
    const resolveInstallation = vi.fn(async () => ({ orgId: 'server-org', active: true }));
    const nonGithubApply = vi.fn(async () => ({ updatedFiles: 1 }));
    const nonGithubEvent: ProviderRepoEvent = {
      provider: 'fakehub',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: 'provider-specific-value',
      delivery_id: 'non-github-control',
      payload: {},
    };
    const nonGithubResult = await syncGitMetadata(
      makeEnvelope({
        org_id: 'server-org',
        type: 'repo.push',
        source: 'fakehub-webhook',
        payload: nonGithubEvent,
      }),
      {
        providers: new GitProviderRegistry([new FakeHubProviderAdapter({
          refName: 'refs/heads/main',
          edits: [{
            path: 'src/a.ts',
            commitSha: 'a'.repeat(40),
            commitMessage: null,
            editedAt: '2026-07-22T12:00:00Z',
            author: { name: null, email: null, login: null },
            pullRequest: null,
          }],
        })]),
        installations: { resolve: resolveInstallation },
        repositories: { resolve: vi.fn(async () => ({ repositoryId: 'repo-id' })) },
        graph: { apply: nonGithubApply, close: vi.fn(async () => undefined) },
      },
    );
    expect(nonGithubResult.status).toBe('applied');
    expect(resolveInstallation).not.toHaveBeenCalled();

    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const guarded = guardedGithubDependencies(resolveInstallation);
    const githubResult = await syncGitMetadata(
      makeEnvelope({
        org_id: 'server-org',
        type: 'repo.pull_request',
        source: 'github-webhook',
        payload: githubPullRequestEvent(),
      }),
      guarded.dependencies,
    );
    expect(githubResult.status).toBe('applied');
    expect(resolveInstallation).toHaveBeenCalledOnce();
    expect(resolveInstallation).toHaveBeenCalledWith(99);
  });

  // @spec EC-1
  it.each(['', 'not-a-number', '0', '-1', '9007199254740992'])(
    'fails closed for invalid GitHub installation id %j',
    async (installationId) => {
      const resolveInstallation = vi.fn();
      const guarded = guardedGithubDependencies(resolveInstallation);
      const envelope = makeEnvelope({
        org_id: 'server-org',
        type: 'repo.pull_request',
        source: 'github-webhook',
        payload: githubPullRequestEvent(installationId),
      });

      await expect(syncGitMetadata(envelope, guarded.dependencies)).resolves.toEqual({
        status: 'ignored',
        provider: 'github',
        updatedFiles: 0,
      });
      expect(resolveInstallation).not.toHaveBeenCalled();
      expect(guarded.mintToken).not.toHaveBeenCalled();
      expect(guarded.apply).not.toHaveBeenCalled();
    },
  );

  // @spec EC-3
  it('propagates installation-resolution failures without provider or write side effects', async () => {
    const resolveInstallation = vi.fn(async () => {
      throw new Error('installation resolver unavailable');
    });
    const guarded = guardedGithubDependencies(resolveInstallation);
    const envelope = makeEnvelope({
      org_id: 'server-org',
      type: 'repo.pull_request',
      source: 'github-webhook',
      payload: githubPullRequestEvent(),
    });

    await expect(syncGitMetadata(envelope, guarded.dependencies)).rejects.toThrow(
      'installation resolver unavailable',
    );
    expect(guarded.mintToken).not.toHaveBeenCalled();
    expect(guarded.resolveRepository).not.toHaveBeenCalled();
    expect(guarded.apply).not.toHaveBeenCalled();
  });
});

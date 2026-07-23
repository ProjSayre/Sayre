import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests, setConfigOverrideForTests } from '@sayre/config';
import { GithubGitSyncError, GithubProviderAdapter } from './github';
import type { ProviderRepoEvent } from '../types';

function pullRequestEvent(): ProviderRepoEvent {
  return {
    provider: 'github',
    type: 'pull_request',
    repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
    ref: 'feature/ship',
    installation_id: '99',
    delivery_id: 'delivery-1',
    payload: {
      action: 'closed',
      number: 17,
      pull_request: {
        merged: true,
        merged_at: '2026-07-22T12:00:00Z',
        merge_commit_sha: 'abc123',
        title: 'Ship widgets',
        html_url: 'https://github.example/acme/widgets/pull/17',
        head: { ref: 'feature/ship', sha: 'head123' },
        base: { ref: 'main', sha: 'base123' },
        user: { login: 'octocat' },
      },
    },
  };
}

afterEach(() => {
  resetConfigForTests();
});

describe('GithubProviderAdapter', () => {
  it('authenticates with an installation token and resolves merged PR files', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const mintToken = vi.fn(async () => 'ephemeral-token');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }]), {
        status: 200,
      }),
    );
    const adapter = new GithubProviderAdapter(mintToken, fetcher);

    const changes = await adapter.resolveChanges(
      pullRequestEvent(),
      '2026-07-22T11:00:00Z',
    );

    expect(mintToken).toHaveBeenCalledWith(99);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.test/repos/acme/widgets/pulls/17/files?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ephemeral-token' }),
      }),
    );
    expect(changes.refName).toBe('refs/heads/main');
    expect(changes.edits.map((edit) => edit.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(changes.edits[0]).toMatchObject({
      commitSha: 'abc123',
      author: { login: 'octocat' },
      pullRequest: { number: 17, title: 'Ship widgets' },
    });
  });

  it('maps normalized push commits without requesting provider credentials', async () => {
    const mintToken = vi.fn(async () => 'unused');
    const fetcher = vi.fn();
    const adapter = new GithubProviderAdapter(mintToken, fetcher);
    const event: ProviderRepoEvent = {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: '99',
      delivery_id: 'delivery-2',
      payload: {
        commits: [
          {
            id: 'commit-1',
            message: 'change',
            timestamp: '2026-07-22T12:00:00Z',
            author: { name: 'Ada', email: 'ada@example.test' },
            added: ['src/new.ts'],
            modified: ['src/a.ts'],
            removed: ['src/gone.ts'],
          },
        ],
      },
    };

    const changes = await adapter.resolveChanges(event, '2026-07-22T12:00:01Z');

    expect(changes.edits.map((edit) => edit.path)).toEqual(['src/new.ts', 'src/a.ts']);
    expect(mintToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never includes an ephemeral token in provider errors', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const adapter = new GithubProviderAdapter(
      async () => 'do-not-leak-this-token',
      async () => new Response(null, { status: 403 }),
    );

    await expect(
      adapter.resolveChanges(pullRequestEvent(), '2026-07-22T12:00:01Z'),
    ).rejects.toEqual(expect.objectContaining({
      name: 'GithubGitSyncError',
      message: expect.not.stringContaining('do-not-leak-this-token'),
    }));
    await expect(
      adapter.resolveChanges(pullRequestEvent(), '2026-07-22T12:00:01Z'),
    ).rejects.toBeInstanceOf(GithubGitSyncError);
  });
});

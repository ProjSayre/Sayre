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

// W3-04 gapfill (GAP-3, GAP-8): adapted to the options-object constructor
// (GithubProviderAdapterOptions) — the two-positional-argument (mintToken, fetcher) form
// spec.md's Interfaces section replaces is gone. Each test's assertions are otherwise
// unchanged from before this gapfill.
describe('GithubProviderAdapter', () => {
  it('authenticates with an installation token and resolves merged PR files', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const mintToken = vi.fn(async () => 'ephemeral-token');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }]), {
        status: 200,
      }),
    );
    const adapter = new GithubProviderAdapter({ mintToken, fetcher });

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
    const adapter = new GithubProviderAdapter({ mintToken, fetcher });
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
    const adapter = new GithubProviderAdapter({
      mintToken: async () => 'do-not-leak-this-token',
      fetcher: async () => new Response(null, { status: 403 }),
    });

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

// W3-04 gapfill additions below (GAP-3, GAP-5, GAP-8, GAP-9). spec.md's Interfaces
// section replaces the two-positional-argument constructor with a single options
// object (`GithubProviderAdapterOptions`), so every test below constructs the adapter
// that way — this is the target shape, not a stopgap, and each test is written so it
// will pass once the real options-object constructor + the corresponding behavior both
// land, not just once the constructor changes.
describe('GithubProviderAdapter — W3-04 gapfill', () => {
  // @spec AC-12
  it('GAP-8: uses context.resolveCredential() instead of minting an installation token when a credential ref is configured', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const resolveCredential = vi.fn(async () => 'context-token');
    const context = {
      provider: 'github',
      credentialRef: 'env://GITHUB_APP_CLIENT_SECRET' as const,
      resolveCredential,
    };
    const mintToken = vi.fn(async () => 'must-not-be-used');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }]), { status: 200 }),
    );

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      context?: typeof context;
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ context, mintToken, fetcher });

    await adapter.resolveChanges(pullRequestEvent(), '2026-07-22T11:00:00Z');

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(mintToken).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer context-token' }),
      }),
    );
  });

  // @spec AC-12
  it('GAP-8: falls back to minting an installation token when no credential ref is configured', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const mintToken = vi.fn(async () => 'ephemeral-token');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }]), { status: 200 }),
    );

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    await adapter.resolveChanges(pullRequestEvent(), '2026-07-22T11:00:00Z');

    expect(mintToken).toHaveBeenCalledWith(99);
  });

  // @spec AC-6 EC-9
  it('GAP-3: throws GithubGitSyncError and stops requesting once pagination exceeds MAX_PULL_REQUEST_FILE_PAGES, never returning a silently truncated list', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const { MAX_PULL_REQUEST_FILE_PAGES } = await import('../budgets');
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ filename: `src/file-${index}.ts` }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify(fullPage), { status: 200 }));
    const mintToken = vi.fn(async () => 'ephemeral-token');

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    await expect(
      adapter.resolveChanges(pullRequestEvent(), '2026-07-22T11:00:00Z'),
    ).rejects.toBeInstanceOf(GithubGitSyncError);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_FILE_PAGES + 1);
  });

  // @spec AC-6 EC-10
  it('GAP-3: every pull-request-files request carries an AbortSignal (per-request hang guard)', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }]), { status: 200 }),
    );
    const mintToken = vi.fn(async () => 'ephemeral-token');

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    await adapter.resolveChanges(pullRequestEvent(), '2026-07-22T11:00:00Z');

    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // @spec AC-6 EC-12
  it('GAP-3: every pull-request-files request sets redirect: "manual", never following a 3xx', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([{ filename: 'src/a.ts' }]), { status: 200 }),
    );
    const mintToken = vi.fn(async () => 'ephemeral-token');

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    await adapter.resolveChanges(pullRequestEvent(), '2026-07-22T11:00:00Z');

    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  // @spec AC-13 EC-24
  it.each([
    'a/../../owner/repo',
    'a/b/c',
    'owner/',
    '/name',
    'owner//name',
    '..',
    '',
    'own er/repo',
    'owner/re%2Fpo',
  ])('GAP-9: rejects a malformed full_name (%s) with GithubGitSyncError before any fetcher call', async (fullName) => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const mintToken = vi.fn(async () => 'ephemeral-token');
    const event = pullRequestEvent();
    event.repo.full_name = fullName;

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    const rejection = expect(
      adapter.resolveChanges(event, '2026-07-22T11:00:00Z'),
    ).rejects.toBeInstanceOf(GithubGitSyncError);
    await rejection;
    expect(fetcher).not.toHaveBeenCalled();
  });

  // @spec AC-13 EC-24
  it('GAP-9: the malformed full_name error message does not echo the offending value', async () => {
    setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
    const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const mintToken = vi.fn(async () => 'ephemeral-token');
    const event = pullRequestEvent();
    event.repo.full_name = 'a/../../owner/repo';

    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

    await expect(
      adapter.resolveChanges(event, '2026-07-22T11:00:00Z'),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'GithubGitSyncError',
        message: expect.not.stringContaining('a/../../owner/repo'),
      }),
    );
  });

  // @spec AC-13 EC-25
  it.each(['acme/my.repo.js', 'acme/my-repo_2'])(
    'GAP-9: a legitimate repository full_name (%s) still succeeds',
    async (fullName) => {
      setConfigOverrideForTests('GITHUB_API_BASE_URL', 'https://api.github.test');
      const fetcher = vi.fn(async () =>
        new Response(JSON.stringify([{ filename: 'src/a.ts' }]), { status: 200 }),
      );
      const mintToken = vi.fn(async () => 'ephemeral-token');
      const event = pullRequestEvent();
      event.repo.full_name = fullName;

      const adapter = new (GithubProviderAdapter as unknown as new (options: {
        mintToken?: typeof mintToken;
        fetcher?: typeof fetcher;
      }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });

      await expect(
        adapter.resolveChanges(event, '2026-07-22T11:00:00Z'),
      ).resolves.toEqual(expect.objectContaining({ refName: 'refs/heads/main' }));
    },
  );

  // @spec AC-8 EC-16
  it.each([
    { size: 47, commitCount: 20, expected: true, label: 'size greater than inline commit count' },
    { size: 3, commitCount: 3, expected: false, label: 'size matches inline commit count' },
    { size: undefined, commitCount: 20, expected: true, label: 'size absent, 20 inline commits (conservative)' },
  ])('GAP-5: push truncation ($label) sets truncated: $expected', async ({ size, commitCount, expected }) => {
    const mintToken = vi.fn(async () => 'unused');
    const fetcher = vi.fn();
    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });
    const commits = Array.from({ length: commitCount }, (_, index) => ({
      id: `commit-${index}`,
      message: 'change',
      timestamp: '2026-07-22T12:00:00Z',
      author: { name: 'Ada', email: 'ada@example.test' },
      added: [`src/file-${index}.ts`],
      modified: [],
      removed: [],
    }));
    const event: ProviderRepoEvent = {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: '99',
      delivery_id: 'delivery-truncation',
      payload: { commits, ...(size === undefined ? {} : { size }) },
    };

    const changes = await adapter.resolveChanges(event, '2026-07-22T12:00:01Z');

    expect(changes.truncated).toBe(expected);
  });

  // @spec AC-8 EC-17
  it('GAP-5: a forced push sets rebuildRequired: true while still applying the derivable edits', async () => {
    const mintToken = vi.fn(async () => 'unused');
    const fetcher = vi.fn();
    const adapter = new (GithubProviderAdapter as unknown as new (options: {
      mintToken?: typeof mintToken;
      fetcher?: typeof fetcher;
    }) => InstanceType<typeof GithubProviderAdapter>)({ mintToken, fetcher });
    const event: ProviderRepoEvent = {
      provider: 'github',
      type: 'push',
      repo: { provider_repo_id: '42', full_name: 'acme/widgets', repo_id: null },
      ref: 'refs/heads/main',
      installation_id: '99',
      delivery_id: 'delivery-forced',
      payload: {
        forced: true,
        commits: [
          {
            id: 'commit-1',
            message: 'rewrite history',
            timestamp: '2026-07-22T12:00:00Z',
            author: { name: 'Ada', email: 'ada@example.test' },
            added: ['src/a.ts'],
            modified: [],
            removed: [],
          },
        ],
      },
    };

    const changes = await adapter.resolveChanges(event, '2026-07-22T12:00:01Z');

    expect(changes.rebuildRequired).toBe(true);
    expect(changes.edits.map((edit) => edit.path)).toEqual(['src/a.ts']);
  });
});

// W3-04 gapfill (GAP-7). Leading-red coverage for the REAL fakehub adapter module
// (replacing the discard-both-arguments __fixtures__ stand-in). spec.md's Approach step
// 9 pins the payload shapes:
//   pull_request: { action:'merged', pull_request:{ number, title, url, merged_at,
//     merge_commit_sha, base_ref, author:{login,name,email}, files: string[] } }
//   push: { ref, commits:[{ sha, message, timestamp, author, paths:string[] }] }
// and requires both `event`/`occurredAt` arguments to be genuinely used (no
// `void event; void occurredAt;`), with degrade-not-throw handling per EC-21.
//
// Broker-free: pure in-memory normalization.

import { describe, expect, it } from 'vitest';
import type { ProviderRepoEvent } from '../types';

function mergedPrEvent(payload: Record<string, unknown>): ProviderRepoEvent {
  return {
    provider: 'fakehub',
    type: 'pull_request',
    repo: { provider_repo_id: 'fake-1', full_name: 'acme/repo', repo_id: null },
    ref: 'refs/heads/main',
    installation_id: 'fake-installation',
    delivery_id: 'fake-delivery',
    payload,
  };
}

function pushEvent(payload: Record<string, unknown>): ProviderRepoEvent {
  return {
    provider: 'fakehub',
    type: 'push',
    repo: { provider_repo_id: 'fake-1', full_name: 'acme/repo', repo_id: null },
    ref: 'refs/heads/main',
    installation_id: 'fake-installation',
    delivery_id: 'fake-delivery',
    payload,
  };
}

describe('FakeHubProviderAdapter (GAP-7)', () => {
  // @spec AC-11
  it('normalizes a merged pull_request payload into a populated ProviderChangeSet using the real event data', async () => {
    const { FakeHubProviderAdapter } = await import('./fakehub');
    const adapter = new FakeHubProviderAdapter();
    expect(adapter.provider).toBe('fakehub');

    const event = mergedPrEvent({
      action: 'merged',
      pull_request: {
        number: 9,
        title: 'Ship fakehub',
        url: 'https://fakehub.test/pr/9',
        merged_at: '2026-08-01T00:00:00Z',
        merge_commit_sha: 'fake-merge-sha',
        base_ref: 'main',
        author: { login: 'fake-user', name: 'Fake User', email: 'fake@example.test' },
        files: ['src/a.ts', 'src/b.ts'],
      },
    });

    const changes = await adapter.resolveChanges(event, '2026-08-01T00:00:01Z');

    expect(changes.refName).toBe('refs/heads/main');
    expect(changes.edits.map((edit) => edit.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    for (const edit of changes.edits) {
      expect(edit.commitSha).toBe('fake-merge-sha');
      expect(edit.author).toEqual({ login: 'fake-user', name: 'Fake User', email: 'fake@example.test' });
      expect(edit.pullRequest).toMatchObject({
        number: 9,
        title: 'Ship fakehub',
        url: 'https://fakehub.test/pr/9',
        mergedAt: '2026-08-01T00:00:00Z',
      });
    }
  });

  // @spec AC-11
  it('normalizes a push payload into per-path edits derived from each commit', async () => {
    const { FakeHubProviderAdapter } = await import('./fakehub');
    const adapter = new FakeHubProviderAdapter();

    const event = pushEvent({
      ref: 'refs/heads/main',
      commits: [
        {
          sha: 'commit-1',
          message: 'change things',
          timestamp: '2026-08-01T00:00:00Z',
          author: { name: 'Fake User', email: 'fake@example.test', login: 'fake-user' },
          paths: ['src/c.ts'],
        },
      ],
    });

    const changes = await adapter.resolveChanges(event, '2026-08-01T00:00:01Z');

    expect(changes.refName).toBe('refs/heads/main');
    expect(changes.edits).toEqual([
      expect.objectContaining({
        path: 'src/c.ts',
        commitSha: 'commit-1',
        commitMessage: 'change things',
        editedAt: '2026-08-01T00:00:00Z',
      }),
    ]);
  });

  // @spec AC-11
  it('genuinely uses occurredAt as the merged_at fallback rather than discarding the argument', async () => {
    const { FakeHubProviderAdapter } = await import('./fakehub');
    const adapter = new FakeHubProviderAdapter();
    const event = mergedPrEvent({
      action: 'merged',
      pull_request: {
        number: 3,
        title: null,
        url: null,
        merged_at: 'not-a-real-timestamp',
        merge_commit_sha: 'sha-3',
        base_ref: 'main',
        author: { login: null, name: null, email: null },
        files: ['src/only.ts'],
      },
    });

    const changes = await adapter.resolveChanges(event, '2026-08-01T09:30:00Z');

    expect(changes.edits[0]?.pullRequest?.mergedAt).toBe('2026-08-01T09:30:00Z');
  });

  // @spec EC-21
  it('drops a non-string files entry rather than inventing a path', async () => {
    const { FakeHubProviderAdapter } = await import('./fakehub');
    const adapter = new FakeHubProviderAdapter();
    const event = mergedPrEvent({
      action: 'merged',
      pull_request: {
        number: 4,
        title: 'x',
        url: null,
        merged_at: '2026-08-01T00:00:00Z',
        merge_commit_sha: 'sha-4',
        base_ref: 'main',
        author: { login: 'u', name: null, email: null },
        files: ['src/ok.ts', 42, null, ''],
      },
    });

    const changes = await adapter.resolveChanges(event, '2026-08-01T00:00:01Z');

    expect(changes.edits.map((edit) => edit.path)).toEqual(['src/ok.ts']);
  });

  // @spec EC-21
  it('degrades to an empty edit set (never throws) when files is missing or empty', async () => {
    const { FakeHubProviderAdapter } = await import('./fakehub');
    const adapter = new FakeHubProviderAdapter();

    const missingFiles = mergedPrEvent({
      action: 'merged',
      pull_request: {
        number: 5,
        title: null,
        url: null,
        merged_at: '2026-08-01T00:00:00Z',
        merge_commit_sha: 'sha-5',
        base_ref: 'main',
        author: { login: null, name: null, email: null },
      },
    });
    await expect(adapter.resolveChanges(missingFiles, '2026-08-01T00:00:01Z')).resolves.toEqual(
      expect.objectContaining({ edits: [] }),
    );

    const emptyFiles = mergedPrEvent({
      action: 'merged',
      pull_request: {
        number: 6,
        title: null,
        url: null,
        merged_at: '2026-08-01T00:00:00Z',
        merge_commit_sha: 'sha-6',
        base_ref: 'main',
        author: { login: null, name: null, email: null },
        files: [],
      },
    });
    await expect(adapter.resolveChanges(emptyFiles, '2026-08-01T00:00:01Z')).resolves.toEqual(
      expect.objectContaining({ edits: [] }),
    );
  });

  // @spec AC-11
  it('is exported from the git package barrel', async () => {
    const barrel = await import('../index');
    expect(barrel).toHaveProperty('FakeHubProviderAdapter');
  });
});

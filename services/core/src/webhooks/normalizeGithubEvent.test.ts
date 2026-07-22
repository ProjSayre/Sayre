import { describe, expect, it } from 'vitest';
import { MalformedGithubPayloadError, normalizeGithubEvent } from './normalizeGithubEvent';

const INSTALLATION = { id: 12345 };
const REPOSITORY = { id: 999, full_name: 'acme/widgets' };

describe('normalizeGithubEvent', () => {
  it('ignores ping events', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'ping',
      deliveryId: 'd1',
      parsed: { zen: 'hi', hook_id: 1 },
    });
    expect(result).toEqual({ ignored: 'ping' });
  });

  it('ignores events with no installation id', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'd1',
      parsed: { ref: 'refs/heads/main', repository: REPOSITORY },
    });
    expect(result).toEqual({ ignored: 'no_installation' });
  });

  it('ignores events with a non-numeric installation id', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'd1',
      parsed: { installation: { id: 'not-a-number' }, ref: 'refs/heads/main', repository: REPOSITORY },
    });
    expect(result).toEqual({ ignored: 'no_installation' });
  });

  it('normalizes a push event to ingestion+ownership', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'delivery-1',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'refs/heads/main',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        forced: false,
        deleted: false,
        pusher: { name: 'octocat' },
        commits: [
          {
            id: 'sha1',
            message: 'msg',
            timestamp: '2024-01-01T00:00:00Z',
            author: { name: 'A', email: 'a@example.com', username: 'a' },
            added: ['x.ts'],
            modified: [],
            removed: [],
          },
        ],
      },
    });

    expect('ignored' in result).toBe(false);
    if ('ignored' in result) throw new Error('unreachable');
    expect(result.destinations).toEqual(['ingestion', 'ownership']);
    expect(result.event).toMatchObject({
      provider: 'github',
      type: 'push',
      ref: 'refs/heads/main',
      installation_id: '12345',
      delivery_id: 'delivery-1',
      repo: { provider_repo_id: '999', full_name: 'acme/widgets', repo_id: null },
    });
    expect(result.event.payload).toMatchObject({
      forced: false,
      deleted: false,
      ref: 'refs/heads/main',
    });
    expect((result.event.payload.commits as unknown[]).length).toBe(1);
  });

  it('normalizes a branch-deletion push (deleted:true, all-zero after) and still publishes to both', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'delivery-2',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'refs/heads/feature-x',
        before: 'a'.repeat(40),
        after: '0'.repeat(40),
        deleted: true,
        commits: [],
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(result.destinations).toEqual(['ingestion', 'ownership']);
    expect(result.event.payload.deleted).toBe(true);
  });

  it('normalizes a pull_request event to ownership only', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'pull_request',
      deliveryId: 'delivery-3',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        action: 'opened',
        number: 42,
        pull_request: {
          id: 1,
          state: 'open',
          merged: false,
          title: 'Add feature',
          head: { ref: 'feature-x', sha: 'headsha' },
          base: { ref: 'main', sha: 'basesha' },
          user: { login: 'octocat', id: 7 },
        },
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(result.destinations).toEqual(['ownership']);
    expect(result.event.type).toBe('pull_request');
    expect(result.event.ref).toBe('feature-x');
    expect(result.event.payload.pull_request).toMatchObject({
      merged_at: null,
      merge_commit_sha: null,
      html_url: null,
    });
  });

  it('normalizes a pull_request with a null/absent head.ref to ref: null, ownership only', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'pull_request',
      deliveryId: 'delivery-4',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        action: 'closed',
        number: 43,
        pull_request: {
          id: 2,
          state: 'closed',
          merged: true,
          title: 'Deleted fork PR',
          head: {},
          base: { ref: 'main', sha: 'basesha' },
          user: { login: 'octocat', id: 7 },
        },
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(result.event.ref).toBeNull();
    expect(result.destinations).toEqual(['ownership']);
  });

  it('normalizes a branch create event to ingestion+ownership', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'create',
      deliveryId: 'delivery-5',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'feature-y',
        ref_type: 'branch',
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(result.event.type).toBe('branch');
    expect(result.event.ref).toBe('refs/heads/feature-y');
    expect(result.event.payload).toEqual({ action: 'created', ref: 'feature-y', ref_type: 'branch' });
    expect(result.destinations).toEqual(['ingestion', 'ownership']);
  });

  it('normalizes a branch delete event to ingestion+ownership', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'delete',
      deliveryId: 'delivery-6',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'feature-y',
        ref_type: 'branch',
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(result.event.payload).toEqual({ action: 'deleted', ref: 'feature-y', ref_type: 'branch' });
  });

  it('ignores create/delete for a tag ref_type', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'create',
      deliveryId: 'delivery-7',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'v1.0.0',
        ref_type: 'tag',
      },
    });
    expect(result).toEqual({ ignored: 'unsupported_ref_type' });
  });

  it('ignores unsupported event types (e.g. star, issues, workflow_run)', () => {
    for (const githubEvent of ['star', 'issues', 'workflow_run']) {
      const result = normalizeGithubEvent({
        githubEvent,
        deliveryId: 'delivery-8',
        parsed: { installation: INSTALLATION, repository: REPOSITORY },
      });
      expect(result).toEqual({ ignored: 'unsupported_event' });
    }
  });

  it('ignores a push with a missing/blank ref (no_ref)', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'delivery-9',
      parsed: { installation: INSTALLATION, repository: REPOSITORY },
    });
    expect(result).toEqual({ ignored: 'no_ref' });
  });

  it('ignores a branch create with a missing ref (no_ref)', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'create',
      deliveryId: 'delivery-10',
      parsed: { installation: INSTALLATION, repository: REPOSITORY, ref_type: 'branch' },
    });
    expect(result).toEqual({ ignored: 'no_ref' });
  });

  it('throws MalformedGithubPayloadError when repository.id is missing', () => {
    expect(() =>
      normalizeGithubEvent({
        githubEvent: 'push',
        deliveryId: 'delivery-11',
        parsed: { installation: INSTALLATION, ref: 'refs/heads/main', repository: { full_name: 'a/b' } },
      }),
    ).toThrow(MalformedGithubPayloadError);
  });

  it('throws MalformedGithubPayloadError when repository.full_name is missing', () => {
    expect(() =>
      normalizeGithubEvent({
        githubEvent: 'push',
        deliveryId: 'delivery-12',
        parsed: { installation: INSTALLATION, ref: 'refs/heads/main', repository: { id: 1 } },
      }),
    ).toThrow(MalformedGithubPayloadError);
  });

  it('throws MalformedGithubPayloadError when repository is entirely absent', () => {
    expect(() =>
      normalizeGithubEvent({
        githubEvent: 'push',
        deliveryId: 'delivery-13',
        parsed: { installation: INSTALLATION, ref: 'refs/heads/main' },
      }),
    ).toThrow(MalformedGithubPayloadError);
  });

  it('never reads org_id/organization/owner from the payload into the normalized event', () => {
    const result = normalizeGithubEvent({
      githubEvent: 'push',
      deliveryId: 'delivery-14',
      parsed: {
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref: 'refs/heads/main',
        organization: { id: 'forged-org', login: 'forged' },
        org_id: 'forged-org-id',
      },
    });
    if ('ignored' in result) throw new Error('expected a normalized result');
    expect(JSON.stringify(result.event)).not.toContain('forged');
  });
});

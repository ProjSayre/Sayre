// Red-stage (W1-02 gapfill) normalizer-level coverage for AC-2 (push constrained to
// refs/heads/*), AC-3 (installation.id must be a positive safe integer), AC-4
// (repository.full_name must be a clean two-segment owner/name) and the ordering
// invariants those three changes share with the existing classification sequence.
//
// Sibling to normalizeGithubEvent.test.ts, which keeps the pre-gapfill coverage that is
// unaffected by this work.

import { describe, expect, it } from 'vitest';
import { MalformedGithubPayloadError, normalizeGithubEvent } from './normalizeGithubEvent';

const INSTALLATION = { id: 12345 };
const REPOSITORY = { id: 999, full_name: 'acme/widgets' };

function normalizePush(parsed: Record<string, unknown>) {
  return normalizeGithubEvent({ githubEvent: 'push', deliveryId: 'd-gapfill', parsed });
}

describe('normalizeGithubEvent — push refs are constrained to refs/heads/* (AC-2 / GAP-5)', () => {
  // @spec AC-2 EC-5
  it('ignores a push whose ref is a tag ref (refs/tags/v1.0.0) as unsupported_ref_type', () => {
    expect(
      normalizePush({ installation: INSTALLATION, repository: REPOSITORY, ref: 'refs/tags/v1.0.0' }),
    ).toEqual({ ignored: 'unsupported_ref_type' });
  });

  // @spec AC-2 EC-6
  it.each([
    'refs/pull/7/head',
    'refs/pull/7/merge',
    'main',
    'refs/heads/',
    'refs/headsfoo',
    'refs/head/main',
    'refs/remotes/origin/main',
    'refs/notes/commits',
    'refs/tags/refs/heads/main',
    'HEAD',
    '/refs/heads/main',
    'Refs/Heads/main',
  ])('ignores a push whose ref is %j as unsupported_ref_type', (ref) => {
    expect(normalizePush({ installation: INSTALLATION, repository: REPOSITORY, ref })).toEqual({
      ignored: 'unsupported_ref_type',
    });
  });

  // @spec AC-2 EC-7
  it.each(['refs/heads/main', 'refs/heads/feat/a/b', 'refs/heads/release-1.0', 'refs/heads/x'])(
    'still normalizes a push under %s to ingestion+ownership',
    (ref) => {
      const result = normalizePush({
        installation: INSTALLATION,
        repository: REPOSITORY,
        ref,
        commits: [],
      });

      if ('ignored' in result) throw new Error(`expected ${ref} to normalize`);
      expect(result.event.type).toBe('push');
      expect(result.event.ref).toBe(ref);
      expect(result.destinations).toEqual(['ingestion', 'ownership']);
    },
  );

  // The no_ref classification must stay ahead of the new refs/heads/ guard, so a
  // missing ref is still reported as no_ref rather than unsupported_ref_type.
  // @spec AC-2 EC-8
  it.each([undefined, '', null, 0, false])(
    'still classifies a push with ref %j as no_ref, not unsupported_ref_type',
    (ref) => {
      expect(normalizePush({ installation: INSTALLATION, repository: REPOSITORY, ref })).toEqual({
        ignored: 'no_ref',
      });
    },
  );

  // @spec EC-9
  it('leaves create/delete untouched: ref_type branch -> refs/heads/<name>, ownership only', () => {
    for (const githubEvent of ['create', 'delete'] as const) {
      const result = normalizeGithubEvent({
        githubEvent,
        deliveryId: 'd-gapfill',
        parsed: { installation: INSTALLATION, repository: REPOSITORY, ref: 'feature-y', ref_type: 'branch' },
      });
      if ('ignored' in result) throw new Error(`expected ${githubEvent} to normalize`);
      expect(result.event.ref).toBe('refs/heads/feature-y');
      expect(result.destinations).toEqual(['ownership']);
    }
  });

  // @spec EC-9
  it('leaves create/delete for a tag ref_type as unsupported_ref_type', () => {
    for (const githubEvent of ['create', 'delete'] as const) {
      expect(
        normalizeGithubEvent({
          githubEvent,
          deliveryId: 'd-gapfill',
          parsed: { installation: INSTALLATION, repository: REPOSITORY, ref: 'v1.0.0', ref_type: 'tag' },
        }),
      ).toEqual({ ignored: 'unsupported_ref_type' });
    }
  });
});

describe('normalizeGithubEvent — installation.id must be a positive safe integer (AC-3 / GAP-6)', () => {
  // @spec AC-3 EC-10
  it.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['0', 0],
    ['-0', -0],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['2 ** 53 (not a safe integer)', 2 ** 53],
    ['the string "555"', '555'],
    ['null', null],
    ['an object', { id: 555 }],
  ])('classifies installation.id %s as no_installation', (_label, id) => {
    expect(
      normalizePush({ installation: { id }, repository: REPOSITORY, ref: 'refs/heads/main' }),
    ).toEqual({ ignored: 'no_installation' });
  });

  // @spec AC-3 EC-13
  it('accepts Number.MAX_SAFE_INTEGER as an installation id', () => {
    const result = normalizePush({
      installation: { id: Number.MAX_SAFE_INTEGER },
      repository: REPOSITORY,
      ref: 'refs/heads/main',
      commits: [],
    });

    if ('ignored' in result) throw new Error('expected MAX_SAFE_INTEGER to be accepted');
    expect(result.event.installation_id).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  // @spec AC-3
  it('accepts an ordinary positive installation id', () => {
    const result = normalizePush({
      installation: { id: 1 },
      repository: REPOSITORY,
      ref: 'refs/heads/main',
      commits: [],
    });

    if ('ignored' in result) throw new Error('expected 1 to be accepted');
    expect(result.event.installation_id).toBe('1');
  });
});

describe('normalizeGithubEvent — repository.full_name shape (AC-4 / GAP-7)', () => {
  // @spec AC-4 EC-14
  it.each([
    '../../evil',
    '..',
    'a/b/c',
    'owner/',
    '/name',
    'owner//name',
    'owner/na me',
    `${'a'.repeat(300)}/name`,
    'owner',
    'http://evil.example/owner/name',
  ])('throws MalformedGithubPayloadError for full_name %j', (fullName) => {
    expect(() =>
      normalizePush({
        installation: INSTALLATION,
        repository: { id: 999, full_name: fullName },
        ref: 'refs/heads/main',
      }),
    ).toThrow(MalformedGithubPayloadError);
  });

  // @spec AC-4 EC-16
  it.each([[undefined], [''], [42], [null], [{ full: 'owner/name' }]])(
    'still throws MalformedGithubPayloadError for a missing/empty/non-string full_name %j',
    (fullName) => {
      expect(() =>
        normalizePush({
          installation: INSTALLATION,
          repository: { id: 999, full_name: fullName },
          ref: 'refs/heads/main',
        }),
      ).toThrow(MalformedGithubPayloadError);
    },
  );

  // @spec AC-4 EC-15
  it.each(['acme-corp/widgets', 'a.b/c_d-e.f', 'A_1/x.y-z', 'octocat/Hello-World'])(
    'normalizes the legal full_name %s without change',
    (fullName) => {
      const result = normalizePush({
        installation: INSTALLATION,
        repository: { id: 999, full_name: fullName },
        ref: 'refs/heads/main',
        commits: [],
      });

      if ('ignored' in result) throw new Error(`expected ${fullName} to normalize`);
      expect(result.event.repo).toEqual({
        provider_repo_id: '999',
        full_name: fullName,
        repo_id: null,
      });
    },
  );

  // Ordering: ignore-classification still runs BEFORE extractRepo, so an event that was
  // going to be ignored anyway stays a 2xx ignore even with a hostile full_name — the
  // new validator must not turn an ignore into a 400.
  // @spec AC-2 AC-4
  it('still ignores a tag push carrying a malformed full_name rather than throwing', () => {
    expect(
      normalizePush({
        installation: INSTALLATION,
        repository: { id: 999, full_name: '../../evil' },
        ref: 'refs/tags/v1.0.0',
      }),
    ).toEqual({ ignored: 'unsupported_ref_type' });
  });

  // @spec AC-3 AC-4
  it('still ignores a malformed-installation push carrying a malformed full_name', () => {
    expect(
      normalizePush({
        installation: { id: Number.NaN },
        repository: { id: 999, full_name: '../../evil' },
        ref: 'refs/heads/main',
      }),
    ).toEqual({ ignored: 'no_installation' });
  });
});

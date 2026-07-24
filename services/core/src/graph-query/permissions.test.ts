import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import {
  PostgresPermissionStore,
  canReadResource,
  intersectReadScopes,
  isRuleWithinScope,
  permissionSubjects,
  scopeFromRows,
} from './permissions';

const MEMBER: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: '11111111-1111-4111-8111-111111111111',
  roles: ['member'],
};

describe('permission scope resolution', () => {
  it('combines direct-user and role subjects without trusting client input', () => {
    expect(permissionSubjects(MEMBER)).toEqual([
      { type: 'user', id: 'user-1' },
      { type: 'role', id: 'member' },
    ]);
  });

  it('keeps an agent key on its direct grants so role rows cannot widen key scope', () => {
    expect(
      permissionSubjects({
        subjectType: 'agent_key',
        agentKeyId: 'sayre_key_1',
        orgId: MEMBER.orgId,
        roles: ['admin'],
      }),
    ).toEqual([{ type: 'agent_key', id: 'sayre_key_1' }]);
  });

  it('normalizes branch/path rows and treats unknown effects as deny', () => {
    expect(
      scopeFromRows([
        { repoId: 'repo-1', branch: 'main', pathPrefix: 'src/public/', effect: 'allow' },
        { repoId: 'repo-1', branch: null, pathPrefix: '/src/private', effect: 'unexpected' },
      ]),
    ).toEqual({
      allows: [{ repoId: 'repo-1', branch: 'refs/heads/main', pathPrefix: 'src/public' }],
      denies: [{ repoId: 'repo-1', branch: null, pathPrefix: 'src/private' }],
    });
  });

  it('applies a relative-path deny beneath a broad allow', () => {
    const scope = scopeFromRows([
      { repoId: 'repo-1', branch: null, pathPrefix: null, effect: 'allow' },
      { repoId: 'repo-1', branch: null, pathPrefix: 'src/private', effect: 'deny' },
    ]);
    const resource = (path: string) => ({ repoId: 'repo-1', refName: 'refs/heads/main', path });

    expect(canReadResource(scope, resource('src/public/a.ts'))).toBe(true);
    expect(canReadResource(scope, resource('src/private/secret.ts'))).toBe(false);
    expect(canReadResource(scope, resource('src/privateer/not-secret.ts'))).toBe(true);
  });

  it('includes only canonical relative paths beneath a scoped allow', () => {
    const scope = scopeFromRows([
      { repoId: 'repo-1', branch: 'main', pathPrefix: '/src/public/', effect: 'allow' },
    ]);
    const resource = (path: string) => ({ repoId: 'repo-1', refName: 'refs/heads/main', path });

    expect(canReadResource(scope, resource('src/public'))).toBe(true);
    expect(canReadResource(scope, resource('src/public/a.ts'))).toBe(true);
    expect(canReadResource(scope, resource('src/private/a.ts'))).toBe(false);
    expect(canReadResource(scope, resource('/src/public/a.ts'))).toBe(false);
    expect(canReadResource(scope, resource('src/public/../private/a.ts'))).toBe(false);
  });

  it('preserves root semantics and repo/ref boundaries', () => {
    const rootScope = scopeFromRows([
      { repoId: 'repo-1', branch: 'main', pathPrefix: '/', effect: 'allow' },
    ]);
    const scoped = scopeFromRows([
      { repoId: 'repo-1', branch: 'main', pathPrefix: 'src', effect: 'allow' },
    ]);
    const root = { repoId: 'repo-1', refName: 'refs/heads/main', path: '' };

    expect(canReadResource(rootScope, root)).toBe(true);
    expect(canReadResource(rootScope, { ...root, path: 'src/a.ts' })).toBe(true);
    expect(canReadResource(scoped, root)).toBe(false);
    expect(canReadResource(rootScope, { ...root, repoId: 'repo-2' })).toBe(false);
    expect(
      canReadResource(rootScope, { ...root, refName: 'refs/heads/release' }),
    ).toBe(false);
  });

  it('fails closed when persisted permission paths are malformed', () => {
    expect(
      scopeFromRows([
        { repoId: 'repo-1', branch: null, pathPrefix: '../private', effect: 'allow' },
        { repoId: 'repo-1', branch: null, pathPrefix: 'src/../private', effect: 'deny' },
      ]),
    ).toEqual({
      allows: [],
      denies: [{ repoId: 'repo-1', branch: null, pathPrefix: null }],
    });
  });

  it('intersects an agent-key ceiling with the issuer current scope', () => {
    expect(
      intersectReadScopes(
        {
          allows: [
            { repoId: 'repo-1', branch: null, pathPrefix: 'src' },
          ],
          denies: [],
        },
        {
          allows: [
            {
              repoId: 'repo-1',
              branch: 'refs/heads/main',
              pathPrefix: 'src/public',
            },
          ],
          denies: [
            {
              repoId: 'repo-1',
              branch: null,
              pathPrefix: 'src/public/secrets',
            },
          ],
        },
      ),
    ).toEqual({
      allows: [
        {
          repoId: 'repo-1',
          branch: 'refs/heads/main',
          pathPrefix: 'src/public',
        },
      ],
      denies: [
        {
          repoId: 'repo-1',
          branch: null,
          pathPrefix: 'src/public/secrets',
        },
      ],
    });
  });

  it('rejects an issuance rule broader than, or overlapping a deny in, current scope', () => {
    const scope = {
      allows: [
        {
          repoId: 'repo-1',
          branch: 'refs/heads/main',
          pathPrefix: 'src',
        },
      ],
      denies: [
        {
          repoId: 'repo-1',
          branch: 'refs/heads/main',
          pathPrefix: 'src/private',
        },
      ],
    };
    expect(
      isRuleWithinScope(
        {
          repoId: 'repo-1',
          branch: 'main',
          pathPrefix: '/src/public',
        },
        scope,
      ),
    ).toBe(true);
    expect(
      isRuleWithinScope(
        { repoId: 'repo-1', branch: null, pathPrefix: '/src' },
        scope,
      ),
    ).toBe(false);
    expect(
      isRuleWithinScope(
        {
          repoId: 'repo-1',
          branch: 'main',
          pathPrefix: '/src/private',
        },
        scope,
      ),
    ).toBe(false);
    expect(
      isRuleWithinScope(
        {
          repoId: 'repo-1',
          branch: 'main',
          pathPrefix: 'src/../private',
        },
        scope,
      ),
    ).toBe(false);
  });

  it('grants a user owner tenant-wide access without querying Postgres', async () => {
    const database = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const store = new PostgresPermissionStore(database as never);

    await expect(
      store.getReadScope({ ...MEMBER, roles: ['owner'] }, 'not-even-a-uuid'),
    ).resolves.toEqual({
      allows: [{ repoId: null, branch: null, pathPrefix: null }],
      denies: [],
    });
    expect(database).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed repository id before touching Postgres', async () => {
    const database = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const store = new PostgresPermissionStore(database as never);

    await expect(store.getReadScope(MEMBER, 'repo-from-client')).resolves.toEqual({
      allows: [],
      denies: [],
    });
    expect(database).not.toHaveBeenCalled();
  });
});

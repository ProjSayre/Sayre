import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { PermissionStore, ReadScope } from '../graph-query/permissions';
import {
  getProviderJobState,
  parseProviderJobStateQuery,
  ProviderJobStateAccessDeniedError,
  ProviderJobStateInputError,
  type ProviderJobStateReader,
} from './providerJobStateService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const REF = 'refs/heads/main';
const AUTH: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: ORG_ID,
  roles: ['member'],
};

function dependencies(scope: ReadScope, row: Parameters<ProviderJobStateReader['find']> extends never ? never : object | null) {
  const permissions: PermissionStore = {
    getReadScope: vi.fn(async () => scope),
  };
  const states: ProviderJobStateReader = {
    find: vi.fn(async () => row as Awaited<ReturnType<ProviderJobStateReader['find']>>),
  };
  return { permissions, states };
}

const DEGRADED_ROW = {
  repositoryId: REPO_ID,
  refName: REF,
  revisionSha: 'a'.repeat(40),
  surface: 'product',
  status: 'degraded',
  reasonCode: 'timeout',
  updatedAt: new Date('2026-07-22T04:00:00.000Z'),
};

describe('providerJobStateService', () => {
  it('returns only the sanitized state contract under the server-derived org', async () => {
    const deps = dependencies(
      { allows: [{ repoId: REPO_ID, branch: REF, pathPrefix: null }], denies: [] },
      DEGRADED_ROW,
    );

    const state = await getProviderJobState(
      REPO_ID,
      { refName: REF, surface: 'product' },
      AUTH,
      deps,
    );

    expect(state).toEqual({
      repositoryId: REPO_ID,
      refName: REF,
      revisionSha: 'a'.repeat(40),
      surface: 'product',
      status: 'degraded',
      reasonCode: 'timeout',
      updatedAt: '2026-07-22T04:00:00.000Z',
    });
    expect(deps.states.find).toHaveBeenCalledWith(ORG_ID, REPO_ID, REF, 'product');
    expect(JSON.stringify(state)).not.toMatch(/orgId|provider|model|endpoint|prompt|errorText/);
  });

  it('returns null when an authorized scope has no state row', async () => {
    const deps = dependencies(
      { allows: [{ repoId: null, branch: null, pathPrefix: null }], denies: [] },
      null,
    );
    await expect(
      getProviderJobState(REPO_ID, { refName: REF, surface: 'product' }, AUTH, deps),
    ).resolves.toBeNull();
  });

  it('fails closed before reading state when no allow or a matching deny wins', async () => {
    for (const scope of [
      { allows: [], denies: [] },
      {
        allows: [{ repoId: REPO_ID, branch: REF, pathPrefix: 'src' }],
        denies: [{ repoId: REPO_ID, branch: REF, pathPrefix: 'src' }],
      },
      {
        allows: [{ repoId: REPO_ID, branch: 'refs/heads/other', pathPrefix: null }],
        denies: [],
      },
    ] satisfies ReadScope[]) {
      const deps = dependencies(scope, DEGRADED_ROW);
      await expect(
        getProviderJobState(REPO_ID, { refName: REF, surface: 'product' }, AUTH, deps),
      ).rejects.toBeInstanceOf(ProviderJobStateAccessDeniedError);
      expect(deps.states.find).not.toHaveBeenCalled();
    }
  });

  it('accepts a surviving path-scoped grant without exposing graph paths', async () => {
    const deps = dependencies(
      {
        allows: [{ repoId: REPO_ID, branch: REF, pathPrefix: 'src' }],
        denies: [{ repoId: REPO_ID, branch: REF, pathPrefix: 'src/private' }],
      },
      DEGRADED_ROW,
    );
    await expect(
      getProviderJobState(REPO_ID, { refName: REF, surface: 'product' }, AUTH, deps),
    ).resolves.toMatchObject({ status: 'degraded' });
  });

  it('rejects malformed repo/ref/surface and impossible persisted enums', async () => {
    const deps = dependencies(
      { allows: [{ repoId: null, branch: null, pathPrefix: null }], denies: [] },
      { ...DEGRADED_ROW, status: 'raw-provider-error' },
    );
    await expect(
      getProviderJobState('not-a-uuid', { refName: REF, surface: 'product' }, AUTH, deps),
    ).rejects.toBeInstanceOf(ProviderJobStateInputError);
    expect(() => parseProviderJobStateQuery({ refName: '', surface: 'product' })).toThrow(
      ProviderJobStateInputError,
    );
    expect(() => parseProviderJobStateQuery({ refName: REF, surface: ['product'] })).toThrow(
      ProviderJobStateInputError,
    );
    await expect(
      getProviderJobState(REPO_ID, { refName: REF, surface: 'product' }, AUTH, deps),
    ).rejects.toThrow('invalid provider state');
  });

  it('fails closed when a state reader returns a different repo, ref, or surface', async () => {
    for (const row of [
      { ...DEGRADED_ROW, repositoryId: '33333333-3333-4333-8333-333333333333' },
      { ...DEGRADED_ROW, refName: 'refs/heads/other' },
      { ...DEGRADED_ROW, surface: 'onboarding' },
    ]) {
      const deps = dependencies(
        { allows: [{ repoId: null, branch: null, pathPrefix: null }], denies: [] },
        row,
      );
      await expect(
        getProviderJobState(REPO_ID, { refName: REF, surface: 'product' }, AUTH, deps),
      ).rejects.toThrow('invalid provider state');
    }
  });
});

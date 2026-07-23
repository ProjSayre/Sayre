import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore, ReadScope } from './permissions';
import {
  GET_NODES_IN_VIEWPORT_CYPHER,
  RbacGraphQueryService,
} from './index';

const VIEWPORT = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

function user(userId: string): AuthContext {
  return { subjectType: 'user', userId, orgId: ORG_ID, roles: ['member'] };
}

function record(values: Record<string, unknown>): GraphReadRecord {
  return { get: (key) => values[key] };
}

function nodeRecord(
  id: string,
  label: string,
  path: string,
  parent?: { id: string; path: string },
): GraphReadRecord {
  return record({
    id,
    label,
    name: path.split('/').at(-1),
    path,
    repo_id: REPO_ID,
    ref_name: 'refs/heads/main',
    parent_id: parent?.id ?? null,
    parent_path: parent?.path ?? null,
    parent_repo_id: parent ? REPO_ID : null,
    parent_ref_name: parent ? 'refs/heads/main' : null,
  });
}

class QueueExecutor implements GraphReadExecutor {
  readonly run = vi.fn(async () => ({ records: this.results.shift() ?? [] }));
  readonly close = vi.fn(async () => undefined);

  constructor(private readonly results: GraphReadRecord[][]) {}
}

class UserPermissionStore implements PermissionStore {
  constructor(private readonly scopes: Record<string, ReadScope>) {}

  async getReadScope(ctx: AuthContext): Promise<ReadScope> {
    const id = ctx.subjectType === 'user' ? ctx.userId : ctx.agentKeyId;
    return this.scopes[id] ?? { allows: [], denies: [] };
  }
}

const publicScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: 'refs/heads/main', pathPrefix: '/src/public' }],
  denies: [],
};
const privateScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: 'refs/heads/main', pathPrefix: '/src/private' }],
  denies: [],
};

describe('RbacGraphQueryService', () => {
  it('never returns a Folder outside either user scope on the same repo (W2-02 acceptance)', async () => {
    const allRecords = [
      nodeRecord('public-folder', 'Folder', '/src/public', { id: 'src', path: '/src' }),
      nodeRecord('public-file', 'File', '/src/public/index.ts', { id: 'public-folder', path: '/src/public' }),
      nodeRecord('private-folder', 'Folder', '/src/private', { id: 'src', path: '/src' }),
      nodeRecord('private-file', 'File', '/src/private/secret.ts', { id: 'private-folder', path: '/src/private' }),
    ];
    const executor = new QueueExecutor([[...allRecords], [...allRecords]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope, bob: privateScope }),
    );

    const aliceNodes = await service.getNodesInViewport(REPO_ID, VIEWPORT, user('alice'));
    const bobNodes = await service.getNodesInViewport(REPO_ID, VIEWPORT, user('bob'));

    expect(aliceNodes.map((node) => node.id)).toEqual(['public-folder', 'public-file']);
    expect(bobNodes.map((node) => node.id)).toEqual(['private-folder', 'private-file']);
    expect(aliceNodes.some((node) => node.id === 'private-folder')).toBe(false);
    expect(bobNodes.some((node) => node.id === 'public-folder')).toBe(false);
    // A hidden ancestor id is stripped rather than leaked as parentId.
    expect(aliceNodes[0]?.parentId).toBeNull();
  });

  it('injects server auth scope and viewport bounds into a parameterized Cypher query', async () => {
    const executor = new QueueExecutor([[]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await service.getNodesInViewport(REPO_ID, { ...VIEWPORT, zoom: 2 }, user('alice'));

    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'viewport_read',
      GET_NODES_IN_VIEWPORT_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        repo_id: REPO_ID,
        viewport_max_x: 50,
        viewport_max_y: 50,
        allow_rules: [
          { repo_id: REPO_ID, branch: 'refs/heads/main', path_prefix: '/src/public' },
        ],
      }),
    );
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('NOT ANY(rule IN $deny_rules');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).not.toContain(ORG_ID);
  });

  it('drops non-canvas labels even if a graph adapter returns one', async () => {
    const executor = new QueueExecutor([
      [nodeRecord('function-1', 'Function', '/src/public/index.ts')],
    ]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, VIEWPORT, user('alice')),
    ).resolves.toEqual([]);
  });

  it('returns only edges whose two endpoints are requested and authorized', async () => {
    const executor = new QueueExecutor([[
      record({
        type: 'IMPORTS',
        source_id: 'public-a',
        source_path: '/src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: 'refs/heads/main',
        target_id: 'public-b',
        target_path: '/src/public/b.ts',
        target_repo_id: REPO_ID,
        target_ref_name: 'refs/heads/main',
      }),
      record({
        type: 'IMPORTS',
        source_id: 'public-a',
        source_path: '/src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: 'refs/heads/main',
        target_id: 'private-secret',
        target_path: '/src/private/secret.ts',
        target_repo_id: REPO_ID,
        target_ref_name: 'refs/heads/main',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getStructuralEdges(['public-a', 'public-b', 'private-secret'], user('alice')),
    ).resolves.toEqual([
      {
        id: 'IMPORTS:public-a:public-b',
        type: 'IMPORTS',
        source: 'public-a',
        target: 'public-b',
      },
    ]);
  });

  it('fails closed without an allow and does not contact the graph store', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(executor, new UserPermissionStore({}));

    await expect(
      service.getNodesInViewport(REPO_ID, VIEWPORT, user('nobody')),
    ).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('does not infer itemized removals from paths the subject cannot see', async () => {
    const executor = new QueueExecutor([[]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getAffectedNodes(
        REPO_ID,
        ['/src/public/deleted.ts', '/src/private/secret.ts'],
        user('alice'),
      ),
    ).resolves.toEqual({ visible: [], removed: [] });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore, ReadScope } from './permissions';
import {
  GET_FEATURE_CLUSTERS_CYPHER,
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

function featureRecord(
  memberId: string,
  memberPath: string,
  overrides: Record<string, unknown> = {},
): GraphReadRecord {
  return record({
    root_org_id: ORG_ID,
    current_revision_sha: 'a'.repeat(40),
    feature_org_id: ORG_ID,
    feature_repo_id: REPO_ID,
    feature_ref_name: 'refs/heads/main',
    feature_revision_sha: 'a'.repeat(40),
    feature_id: 'feature-checkout',
    feature_name: 'Checkout',
    feature_description: 'Completes checkout across the stack.',
    feature_team: 'Commerce',
    membership_org_id: ORG_ID,
    member_org_id: ORG_ID,
    member_repo_id: REPO_ID,
    member_ref_name: 'refs/heads/main',
    member_revision_sha: 'a'.repeat(40),
    member_id: memberId,
    member_label: 'File',
    member_name: memberPath.split('/').at(-1),
    member_path: memberPath,
    member_last_edited_at: '2026-07-22T12:00:00Z',
    member_editor_name: 'Ada',
    member_editor_login: 'ada',
    member_recent_pr_title: 'Ship checkout',
    member_recent_pr_url: 'https://example.test/pull/17',
    ...overrides,
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

  it('returns only current-head Feature members authorized for the caller', async () => {
    const executor = new QueueExecutor([[
      featureRecord('public-file', '/src/public/checkout.ts'),
      featureRecord('private-file', '/src/private/secret.ts'),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getFeatureClusters(REPO_ID, 'refs/heads/main', user('alice')),
    ).resolves.toEqual([
      {
        id: 'feature-checkout',
        name: 'Checkout',
        description: 'Completes checkout across the stack.',
        team: 'Commerce',
        revisionSha: 'a'.repeat(40),
        members: [{
          id: 'public-file',
          label: 'File',
          name: 'checkout.ts',
          path: '/src/public/checkout.ts',
          parentId: null,
          recentEdit: {
            fileId: 'public-file',
            filePath: '/src/public/checkout.ts',
            editedAt: '2026-07-22T12:00:00Z',
            editorName: 'Ada',
            editorLogin: 'ada',
            pullRequestTitle: 'Ship checkout',
            pullRequestUrl: 'https://example.test/pull/17',
          },
        }],
      },
    ]);

    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      GET_FEATURE_CLUSTERS_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        repo_id: REPO_ID,
        ref_name: 'refs/heads/main',
        allow_rules: [{
          repo_id: REPO_ID,
          branch: 'refs/heads/main',
          path_prefix: '/src/public',
        }],
      }),
    );
    expect(GET_FEATURE_CLUSTERS_CYPHER).toContain(
      'feature.revision_sha = root.revision_sha',
    );
    expect(GET_FEATURE_CLUSTERS_CYPHER).toContain(
      'member.revision_sha = root.revision_sha',
    );
    expect(GET_FEATURE_CLUSTERS_CYPHER).toContain('membership.org_id = $org_id');
    expect(GET_FEATURE_CLUSTERS_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(GET_FEATURE_CLUSTERS_CYPHER).toContain('NOT ANY(rule IN $deny_rules');
    expect(GET_FEATURE_CLUSTERS_CYPHER).not.toContain(ORG_ID);
  });

  it('defensively drops stale or cross-tenant Feature membership rows', async () => {
    const executor = new QueueExecutor([[
      featureRecord('stale-feature', '/src/public/stale-feature.ts', {
        feature_revision_sha: 'b'.repeat(40),
      }),
      featureRecord('stale-member', '/src/public/stale-member.ts', {
        member_revision_sha: 'b'.repeat(40),
      }),
      featureRecord('foreign-membership', '/src/public/foreign.ts', {
        membership_org_id: '22222222-2222-4222-8222-222222222222',
      }),
      featureRecord('wrong-ref', '/src/public/wrong-ref.ts', {
        feature_ref_name: 'refs/heads/other',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getFeatureClusters(REPO_ID, 'refs/heads/main', user('alice')),
    ).resolves.toEqual([]);
  });

  it('keeps a visible Feature with missing optional metadata and discards malformed edit data', async () => {
    const executor = new QueueExecutor([[
      featureRecord('public-file', '/src/public/checkout.ts', {
        feature_description: null,
        feature_team: ' ',
        member_last_edited_at: 'not-a-date',
        member_recent_pr_url: 'javascript:alert(1)',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    const result = await service.getFeatureClusters(
      REPO_ID,
      'refs/heads/main',
      user('alice'),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      description: null,
      team: null,
      members: [{ recentEdit: null }],
    });
  });

  it('does not query Feature membership when the caller has no allow rule', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(executor, new UserPermissionStore({}));

    await expect(
      service.getFeatureClusters(REPO_ID, 'refs/heads/main', user('nobody')),
    ).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
  });
});

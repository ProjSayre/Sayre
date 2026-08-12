import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore, ReadScope } from './permissions';
import {
  CHAT_CITATION_NODE_ID_LIMIT,
  GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER,
  GET_FEATURE_CLUSTERS_CYPHER,
  GET_NODE_OVERLAY_CYPHER,
  GET_NODES_IN_VIEWPORT_CYPHER,
  GET_STRUCTURAL_EDGES_CYPHER,
  GET_ONBOARDING_CANVAS_NODES_CYPHER,
  GET_ONBOARDING_STEPS_CYPHER,
  RESOLVE_RETRIEVAL_ANCHORS_CYPHER,
  RbacGraphQueryService,
  TRAVERSE_RETRIEVAL_CONTEXT_CYPHER,
} from './index';

const VIEWPORT = { x: 0, y: 0, width: 100, height: 100, zoom: 1 };
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REF_NAME = 'refs/heads/main';

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
  overrides: Record<string, unknown> = {},
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
    node_last_edited_at: null,
    node_last_structural_change_at: null,
    coverage_test_status: null,
    coverage_edge_status: null,
    coverage_last_run: null,
    ...overrides,
  });
}

function retrievalRecord(
  id: string,
  path: string,
  distance = 0,
  overrides: Record<string, unknown> = {},
): GraphReadRecord {
  return record({
    id,
    label: 'File',
    name: path.split('/').at(-1),
    path,
    org_id: ORG_ID,
    repo_id: REPO_ID,
    ref_name: 'refs/heads/main',
    revision_sha: 'a'.repeat(40),
    distance,
    ...overrides,
  });
}

function traversalRecord(
  id: string,
  path: string,
  distance: number,
  overrides: Record<string, unknown> = {},
): GraphReadRecord {
  return record({
    anchor_id: 'anchor',
    anchor_label: 'File',
    anchor_name: 'anchor.ts',
    anchor_path: 'src/public/anchor.ts',
    anchor_org_id: ORG_ID,
    anchor_repo_id: REPO_ID,
    anchor_ref_name: 'refs/heads/main',
    anchor_revision_sha: 'a'.repeat(40),
    id,
    label: 'File',
    name: path.split('/').at(-1),
    path,
    org_id: ORG_ID,
    repo_id: REPO_ID,
    ref_name: 'refs/heads/main',
    revision_sha: 'a'.repeat(40),
    distance,
    ...overrides,
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

function overlayRecord(
  overrides: Record<string, unknown> = {},
): GraphReadRecord {
  return record({
    target_id: 'public-file',
    target_label: 'File',
    target_name: 'index.ts',
    target_path: 'src/public/index.ts',
    target_org_id: ORG_ID,
    target_repo_id: REPO_ID,
    target_ref_name: 'refs/heads/main',
    target_revision_sha: 'a'.repeat(40),
    target_description: 'Public entrypoint.',
    out_dependency_id: 'public-dependency',
    out_dependency_label: 'File',
    out_dependency_name: 'dependency.ts',
    out_dependency_path: 'src/public/dependency.ts',
    out_dependency_org_id: ORG_ID,
    out_dependency_repo_id: REPO_ID,
    out_dependency_ref_name: 'refs/heads/main',
    out_dependency_revision_sha: 'a'.repeat(40),
    in_dependency_id: null,
    in_dependency_label: null,
    in_dependency_name: null,
    in_dependency_path: null,
    in_dependency_org_id: null,
    in_dependency_repo_id: null,
    in_dependency_ref_name: null,
    in_dependency_revision_sha: null,
    commit_id: 'commit-1',
    commit_org_id: ORG_ID,
    commit_repository_id: REPO_ID,
    commit_ref_name: 'refs/heads/main',
    commit_sha: 'b'.repeat(40),
    commit_message: 'Update entrypoint',
    commit_timestamp: '2026-07-23T12:00:00Z',
    author_name: 'Ada',
    author_login: 'ada',
    author_org_id: ORG_ID,
    authored_org_id: ORG_ID,
    modified_org_id: ORG_ID,
    recent_pr_title: 'Update entrypoint',
    recent_pr_url: 'https://example.test/pull/42',
    feature_id: 'feature-checkout',
    feature_name: 'Checkout',
    feature_description: 'Completes checkout.',
    feature_team: 'Commerce',
    feature_org_id: ORG_ID,
    feature_repo_id: REPO_ID,
    feature_ref_name: 'refs/heads/main',
    feature_revision_sha: 'a'.repeat(40),
    membership_org_id: ORG_ID,
    ticket_id: 'ticket-pay-42',
    ticket_external_id: 'PAY-42',
    ticket_system: 'jira',
    ticket_title: 'Fix checkout',
    ticket_status: 'Open',
    ticket_url: 'https://example.test/PAY-42',
    ticket_org_id: ORG_ID,
    ticket_repo_id: REPO_ID,
    ticket_ref_name: 'refs/heads/main',
    reference_org_id: ORG_ID,
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
  allows: [{ repoId: REPO_ID, branch: 'refs/heads/main', pathPrefix: 'src/public' }],
  denies: [],
};
const privateScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: 'refs/heads/main', pathPrefix: 'src/private' }],
  denies: [],
};
const repositoryScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: 'refs/heads/main', pathPrefix: null }],
  denies: [],
};

describe('RbacGraphQueryService', () => {
  it('never returns a Folder outside either user scope on the same repo (W2-02 acceptance)', async () => {
    const allRecords = [
      nodeRecord('public-folder', 'Folder', 'src/public', { id: 'src', path: 'src' }),
      nodeRecord('public-file', 'File', 'src/public/index.ts', { id: 'public-folder', path: 'src/public' }),
      nodeRecord('private-folder', 'Folder', 'src/private', { id: 'src', path: 'src' }),
      nodeRecord('private-file', 'File', 'src/private/secret.ts', { id: 'private-folder', path: 'src/private' }),
    ];
    const executor = new QueueExecutor([[...allRecords], [...allRecords]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope, bob: privateScope }),
    );

    const aliceNodes = await service.getNodesInViewport(
      REPO_ID,
      REF_NAME,
      VIEWPORT,
      user('alice'),
    );
    const bobNodes = await service.getNodesInViewport(
      REPO_ID,
      REF_NAME,
      VIEWPORT,
      user('bob'),
    );

    expect(aliceNodes.map((node) => node.id)).toEqual(['public-folder', 'public-file']);
    expect(bobNodes.map((node) => node.id)).toEqual(['private-folder', 'private-file']);
    expect(aliceNodes.some((node) => node.id === 'private-folder')).toBe(false);
    expect(bobNodes.some((node) => node.id === 'public-folder')).toBe(false);
    // A hidden ancestor id is stripped rather than leaked as parentId.
    expect(aliceNodes[0]?.parentId).toBeNull();
  });

  it('enforces a relative private-path deny beneath a repository-wide allow', async () => {
    const scope: ReadScope = {
      allows: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: null }],
      denies: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: 'src/private' }],
    };
    const executor = new QueueExecutor([[
      nodeRecord('public-file', 'File', 'src/public/index.ts'),
      nodeRecord('private-file', 'File', 'src/private/secret.ts'),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: scope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, REF_NAME, VIEWPORT, user('alice')),
    ).resolves.toEqual([
      {
        id: 'public-file',
        label: 'File',
        name: 'index.ts',
        path: 'src/public/index.ts',
        parentId: null,
        coverage: {
          status: 'unknown',
          lastRun: null,
          coveringTests: 0,
        },
      },
    ]);
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'viewport_read',
      GET_NODES_IN_VIEWPORT_CYPHER,
      expect.objectContaining({
        allow_rules: [
          { repo_id: REPO_ID, branch: REF_NAME, path_prefix: null },
        ],
        deny_rules: [
          {
            repo_id: REPO_ID,
            branch: REF_NAME,
            path_prefix: 'src/private',
          },
        ],
      }),
    );
  });

  it('maps the canonical empty root path and rejects malformed graph paths', async () => {
    const scope: ReadScope = {
      allows: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: null }],
      denies: [],
    };
    const executor = new QueueExecutor([[
      record({
        id: 'root',
        label: 'Folder',
        name: 'repository',
        path: '',
        repo_id: REPO_ID,
        ref_name: REF_NAME,
        parent_id: null,
        parent_path: null,
        parent_repo_id: null,
        parent_ref_name: null,
      }),
      nodeRecord('leading-slash', 'File', '/src/private/secret.ts'),
      nodeRecord('traversal', 'File', 'src/public/../private/secret.ts'),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: scope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, REF_NAME, VIEWPORT, user('alice')),
    ).resolves.toEqual([
      {
        id: 'root',
        label: 'Folder',
        name: 'repository',
        path: '',
        parentId: null,
      },
    ]);
  });

  it('injects server auth scope and viewport bounds into a parameterized Cypher query', async () => {
    const executor = new QueueExecutor([[]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await service.getNodesInViewport(
      REPO_ID,
      REF_NAME,
      { ...VIEWPORT, zoom: 2 },
      user('alice'),
    );

    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'viewport_read',
      GET_NODES_IN_VIEWPORT_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        repo_id: REPO_ID,
        ref_name: REF_NAME,
        viewport_max_x: 50,
        viewport_max_y: 50,
        allow_rules: [
          { repo_id: REPO_ID, branch: 'refs/heads/main', path_prefix: 'src/public' },
        ],
      }),
    );
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('NOT ANY(rule IN $deny_rules');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain(
      'node.ref_name = $ref_name',
    );
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain(
      'parent.ref_name = $ref_name',
    );
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('coverage:COVERS');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).toContain('test.org_id = $org_id');
    expect(GET_NODES_IN_VIEWPORT_CYPHER).not.toContain(ORG_ID);
  });

  it('drops cross-ref nodes and parents even when a broad permission scope and adapter return them', async () => {
    const broadScope: ReadScope = {
      allows: [{ repoId: REPO_ID, branch: null, pathPrefix: 'src/public' }],
      denies: [],
    };
    const executor = new QueueExecutor([[
      record({
        id: 'main-file',
        label: 'File',
        name: 'main.ts',
        path: 'src/public/main.ts',
        repo_id: REPO_ID,
        ref_name: REF_NAME,
        parent_id: 'other-ref-parent',
        parent_path: 'src/public',
        parent_repo_id: REPO_ID,
        parent_ref_name: 'refs/heads/other',
      }),
      record({
        id: 'other-file',
        label: 'File',
        name: 'other.ts',
        path: 'src/public/other.ts',
        repo_id: REPO_ID,
        ref_name: 'refs/heads/other',
        parent_id: null,
        parent_path: null,
        parent_repo_id: null,
        parent_ref_name: null,
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: broadScope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, REF_NAME, VIEWPORT, user('alice')),
    ).resolves.toEqual([
      {
        id: 'main-file',
        label: 'File',
        name: 'main.ts',
        path: 'src/public/main.ts',
        parentId: null,
        coverage: {
          status: 'unknown',
          lastRun: null,
          coveringTests: 0,
        },
      },
    ]);
  });

  it('returns pass, stale-after-code-edit, and fail coverage badges without Test nodes', async () => {
    const parent = { id: 'public-folder', path: 'src/public' };
    const executor = new QueueExecutor([[
      nodeRecord('fresh-file', 'File', 'src/public/fresh.ts', parent, {
        node_last_edited_at: '2026-07-23T10:00:00Z',
        coverage_test_status: 'pass',
        coverage_edge_status: 'measured',
        coverage_last_run: '2026-07-23T11:00:00Z',
      }),
      nodeRecord('stale-file', 'File', 'src/public/stale.ts', parent, {
        node_last_structural_change_at: '2026-07-23T11:30:00Z',
        coverage_test_status: 'pass',
        coverage_edge_status: 'measured',
        coverage_last_run: '2026-07-23T11:00:00Z',
      }),
      nodeRecord('failing-file', 'File', 'src/public/failing.ts', parent, {
        node_last_edited_at: '2026-07-23T10:00:00Z',
        coverage_test_status: 'fail',
        coverage_edge_status: 'measured',
        coverage_last_run: '2026-07-23T11:00:00Z',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
      () => Date.parse('2026-07-23T12:00:00Z'),
    );

    const nodes = await service.getNodesInViewport(
      REPO_ID,
      REF_NAME,
      VIEWPORT,
      user('alice'),
    );

    expect(nodes.map(({ id, coverage }) => [id, coverage?.status])).toEqual([
      ['fresh-file', 'pass'],
      ['stale-file', 'stale'],
      ['failing-file', 'fail'],
    ]);
    expect(nodes.every((node) => node.label === 'File')).toBe(true);
  });

  it('merges multiple covering tests with failure precedence and a stable count', async () => {
    const parent = { id: 'public-folder', path: 'src/public' };
    const executor = new QueueExecutor([[
      nodeRecord('shared-file', 'File', 'src/public/shared.ts', parent, {
        coverage_test_status: 'pass',
        coverage_edge_status: 'measured',
        coverage_last_run: '2026-07-23T11:00:00Z',
      }),
      nodeRecord('shared-file', 'File', 'src/public/shared.ts', parent, {
        coverage_test_status: 'fail',
        coverage_edge_status: 'measured',
        coverage_last_run: '2026-07-23T11:30:00Z',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
      () => Date.parse('2026-07-23T12:00:00Z'),
    );

    const [node] = await service.getNodesInViewport(
      REPO_ID,
      REF_NAME,
      VIEWPORT,
      user('alice'),
    );

    expect(node?.coverage).toEqual({
      status: 'fail',
      lastRun: '2026-07-23T11:30:00.000Z',
      coveringTests: 2,
    });
  });

  it('drops non-canvas labels even if a graph adapter returns one', async () => {
    const executor = new QueueExecutor([
      [nodeRecord('function-1', 'Function', 'src/public/index.ts')],
    ]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, REF_NAME, VIEWPORT, user('alice')),
    ).resolves.toEqual([]);
  });

  it('returns only edges whose two endpoints are requested and authorized', async () => {
    const executor = new QueueExecutor([[
      record({
        type: 'IMPORTS',
        source_id: 'public-a',
        source_path: 'src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: 'refs/heads/main',
        target_id: 'public-b',
        target_path: 'src/public/b.ts',
        target_repo_id: REPO_ID,
        target_ref_name: 'refs/heads/main',
      }),
      record({
        type: 'IMPORTS',
        source_id: 'public-a',
        source_path: 'src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: 'refs/heads/main',
        target_id: 'private-secret',
        target_path: 'src/private/secret.ts',
        target_repo_id: REPO_ID,
        target_ref_name: 'refs/heads/main',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getStructuralEdges(
        REPO_ID,
        REF_NAME,
        ['public-a', 'public-b', 'private-secret'],
        user('alice'),
      ),
    ).resolves.toEqual([
      {
        id: 'IMPORTS:public-a:public-b',
        type: 'IMPORTS',
        source: 'public-a',
        target: 'public-b',
      },
    ]);
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      GET_STRUCTURAL_EDGES_CYPHER,
      expect.objectContaining({
        repo_id: REPO_ID,
        ref_name: REF_NAME,
      }),
    );
    expect(GET_STRUCTURAL_EDGES_CYPHER).toContain(
      'source.ref_name = $ref_name',
    );
    expect(GET_STRUCTURAL_EDGES_CYPHER).toContain(
      'target.ref_name = $ref_name',
    );
  });

  it('fails closed without an allow and does not contact the graph store', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(executor, new UserPermissionStore({}));

    await expect(
      service.getNodesInViewport(REPO_ID, REF_NAME, VIEWPORT, user('nobody')),
    ).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('drops cross-ref edges even when broad permissions and an adapter return them', async () => {
    const broadScope: ReadScope = {
      allows: [{ repoId: REPO_ID, branch: null, pathPrefix: 'src/public' }],
      denies: [],
    };
    const executor = new QueueExecutor([[
      record({
        type: 'IMPORTS',
        source_id: 'main-a',
        source_path: 'src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: REF_NAME,
        target_id: 'main-b',
        target_path: 'src/public/b.ts',
        target_repo_id: REPO_ID,
        target_ref_name: REF_NAME,
      }),
      record({
        type: 'IMPORTS',
        source_id: 'other-a',
        source_path: 'src/public/a.ts',
        source_repo_id: REPO_ID,
        source_ref_name: 'refs/heads/other',
        target_id: 'other-b',
        target_path: 'src/public/b.ts',
        target_repo_id: REPO_ID,
        target_ref_name: 'refs/heads/other',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: broadScope }),
    );

    await expect(
      service.getStructuralEdges(
        REPO_ID,
        REF_NAME,
        ['main-a', 'main-b', 'other-a', 'other-b'],
        user('alice'),
      ),
    ).resolves.toEqual([
      {
        id: 'IMPORTS:main-a:main-b',
        type: 'IMPORTS',
        source: 'main-a',
        target: 'main-b',
      },
    ]);
  });

  it('fails closed before graph access for a missing or non-canonical ref', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getNodesInViewport(REPO_ID, 'main', VIEWPORT, user('alice')),
    ).resolves.toEqual([]);
    await expect(
      service.getStructuralEdges(
        REPO_ID,
        '',
        ['public-a', 'public-b'],
        user('alice'),
      ),
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
        ['src/public/deleted.ts', 'src/private/secret.ts'],
        user('alice'),
      ),
    ).resolves.toEqual({ visible: [], removed: [] });
  });

  it('resolves retrieval anchors through parameterized org/RBAC scope and drops malformed records', async () => {
    const executor = new QueueExecutor([[
      retrievalRecord('public-a', 'src/public/a.ts'),
      retrievalRecord('public-a', 'src/public/a.ts'),
      retrievalRecord('wrong-org', 'src/public/wrong.ts', 0, { org_id: 'org-attacker' }),
      retrievalRecord('hidden', 'src/private/hidden.ts'),
      retrievalRecord('function', 'src/public/fn.ts', 0, { label: 'Function' }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.resolveRetrievalAnchors(['public', 'a.ts'], null, 8, user('alice')),
    ).resolves.toEqual([
      {
        id: 'public-a',
        label: 'File',
        name: 'a.ts',
        path: 'src/public/a.ts',
        repositoryId: REPO_ID,
        refName: 'refs/heads/main',
        revisionSha: 'a'.repeat(40),
        distance: 0,
      },
    ]);
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      RESOLVE_RETRIEVAL_ANCHORS_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        query_terms: ['public', 'a.ts'],
        exact_node_id: null,
        limit: neo4j.int(8),
      }),
    );
    expect(RESOLVE_RETRIEVAL_ANCHORS_CYPHER).toContain('node.org_id = $org_id');
    expect(RESOLVE_RETRIEVAL_ANCHORS_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(RESOLVE_RETRIEVAL_ANCHORS_CYPHER).not.toContain(ORG_ID);
  });

  it('returns a same-scope bounded traversal and rejects cross-scope driver records', async () => {
    const executor = new QueueExecutor([[
      traversalRecord('anchor', 'src/public/anchor.ts', 0),
      traversalRecord('neighbor', 'src/public/neighbor.ts', 1),
      traversalRecord('too-far', 'src/public/far.ts', 3),
      traversalRecord('other-ref', 'src/public/other.ts', 1, {
        ref_name: 'refs/heads/other',
      }),
      traversalRecord('wrong-org', 'src/public/wrong.ts', 1, {
        org_id: 'org-attacker',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    const traversal = await service.traverseRetrievalContext(
      'anchor',
      ['auth'],
      2,
      64,
      user('alice'),
    );

    expect(traversal?.anchor.id).toBe('anchor');
    expect(traversal?.nodes.map((node) => node.id)).toEqual(['anchor', 'neighbor']);
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      TRAVERSE_RETRIEVAL_CONTEXT_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        anchor_id: 'anchor',
        max_hops: 2,
        limit: neo4j.int(64),
      }),
    );
    expect(TRAVERSE_RETRIEVAL_CONTEXT_CYPHER).toContain('[*0..2]');
    expect(TRAVERSE_RETRIEVAL_CONTEXT_CYPHER).toContain(
      'ALL(path_node IN nodes(path)',
    );
    expect(TRAVERSE_RETRIEVAL_CONTEXT_CYPHER).toContain(
      "type(edge) IN ['CONTAINS', 'IMPORTS']",
    );
  });

  it('fails retrieval closed without permission or with bounds above the hard cap', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(executor, new UserPermissionStore({}));

    await expect(
      service.resolveRetrievalAnchors(['secret'], null, 8, user('nobody')),
    ).resolves.toEqual([]);
    await expect(
      service.traverseRetrievalContext('node', [], 3, 64, user('nobody')),
    ).resolves.toBeNull();
    await expect(
      service.traverseRetrievalContext('node', [], 2, 65, user('nobody')),
    ).resolves.toBeNull();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it('returns only current-head Feature members authorized for the caller', async () => {
    const executor = new QueueExecutor([[
      featureRecord('public-file', 'src/public/checkout.ts'),
      featureRecord('private-file', 'src/private/secret.ts'),
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
          path: 'src/public/checkout.ts',
          parentId: null,
          recentEdit: {
            fileId: 'public-file',
            filePath: 'src/public/checkout.ts',
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
          path_prefix: 'src/public',
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
      featureRecord('stale-feature', 'src/public/stale-feature.ts', {
        feature_revision_sha: 'b'.repeat(40),
      }),
      featureRecord('stale-member', 'src/public/stale-member.ts', {
        member_revision_sha: 'b'.repeat(40),
      }),
      featureRecord('foreign-membership', 'src/public/foreign.ts', {
        membership_org_id: '22222222-2222-4222-8222-222222222222',
      }),
      featureRecord('wrong-ref', 'src/public/wrong-ref.ts', {
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
      featureRecord('public-file', 'src/public/checkout.ts', {
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

  it('returns all graph-backed overlay layers while stripping hidden dependencies', async () => {
    const executor = new QueueExecutor([[
      overlayRecord(),
      overlayRecord({
        out_dependency_id: 'private-dependency',
        out_dependency_name: 'secret.ts',
        out_dependency_path: 'src/private/secret.ts',
      }),
      overlayRecord({
        commit_id: 'commit-2',
        commit_sha: 'c'.repeat(40),
        commit_timestamp: '2026-07-24T12:00:00Z',
        ticket_url: 'javascript:alert(1)',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    const overlay = await service.getNodeOverlay('public-file', user('alice'));

    expect(overlay).toMatchObject({
      node: {
        id: 'public-file',
        label: 'File',
        path: 'src/public/index.ts',
        repositoryId: REPO_ID,
      },
      dependencies: [{ id: 'public-dependency', direction: 'outbound' }],
      recentChanges: [
        { commitId: 'commit-2' },
        { commitId: 'commit-1' },
      ],
      features: [{ id: 'feature-checkout' }],
      description: 'Public entrypoint.',
      tickets: [{ id: 'ticket-pay-42', url: null }],
    });
    expect(overlay?.dependencies.some(({ id }) => id === 'private-dependency')).toBe(
      false,
    );
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      GET_NODE_OVERLAY_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        node_id: 'public-file',
        allow_rules: [{
          repo_id: REPO_ID,
          branch: 'refs/heads/main',
          path_prefix: 'src/public',
        }],
      }),
    );
    expect(GET_NODE_OVERLAY_CYPHER).toContain('target.org_id = $org_id');
    expect(GET_NODE_OVERLAY_CYPHER).toContain(
      'out_dependency.org_id = $org_id',
    );
    expect(GET_NODE_OVERLAY_CYPHER).toContain('LIMIT 512');
    expect(GET_NODE_OVERLAY_CYPHER).not.toContain(ORG_ID);
  });

  it('returns ordered EnvStep metadata beside Folder/File-only canvas nodes', async () => {
    const revision = 'a'.repeat(40);
    const executor = new QueueExecutor([
      [
        record({
          root_org_id: ORG_ID,
          root_repo_id: REPO_ID,
          root_ref_name: 'refs/heads/main',
          root_revision_sha: revision,
          step_org_id: ORG_ID,
          step_repo_id: REPO_ID,
          step_ref_name: 'refs/heads/main',
          step_revision_sha: revision,
          step_id: 'step-1',
          step_sequence: 0,
          step_command: 'printf ready',
          prerequisite_ids: [],
        }),
      ],
      [
        record({
          root_revision_sha: revision,
          id: 'root',
          label: 'Folder',
          name: 'fixture',
          path: '',
          org_id: ORG_ID,
          repo_id: REPO_ID,
          ref_name: 'refs/heads/main',
          revision_sha: revision,
          parent_id: null,
          parent_org_id: null,
          parent_repo_id: null,
          parent_ref_name: null,
          parent_path: null,
          parent_revision_sha: null,
        }),
        record({
          root_revision_sha: revision,
          id: 'readme',
          label: 'File',
          name: 'README.md',
          path: 'README.md',
          org_id: ORG_ID,
          repo_id: REPO_ID,
          ref_name: 'refs/heads/main',
          revision_sha: revision,
          parent_id: 'root',
          parent_org_id: ORG_ID,
          parent_repo_id: REPO_ID,
          parent_ref_name: 'refs/heads/main',
          parent_path: '',
          parent_revision_sha: revision,
        }),
      ],
    ]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: repositoryScope }),
    );

    await expect(
      service.getOnboardingProjection(
        REPO_ID,
        'refs/heads/main',
        user('alice'),
      ),
    ).resolves.toEqual({
      revisionSha: revision,
      steps: [
        {
          id: 'step-1',
          sequence: 0,
          command: 'printf ready',
          requires: [],
        },
      ],
      nodes: [
        {
          id: 'root',
          label: 'Folder',
          name: 'fixture',
          path: '',
          parentId: null,
        },
        {
          id: 'readme',
          label: 'File',
          name: 'README.md',
          path: 'README.md',
          parentId: 'root',
        },
      ],
    });
    expect(executor.run).toHaveBeenNthCalledWith(
      1,
      ORG_ID,
      'traversal',
      GET_ONBOARDING_STEPS_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        repo_id: REPO_ID,
        ref_name: 'refs/heads/main',
      }),
    );
    expect(executor.run).toHaveBeenNthCalledWith(
      2,
      ORG_ID,
      'traversal',
      GET_ONBOARDING_CANVAS_NODES_CYPHER,
      expect.objectContaining({ revision_sha: revision }),
    );
    expect(GET_ONBOARDING_STEPS_CYPHER).toContain(
      'OPTIONAL MATCH (step:EnvStep {\n  org_id: $org_id',
    );
    expect(GET_ONBOARDING_CANVAS_NODES_CYPHER).toContain(
      '(node:Folder OR node:File)',
    );
  });

  it('denies repo-wide onboarding commands to a path-only permission scope', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getOnboardingProjection(
        REPO_ID,
        'refs/heads/main',
        user('alice'),
      ),
    ).resolves.toBeNull();
    expect(executor.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CH-05 — getAuthorizedNodeIds: the narrow citation-authorization query behind
// the gateway's per-push RBAC re-filter. Authored by `red` from
// .pipeline/spec.md before any implementation exists. Every case above this
// line predates CH-05 and must keep passing untouched (AC-10).
// ---------------------------------------------------------------------------

function citationRecord(
  id: string,
  label: string,
  path: string | null,
  overrides: Record<string, unknown> = {},
): GraphReadRecord {
  return record({
    id,
    org_id: ORG_ID,
    repo_id: REPO_ID,
    ref_name: 'refs/heads/main',
    path,
    label,
    ...overrides,
  });
}

describe('RbacGraphQueryService.getAuthorizedNodeIds (CH-05)', () => {
  // @spec AC-3 AC-11
  it('AC-3/AC-11: returns only the requested ids the ctx may currently read, and runs the pinned citation query with ctx org + scope rules', async () => {
    const executor = new QueueExecutor([
      [
        citationRecord('public-file', 'File', 'src/public/index.ts'),
        citationRecord('private-file', 'File', 'src/private/secret.ts'),
      ],
    ]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    const authorized = await service.getAuthorizedNodeIds(
      ['public-file', 'private-file'],
      user('alice'),
    );

    expect(authorized).toEqual(['public-file']);
    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER,
      expect.objectContaining({
        org_id: ORG_ID,
        node_ids: ['public-file', 'private-file'],
        allow_rules: [
          { repo_id: REPO_ID, branch: 'refs/heads/main', path_prefix: 'src/public' },
        ],
        deny_rules: [],
      }),
    );
  });

  // @spec AC-3
  it('AC-3: an unknown id never throws — it is simply absent from the result', async () => {
    const executor = new QueueExecutor([[citationRecord('public-file', 'File', 'src/public/index.ts')]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getAuthorizedNodeIds(['public-file', 'no-such-node'], user('alice')),
    ).resolves.toEqual(['public-file']);
  });

  // @spec EC-28
  it('EC-28: an empty (or entirely blank) id list returns [] without touching the graph', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(service.getAuthorizedNodeIds([], user('alice'))).resolves.toEqual([]);
    await expect(service.getAuthorizedNodeIds(['', '   '], user('alice'))).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
  });

  // @spec AC-12
  it('AC-12: a subject with no read scope at all gets [] without touching the graph (fail closed)', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(executor, new UserPermissionStore({}));

    await expect(service.getAuthorizedNodeIds(['public-file'], user('nobody'))).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
  });

  // @spec AC-3
  it('AC-3: de-duplicates ids, drops blank/over-long ones, and never queries more than CHAT_CITATION_NODE_ID_LIMIT', async () => {
    const executor = new QueueExecutor([[]]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    const ids = [
      'a',
      'a',
      '',
      '   ',
      'x'.repeat(513),
      ...Array.from({ length: 80 }, (_unused, index) => `n-${index}`),
    ];
    await service.getAuthorizedNodeIds(ids, user('alice'));

    expect(CHAT_CITATION_NODE_ID_LIMIT).toBe(64);
    const sent = (executor.run.mock.calls[0]?.[3] ?? {}) as { node_ids: string[] };
    expect(sent.node_ids).toHaveLength(64);
    expect(sent.node_ids).not.toContain('');
    expect(sent.node_ids).not.toContain('x'.repeat(513));
    expect(new Set(sent.node_ids).size).toBe(sent.node_ids.length);
  });

  // @spec AC-3
  it('AC-3: TypeScript defense-in-depth — a row from a different org is dropped even if the query returned it', async () => {
    const executor = new QueueExecutor([
      [
        citationRecord('public-file', 'File', 'src/public/index.ts'),
        citationRecord('leaked-file', 'File', 'src/public/other.ts', {
          org_id: '22222222-2222-4222-8222-222222222222',
        }),
      ],
    ]);
    const service = new RbacGraphQueryService(
      executor,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      service.getAuthorizedNodeIds(['public-file', 'leaked-file'], user('alice')),
    ).resolves.toEqual(['public-file']);
  });

  // @spec AC-3
  it('AC-3: Feature and Ticket citations need a repository-ROOT grant — a path-scoped grant authorizes neither (fail closed)', async () => {
    const pathScoped = new QueueExecutor([
      [
        citationRecord('feature-checkout', 'Feature', null),
        citationRecord('ticket-pay-42', 'Ticket', null),
      ],
    ]);
    const pathScopedService = new RbacGraphQueryService(
      pathScoped,
      new UserPermissionStore({ alice: publicScope }),
    );

    await expect(
      pathScopedService.getAuthorizedNodeIds(['feature-checkout', 'ticket-pay-42'], user('alice')),
    ).resolves.toEqual([]);

    const rootScoped = new QueueExecutor([
      [
        citationRecord('feature-checkout', 'Feature', null),
        citationRecord('ticket-pay-42', 'Ticket', null),
      ],
    ]);
    const rootScopedService = new RbacGraphQueryService(
      rootScoped,
      new UserPermissionStore({ alice: repositoryScope }),
    );

    await expect(
      rootScopedService.getAuthorizedNodeIds(['feature-checkout', 'ticket-pay-42'], user('alice')),
    ).resolves.toEqual(['feature-checkout', 'ticket-pay-42']);
  });

  // @spec AC-3
  it('AC-3: the pinned Cypher stays openCypher-shaped, org-scoped, id-bounded and label-restricted', () => {
    expect(typeof GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toBe('string');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('node.org_id = $org_id');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('node.uid IN $node_ids');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('(node:Folder OR node:File)');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('(node:Feature OR node:Ticket)');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('$allow_rules');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain('$deny_rules');
    expect(GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER).toContain(`LIMIT ${CHAT_CITATION_NODE_ID_LIMIT}`);
  });
});

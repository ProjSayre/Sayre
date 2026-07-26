import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore, ReadScope } from './permissions';
import {
  RESOLVE_STYLE_RULES_CYPHER,
  RbacGraphQueryService,
} from './index';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_NAME = 'refs/heads/main';
const REVISION_SHA = 'a'.repeat(40);
const NODE_ID = 'file-node';
const AUTH_CONTEXT: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: ORG_ID,
  roles: ['member'],
};

const READ_SCOPE: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: 'src' }],
  denies: [],
};

function record(values: Record<string, unknown>): GraphReadRecord {
  return { get: (key) => values[key] };
}

interface StyleRecordOptions {
  targetCoding?: string | null;
  targetComment?: string | null;
  targetOrgId?: string;
  targetRepoId?: string;
  targetRefName?: string;
  targetRevisionSha?: string;
  ancestorId?: string | null;
  ancestorPath?: string | null;
  ancestorCoding?: string | null;
  ancestorComment?: string | null;
  ancestorOrgId?: string;
  ancestorRepoId?: string;
  ancestorRefName?: string;
  ancestorRevisionSha?: string;
  distance?: number | null;
}

function styleRecord(options: StyleRecordOptions = {}): GraphReadRecord {
  const ancestorId = options.ancestorId === undefined ? 'folder-nearest' : options.ancestorId;
  return record({
    target_id: NODE_ID,
    target_label: 'File',
    target_org_id: options.targetOrgId ?? ORG_ID,
    target_path: 'src/app/file.ts',
    target_repo_id: options.targetRepoId ?? REPO_ID,
    target_ref_name: options.targetRefName ?? REF_NAME,
    target_revision_sha: options.targetRevisionSha ?? REVISION_SHA,
    target_coding_style: options.targetCoding ?? null,
    target_comment_style: options.targetComment ?? null,
    ancestor_id: ancestorId,
    ancestor_label: ancestorId === null ? null : 'Folder',
    ancestor_org_id: options.ancestorOrgId ?? ORG_ID,
    ancestor_path: options.ancestorPath ?? 'src/app',
    ancestor_repo_id: options.ancestorRepoId ?? REPO_ID,
    ancestor_ref_name: options.ancestorRefName ?? REF_NAME,
    ancestor_revision_sha: options.ancestorRevisionSha ?? REVISION_SHA,
    ancestor_coding_style: options.ancestorCoding ?? null,
    ancestor_comment_style: options.ancestorComment ?? null,
    ancestor_distance: options.distance === undefined ? 1 : options.distance,
  });
}

class QueueExecutor implements GraphReadExecutor {
  readonly run = vi.fn(async () => ({ records: this.results.shift() ?? [] }));
  readonly close = vi.fn(async () => undefined);

  constructor(private readonly results: GraphReadRecord[][]) {}
}

class FixedPermissionStore implements PermissionStore {
  readonly getReadScope = vi.fn(async () => this.scope);

  constructor(private readonly scope: ReadScope) {}
}

describe('RbacGraphQueryService.resolveStyleRules', () => {
  it('resolves Coding and Comment Style independently from the nearest ancestor with a value', async () => {
    const executor = new QueueExecutor([[
      styleRecord({
        ancestorId: 'folder-nearest',
        ancestorPath: 'src/app',
        ancestorCoding: 'Use typed service boundaries.',
        ancestorComment: null,
        distance: 1,
      }),
      styleRecord({
        ancestorId: 'folder-root',
        ancestorPath: 'src',
        ancestorCoding: 'Farther coding rule.',
        ancestorComment: 'Document exported APIs.',
        distance: 2,
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore(READ_SCOPE),
    );

    await expect(service.resolveStyleRules(NODE_ID, AUTH_CONTEXT)).resolves.toEqual({
      nodeId: NODE_ID,
      codingStyle: {
        value: 'Use typed service boundaries.',
        sourceNodeId: 'folder-nearest',
      },
      commentStyle: {
        value: 'Document exported APIs.',
        sourceNodeId: 'folder-root',
      },
    });
  });

  it('uses explicit File overrides before any Folder value', async () => {
    const executor = new QueueExecutor([[
      styleRecord({
        targetCoding: 'File coding override.',
        targetComment: 'File comment override.',
        ancestorCoding: 'Folder coding.',
        ancestorComment: 'Folder comments.',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore(READ_SCOPE),
    );

    await expect(service.resolveStyleRules(NODE_ID, AUTH_CONTEXT)).resolves.toEqual({
      nodeId: NODE_ID,
      codingStyle: { value: 'File coding override.', sourceNodeId: NODE_ID },
      commentStyle: { value: 'File comment override.', sourceNodeId: NODE_ID },
    });
  });

  it('drops cross-tenant and cross-revision ancestor candidates in the mapper', async () => {
    const executor = new QueueExecutor([[
      styleRecord({
        ancestorId: 'wrong-org',
        ancestorOrgId: '22222222-2222-4222-8222-222222222222',
        ancestorCoding: 'Do not leak.',
      }),
      styleRecord({
        ancestorId: 'wrong-revision',
        ancestorRevisionSha: 'b'.repeat(40),
        ancestorComment: 'Do not leak.',
      }),
      styleRecord({ ancestorId: null, distance: null }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore(READ_SCOPE),
    );

    await expect(service.resolveStyleRules(NODE_ID, AUTH_CONTEXT)).resolves.toEqual({
      nodeId: NODE_ID,
      codingStyle: { value: null, sourceNodeId: null },
      commentStyle: { value: null, sourceNodeId: null },
    });
  });

  it('fails closed when the target record carries a different org', async () => {
    const executor = new QueueExecutor([[
      styleRecord({
        targetOrgId: '22222222-2222-4222-8222-222222222222',
        targetCoding: 'foreign',
      }),
    ]]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore(READ_SCOPE),
    );

    await expect(service.resolveStyleRules(NODE_ID, AUTH_CONTEXT)).resolves.toBeNull();
  });

  it('injects server auth and fixed RBAC traversal parameters into static Cypher', async () => {
    const executor = new QueueExecutor([[]]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore(READ_SCOPE),
    );

    await service.resolveStyleRules(NODE_ID, AUTH_CONTEXT);

    expect(executor.run).toHaveBeenCalledWith(
      ORG_ID,
      'traversal',
      RESOLVE_STYLE_RULES_CYPHER,
      {
        org_id: ORG_ID,
        node_id: NODE_ID,
        allow_rules: [
          { repo_id: REPO_ID, branch: REF_NAME, path_prefix: 'src' },
        ],
        deny_rules: [],
      },
    );
    expect(RESOLVE_STYLE_RULES_CYPHER).toContain('[:CONTAINS*0..64]');
    expect(RESOLVE_STYLE_RULES_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(RESOLVE_STYLE_RULES_CYPHER).toContain('NOT ANY(rule IN $deny_rules');
    expect(RESOLVE_STYLE_RULES_CYPHER).toContain('path_edge.org_id = $org_id');
    expect(RESOLVE_STYLE_RULES_CYPHER).not.toContain(ORG_ID);
  });

  it('does not contact the graph without an allow scope or with an invalid node id', async () => {
    const executor = new QueueExecutor([]);
    const service = new RbacGraphQueryService(
      executor,
      new FixedPermissionStore({ allows: [], denies: [] }),
    );

    await expect(service.resolveStyleRules(NODE_ID, AUTH_CONTEXT)).resolves.toBeNull();
    await expect(service.resolveStyleRules(' ', AUTH_CONTEXT)).resolves.toBeNull();
    expect(executor.run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import {
  GET_COVERING_TESTS_CYPHER,
  RbacGraphQueryService,
} from './index';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore } from './permissions';

const ORG = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const AUTH: AuthContext = {
  subjectType: 'agent_key',
  agentKeyId: 'mcp_live_0123456789abcdef',
  orgId: ORG,
  roles: ['member'],
};

function record(values: Record<string, unknown>): GraphReadRecord {
  return { get: (key) => values[key] };
}

function row(
  test: Partial<Record<string, unknown>>,
): GraphReadRecord {
  return record({
    target_id: 'file-1',
    target_label: 'File',
    target_name: 'app.ts',
    target_path: '/src/app.ts',
    target_org_id: ORG,
    target_repo_id: REPO,
    target_ref_name: 'refs/heads/main',
    target_revision_sha: 'abc123',
    test_id: 'test-1',
    test_name: 'app.test.ts',
    test_path: '/src/app.test.ts',
    test_org_id: ORG,
    test_repo_id: REPO,
    test_ref_name: 'refs/heads/main',
    test_revision_sha: 'abc123',
    test_coverage_status: 'pass',
    coverage_edge_status: 'measured',
    coverage_last_run: new Date().toISOString(),
    ...test,
  });
}

describe('getCoveringTests graph boundary', () => {
  it('returns only same-org, same-revision tests whose paths are also authorized', async () => {
    const run = vi.fn(async () => ({
      records: [
        row({}),
        row({
          test_id: 'hidden-path',
          test_path: '/private/secret.test.ts',
        }),
        row({
          test_id: 'other-org',
          test_org_id: '99999999-9999-4999-8999-999999999999',
        }),
      ],
    }));
    const graph: GraphReadExecutor = {
      run,
      close: vi.fn(async () => undefined),
    };
    const permissions: PermissionStore = {
      getReadScope: vi.fn(async () => ({
        allows: [
          {
            repoId: REPO,
            branch: 'refs/heads/main',
            pathPrefix: '/src',
          },
        ],
        denies: [],
      })),
    };
    const service = new RbacGraphQueryService(graph, permissions);

    await expect(service.getCoveringTests('file-1', AUTH)).resolves.toEqual({
      node: {
        id: 'file-1',
        label: 'File',
        name: 'app.ts',
        path: '/src/app.ts',
        repositoryId: REPO,
        refName: 'refs/heads/main',
        revisionSha: 'abc123',
      },
      tests: [
        expect.objectContaining({
          id: 'test-1',
          coverageStatus: 'pass',
          edgeStatus: 'measured',
          freshness: 'fresh',
        }),
      ],
    });
    expect(run).toHaveBeenCalledWith(
      ORG,
      'traversal',
      GET_COVERING_TESTS_CYPHER,
      expect.objectContaining({
        org_id: ORG,
        node_id: 'file-1',
      }),
    );
  });

  it('keeps both the target and Test path predicates inside the graph query', () => {
    expect(GET_COVERING_TESTS_CYPHER).toContain('target.org_id = $org_id');
    expect(GET_COVERING_TESTS_CYPHER).toContain('test.org_id = $org_id');
    expect(GET_COVERING_TESTS_CYPHER).toContain(
      'test.revision_sha = target.revision_sha',
    );
    expect(GET_COVERING_TESTS_CYPHER).toContain(
      "test.path STARTS WITH rule.path_prefix + '/'",
    );
  });
});

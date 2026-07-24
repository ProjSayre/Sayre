import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { AgentSkillMdStore } from '../db/agentSkillMdStore';
import type {
  NodeOverlayGraphQueryService,
  NodeOverlayGraphSnapshot,
} from '../graph-query/types';
import { getNodeOverlay } from './nodeOverlayService';

const ctx: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: '11111111-1111-4111-8111-111111111111',
  roles: ['member'],
};

const graphSnapshot: NodeOverlayGraphSnapshot = {
  node: {
    id: 'file-1',
    label: 'File',
    name: 'index.ts',
    path: '/src/index.ts',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    refName: 'refs/heads/main',
    revisionSha: 'a'.repeat(40),
  },
  dependencies: [{
    id: 'file-2',
    label: 'File',
    name: 'util.ts',
    path: '/src/util.ts',
    relationship: 'IMPORTS',
    direction: 'outbound',
  }],
  recentChanges: [{
    commitId: 'commit-1',
    sha: 'b'.repeat(40),
    message: 'Update index',
    timestamp: '2026-07-23T12:00:00Z',
    authorName: 'Ada',
    authorLogin: 'ada',
    pullRequestTitle: 'Update',
    pullRequestUrl: 'https://example.test/pull/1',
  }],
  features: [{
    id: 'feature-1',
    name: 'Checkout',
    description: 'Checkout flow.',
    team: 'Commerce',
  }],
  description: 'Entrypoint.',
  tickets: [{
    id: 'ticket-1',
    externalId: 'PAY-42',
    system: 'jira',
    title: 'Fix checkout',
    status: 'Open',
    url: 'https://example.test/PAY-42',
  }],
};

describe('getNodeOverlay', () => {
  it('assembles all six layers from one authorized graph snapshot', async () => {
    const graph: NodeOverlayGraphQueryService = {
      getNodeOverlay: vi.fn(async () => graphSnapshot),
    };
    const document = {
      version: 2,
      content: '## Allowed Tools\nRead\n## Required Context\nRules\n## Guardrails\nSafe\n',
      editorUserId: 'user-1',
      editorLabel: 'Ada',
      createdAt: '2026-07-23T13:00:00Z',
    };
    const store: AgentSkillMdStore = {
      latest: vi.fn(async () => document),
      history: vi.fn(async () => [document]),
      append: vi.fn(async () => document),
    };

    const overlay = await getNodeOverlay('file-1', ctx, graph, store);

    expect(overlay).toMatchObject({
      authorization: 'server-filtered',
      node: { id: 'file-1' },
      dependencies: [{ id: 'file-2' }],
      recentChanges: [{ commitId: 'commit-1' }],
      specificFeatures: [{ id: 'feature-1' }],
      agentSkillMd: { version: 2 },
      description: 'Entrypoint.',
      specificTickets: [{ externalId: 'PAY-42' }],
    });
    expect(graph.getNodeOverlay).toHaveBeenCalledTimes(1);
    expect(store.latest).toHaveBeenCalledTimes(1);
  });
});

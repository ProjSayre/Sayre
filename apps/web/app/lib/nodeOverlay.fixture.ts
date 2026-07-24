import type { NodeOverlayResponse } from './nodeOverlay';

export const OVERLAY_FIXTURE: NodeOverlayResponse = {
  authorization: 'server-filtered',
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
    message: 'Update',
    timestamp: '2026-07-23T12:00:00Z',
    authorName: 'Ada',
    authorLogin: 'ada',
    pullRequestTitle: 'Update',
    pullRequestUrl: 'https://example.test/pull/1',
  }],
  specificFeatures: [{
    id: 'feature-1',
    name: 'Checkout',
    description: 'Completes checkout.',
    team: 'Commerce',
  }],
  agentSkillMd: {
    version: 1,
    content: '## Allowed Tools\n\nRead\n\n## Required Context\n\nRules\n\n## Guardrails\n\nSafe\n',
    editorUserId: 'user-1',
    editorLabel: 'Ada',
    createdAt: '2026-07-23T12:00:00Z',
  },
  description: 'Entrypoint.',
  specificTickets: [{
    id: 'ticket-1',
    externalId: 'PAY-42',
    system: 'jira',
    title: 'Fix checkout',
    status: 'Open',
    url: 'https://example.test/PAY-42',
  }],
};

import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/context';
import {
  AgentSkillMdStoreConflictError,
  type AgentSkillMdNodeScope,
  type AgentSkillMdStore,
  type AppendAgentSkillMdInput,
  type StoredAgentSkillMdVersion,
} from '../db/agentSkillMdStore';
import type {
  NodeOverlayGraphQueryService,
  NodeOverlayGraphSnapshot,
} from '../graph-query/types';
import {
  AgentSkillMdForbiddenError,
  AgentSkillMdValidationError,
  AgentSkillMdVersionConflictError,
  getAgentSkillMd,
  getAgentSkillMdHistory,
  saveAgentSkillMd,
  validateAgentSkillMd,
} from './agentSkillMdService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const owner: AuthContext = {
  subjectType: 'user',
  userId: 'user-owner',
  orgId: ORG_ID,
  roles: ['owner'],
};
const member: AuthContext = {
  subjectType: 'user',
  userId: 'user-member',
  orgId: ORG_ID,
  roles: ['member'],
};
const agent: AuthContext = {
  subjectType: 'agent_key',
  agentKeyId: 'mcp_test',
  orgId: ORG_ID,
  roles: ['owner'],
};

const snapshot: NodeOverlayGraphSnapshot = {
  node: {
    id: 'file-public',
    label: 'File',
    name: 'index.ts',
    path: '/src/public/index.ts',
    repositoryId: REPO_ID,
    refName: 'refs/heads/main',
    revisionSha: 'a'.repeat(40),
  },
  dependencies: [],
  recentChanges: [],
  features: [],
  description: null,
  tickets: [],
};

const validDocument = `# Agent instructions

## Allowed Tools

- Read
- Test

## Required Context

Read the repository rules first.

## Guardrails

Never expose tenant data.
`;

class Graph implements NodeOverlayGraphQueryService {
  calls = 0;

  constructor(private readonly value: NodeOverlayGraphSnapshot | null = snapshot) {}

  async getNodeOverlay(): Promise<NodeOverlayGraphSnapshot | null> {
    this.calls += 1;
    return this.value;
  }
}

class MemoryStore implements AgentSkillMdStore {
  versions: StoredAgentSkillMdVersion[] = [];
  latestScopes: AgentSkillMdNodeScope[] = [];

  async latest(scope: AgentSkillMdNodeScope) {
    this.latestScopes.push(scope);
    return this.versions.at(-1) ?? null;
  }

  async history(_scope: AgentSkillMdNodeScope, limit: number) {
    return [...this.versions].reverse().slice(0, limit);
  }

  async append(input: AppendAgentSkillMdInput) {
    const currentVersion = this.versions.at(-1)?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new AgentSkillMdStoreConflictError(currentVersion);
    }
    const version: StoredAgentSkillMdVersion = {
      version: currentVersion + 1,
      content: input.content,
      editorUserId: input.editorUserId,
      editorLabel: input.editorUserId,
      createdAt: `2026-07-24T00:00:0${currentVersion}.000Z`,
    };
    this.versions.push(version);
    return version;
  }
}

describe('Agent/Skill MD validation', () => {
  it('accepts free-form Markdown inside the three required ordered sections', () => {
    const content = validateAgentSkillMd(validDocument);

    expect(content).toContain('## Allowed Tools\n\n- Read');
    expect(content.endsWith('\n')).toBe(true);
  });

  it.each([
    ['missing section', validDocument.replace('## Guardrails', '## Safety')],
    ['duplicate section', `${validDocument}\n## Guardrails\nAgain.`],
    [
      'wrong order',
      validDocument
        .replace('## Allowed Tools', '## TEMP')
        .replace('## Required Context', '## Allowed Tools')
        .replace('## TEMP', '## Required Context'),
    ],
    ['empty body', validDocument.replace('Never expose tenant data.', ' ')],
    ['NUL', `${validDocument}\0`],
  ])('rejects a %s with a useful structural issue', (_name, content) => {
    expect(() => validateAgentSkillMd(content)).toThrow(
      AgentSkillMdValidationError,
    );
  });
});

describe('Agent/Skill MD service', () => {
  it('makes an authorized save visible through the shared read immediately and records history', async () => {
    const graph = new Graph();
    const store = new MemoryStore();

    const saved = await saveAgentSkillMd(
      snapshot.node.id,
      { content: validDocument, expectedVersion: 0 },
      owner,
      graph,
      store,
    );
    const read = await getAgentSkillMd(
      snapshot.node.id,
      owner,
      graph,
      store,
    );
    const history = await getAgentSkillMdHistory(
      snapshot.node.id,
      owner,
      25,
      graph,
      store,
    );

    expect(saved.document?.version).toBe(1);
    expect(read).toEqual(saved);
    expect(history).toEqual([saved.document]);
    expect(store.latestScopes[0]).toMatchObject({
      orgId: ORG_ID,
      repositoryId: REPO_ID,
      nodeId: snapshot.node.id,
    });
  });

  it.each([
    ['member', member],
    ['agent key even with an owner role claim', agent],
  ])('rejects an unauthorized %s before graph or storage access', async (_name, ctx) => {
    const graph = new Graph();
    const store = new MemoryStore();

    await expect(
      saveAgentSkillMd(
        snapshot.node.id,
        { content: validDocument, expectedVersion: 0 },
        ctx,
        graph,
        store,
      ),
    ).rejects.toBeInstanceOf(AgentSkillMdForbiddenError);
    expect(graph.calls).toBe(0);
    expect(store.versions).toEqual([]);
  });

  it('maps optimistic concurrency failure to the public version conflict', async () => {
    const graph = new Graph();
    const store = new MemoryStore();
    await store.append({
      scope: {
        orgId: ORG_ID,
        repositoryId: REPO_ID,
        refName: snapshot.node.refName,
        nodeId: snapshot.node.id,
        nodePath: snapshot.node.path,
        nodeLabel: snapshot.node.label,
        revisionSha: snapshot.node.revisionSha,
      },
      expectedVersion: 0,
      content: validateAgentSkillMd(validDocument),
      editorUserId: owner.userId,
    });

    const error = await saveAgentSkillMd(
      snapshot.node.id,
      { content: validDocument, expectedVersion: 0 },
      owner,
      graph,
      store,
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentSkillMdVersionConflictError);
    expect(error).toMatchObject({ currentVersion: 1 });
  });

  it('returns null instead of revealing whether an unauthorized node exists', async () => {
    await expect(
      getAgentSkillMd(
        'hidden',
        member,
        new Graph(null),
        new MemoryStore(),
      ),
    ).resolves.toBeNull();
  });
});

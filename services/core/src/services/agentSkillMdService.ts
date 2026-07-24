import type { AuthContext } from '../auth/context';
import {
  AgentSkillMdStoreConflictError,
  agentSkillMdStore,
  type AgentSkillMdNodeScope,
  type AgentSkillMdStore,
  type StoredAgentSkillMdVersion,
} from '../db/agentSkillMdStore';
import { graphQueryService } from '../graph-query';
import type {
  NodeOverlayGraphQueryService,
  OverlayNodeIdentity,
} from '../graph-query/types';

export const AGENT_SKILL_MD_MAX_CHARACTERS = 32_768;
export const AGENT_SKILL_MD_REQUIRED_SECTIONS = [
  'Allowed Tools',
  'Required Context',
  'Guardrails',
] as const;

export interface AgentSkillMdRead {
  nodeId: string;
  repositoryId: string;
  refName: string;
  document: StoredAgentSkillMdVersion | null;
}

export interface SaveAgentSkillMdInput {
  content: unknown;
  expectedVersion: unknown;
}

export class AgentSkillMdValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' '));
    this.name = 'AgentSkillMdValidationError';
  }
}

export class AgentSkillMdForbiddenError extends Error {
  constructor() {
    super('Only authorized organization owners and admins can edit Agent/Skill MD.');
    this.name = 'AgentSkillMdForbiddenError';
  }
}

export class AgentSkillMdNotFoundError extends Error {
  constructor() {
    super('Node not found.');
    this.name = 'AgentSkillMdNotFoundError';
  }
}

export class AgentSkillMdVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Agent/Skill MD changed since it was loaded.');
    this.name = 'AgentSkillMdVersionConflictError';
  }
}

function nodeScope(
  node: OverlayNodeIdentity,
  orgId: string,
): AgentSkillMdNodeScope {
  return {
    orgId,
    repositoryId: node.repositoryId,
    refName: node.refName,
    nodeId: node.id,
    nodePath: node.path,
    nodeLabel: node.label,
    revisionSha: node.revisionSha,
  };
}

function levelTwoHeadings(content: string): Array<{
  title: string;
  index: number;
  end: number;
}> {
  const headings: Array<{ title: string; index: number; end: number }> = [];
  for (const match of content.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)) {
    headings.push({
      title: match[1]?.trim() ?? '',
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return headings;
}

export function validateAgentSkillMd(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AgentSkillMdValidationError(['content must be a Markdown string.']);
  }
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  const issues: string[] = [];
  if (!normalized) issues.push('content must not be blank.');
  if (normalized.includes('\0')) issues.push('content must not contain NUL characters.');
  if (normalized.length > AGENT_SKILL_MD_MAX_CHARACTERS) {
    issues.push(
      `content must be at most ${AGENT_SKILL_MD_MAX_CHARACTERS} characters.`,
    );
  }

  const headings = levelTwoHeadings(normalized);
  const expected = [...AGENT_SKILL_MD_REQUIRED_SECTIONS];
  if (
    headings.length !== expected.length ||
    headings.some((heading, index) => heading.title !== expected[index])
  ) {
    issues.push(
      'use exactly these level-two sections in order: ## Allowed Tools, ## Required Context, ## Guardrails.',
    );
  } else {
    headings.forEach((heading, index) => {
      const body = normalized
        .slice(heading.end, headings[index + 1]?.index ?? normalized.length)
        .trim();
      if (!body) issues.push(`## ${heading.title} must contain Markdown content.`);
    });
  }

  if (issues.length > 0) throw new AgentSkillMdValidationError(issues);
  return `${normalized}\n`;
}

function parseExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentSkillMdValidationError([
      'expectedVersion must be a non-negative integer.',
    ]);
  }
  return value as number;
}

function canAuthor(ctx: AuthContext): ctx is Extract<AuthContext, { subjectType: 'user' }> {
  return (
    ctx.subjectType === 'user' &&
    (ctx.roles.includes('owner') || ctx.roles.includes('admin'))
  );
}

/**
 * Shared, cache-free read path used by the canvas, Retrieval Service, and MCP.
 * A caller that already holds an authorized graph snapshot can use this helper
 * without issuing a second graph query.
 */
export async function readAgentSkillMdForAuthorizedNode(
  node: OverlayNodeIdentity,
  ctx: AuthContext,
  store: AgentSkillMdStore = agentSkillMdStore,
): Promise<AgentSkillMdRead> {
  return {
    nodeId: node.id,
    repositoryId: node.repositoryId,
    refName: node.refName,
    document: await store.latest(nodeScope(node, ctx.orgId)),
  };
}

export async function getAgentSkillMd(
  nodeId: string,
  ctx: AuthContext,
  graph: NodeOverlayGraphQueryService = graphQueryService,
  store: AgentSkillMdStore = agentSkillMdStore,
): Promise<AgentSkillMdRead | null> {
  const snapshot = await graph.getNodeOverlay(nodeId, ctx);
  if (!snapshot) return null;
  return readAgentSkillMdForAuthorizedNode(snapshot.node, ctx, store);
}

export async function getAgentSkillMdHistory(
  nodeId: string,
  ctx: AuthContext,
  limit = 25,
  graph: NodeOverlayGraphQueryService = graphQueryService,
  store: AgentSkillMdStore = agentSkillMdStore,
): Promise<StoredAgentSkillMdVersion[]> {
  const snapshot = await graph.getNodeOverlay(nodeId, ctx);
  if (!snapshot) throw new AgentSkillMdNotFoundError();
  return store.history(nodeScope(snapshot.node, ctx.orgId), limit);
}

export async function saveAgentSkillMd(
  nodeId: string,
  input: SaveAgentSkillMdInput,
  ctx: AuthContext,
  graph: NodeOverlayGraphQueryService = graphQueryService,
  store: AgentSkillMdStore = agentSkillMdStore,
): Promise<AgentSkillMdRead> {
  if (!canAuthor(ctx)) throw new AgentSkillMdForbiddenError();
  const content = validateAgentSkillMd(input.content);
  const expectedVersion = parseExpectedVersion(input.expectedVersion);
  const snapshot = await graph.getNodeOverlay(nodeId, ctx);
  if (!snapshot) throw new AgentSkillMdNotFoundError();

  try {
    const document = await store.append({
      scope: nodeScope(snapshot.node, ctx.orgId),
      expectedVersion,
      content,
      editorUserId: ctx.userId,
    });
    return {
      nodeId: snapshot.node.id,
      repositoryId: snapshot.node.repositoryId,
      refName: snapshot.node.refName,
      document,
    };
  } catch (error) {
    if (error instanceof AgentSkillMdStoreConflictError) {
      throw new AgentSkillMdVersionConflictError(error.currentVersion);
    }
    throw error;
  }
}

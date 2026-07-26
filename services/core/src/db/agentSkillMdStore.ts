import { and, desc, eq, sql } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { agentSkillMdVersions, users } from './schema';
import type { CanvasNodeLabel } from '../graph-query/types';

export interface AgentSkillMdNodeScope {
  orgId: string;
  repositoryId: string;
  refName: string;
  nodeId: string;
  nodePath: string;
  nodeLabel: CanvasNodeLabel;
  revisionSha: string;
}

export interface StoredAgentSkillMdVersion {
  version: number;
  content: string;
  editorUserId: string | null;
  editorLabel: string;
  createdAt: string;
}

export interface AppendAgentSkillMdInput {
  scope: AgentSkillMdNodeScope;
  expectedVersion: number;
  content: string;
  editorUserId: string;
}

export interface AgentSkillMdStore {
  latest(scope: AgentSkillMdNodeScope): Promise<StoredAgentSkillMdVersion | null>;
  history(
    scope: AgentSkillMdNodeScope,
    limit: number,
  ): Promise<StoredAgentSkillMdVersion[]>;
  append(input: AppendAgentSkillMdInput): Promise<StoredAgentSkillMdVersion>;
}

export class AgentSkillMdStoreConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Agent/Skill MD was changed by another editor.');
    this.name = 'AgentSkillMdStoreConflictError';
  }
}

export interface PostgresAgentSkillMdStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresAgentSkillMdStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

function predicates(scope: AgentSkillMdNodeScope) {
  return and(
    eq(agentSkillMdVersions.orgId, scope.orgId),
    eq(agentSkillMdVersions.repoId, scope.repositoryId),
    eq(agentSkillMdVersions.refName, scope.refName),
    eq(agentSkillMdVersions.graphNodeId, scope.nodeId),
  );
}

function stored(
  row: typeof agentSkillMdVersions.$inferSelect,
): StoredAgentSkillMdVersion {
  return {
    version: row.version,
    content: row.content,
    editorUserId: row.editorUserId,
    editorLabel: row.editorLabel,
    createdAt: row.createdAt.toISOString(),
  };
}

export function agentSkillMdLockKey(scope: AgentSkillMdNodeScope): string {
  // PostgreSQL text values cannot contain NUL bytes. JSON preserves field
  // boundaries without introducing an invalid byte or ambiguous concatenation.
  return JSON.stringify([
    scope.orgId,
    scope.repositoryId,
    scope.refName,
    scope.nodeId,
  ]);
}

export class PostgresAgentSkillMdStore implements AgentSkillMdStore {
  constructor(
    private readonly deps: PostgresAgentSkillMdStoreDeps = defaultDeps,
  ) {}

  async latest(
    scope: AgentSkillMdNodeScope,
  ): Promise<StoredAgentSkillMdVersion | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, scope.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(agentSkillMdVersions)
        .where(predicates(scope))
        .orderBy(desc(agentSkillMdVersions.version))
        .limit(1);
      return rows[0] ? stored(rows[0]) : null;
    });
  }

  async history(
    scope: AgentSkillMdNodeScope,
    limit: number,
  ): Promise<StoredAgentSkillMdVersion[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Agent/Skill MD history limit must be between 1 and 100.');
    }
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, scope.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(agentSkillMdVersions)
        .where(predicates(scope))
        .orderBy(desc(agentSkillMdVersions.version))
        .limit(limit);
      return rows.map(stored);
    });
  }

  async append(
    input: AppendAgentSkillMdInput,
  ): Promise<StoredAgentSkillMdVersion> {
    const { scope } = input;
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, scope.orgId, async (tx) => {
      // A transaction-scoped advisory lock serializes the first insert as well
      // as later versions; SELECT ... FOR UPDATE alone cannot lock an absent row.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${agentSkillMdLockKey(scope)}, 0))`,
      );

      const currentRows = await tx
        .select({ version: agentSkillMdVersions.version })
        .from(agentSkillMdVersions)
        .where(predicates(scope))
        .orderBy(desc(agentSkillMdVersions.version))
        .limit(1);
      const currentVersion = currentRows[0]?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new AgentSkillMdStoreConflictError(currentVersion);
      }

      const editorRows = await tx
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.id, input.editorUserId),
            eq(users.orgId, scope.orgId),
          ),
        )
        .limit(1);
      const editor = editorRows[0];
      if (!editor) {
        throw new Error('Agent/Skill MD editor is not an active user in this organization.');
      }

      const [row] = await tx
        .insert(agentSkillMdVersions)
        .values({
          orgId: scope.orgId,
          repoId: scope.repositoryId,
          refName: scope.refName,
          graphNodeId: scope.nodeId,
          nodePath: scope.nodePath,
          nodeLabel: scope.nodeLabel,
          revisionSha: scope.revisionSha,
          version: currentVersion + 1,
          content: input.content,
          editorUserId: editor.id,
          editorLabel: editor.name?.trim() || editor.email,
        })
        .returning();
      if (!row) throw new Error('Agent/Skill MD append returned no version.');
      return stored(row);
    });
  }
}

export const agentSkillMdStore: AgentSkillMdStore =
  new PostgresAgentSkillMdStore();

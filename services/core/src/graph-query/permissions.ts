import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AuthContext } from '../auth/context';
import { createDb, createPoolFromSecret, type Db, withOrgContext } from '../db/client';
import { permissions } from '../db/schema';
import {
  canonicalRelativePath,
  normalizePermissionPathPrefix,
} from './path';

export interface AuthorizationRule {
  repoId: string | null;
  branch: string | null;
  pathPrefix: string | null;
}

export interface ReadScope {
  allows: AuthorizationRule[];
  denies: AuthorizationRule[];
}

export interface PermissionStore {
  getReadScope(ctx: AuthContext, repoId?: string): Promise<ReadScope>;
}

interface PermissionSubject {
  type: 'user' | 'role' | 'agent_key';
  id: string;
}

interface PermissionRow {
  repoId: string | null;
  branch: string | null;
  pathPrefix: string | null;
  effect: string;
}

const EMPTY_SCOPE: ReadScope = { allows: [], denies: [] };
const OWNER_SCOPE: ReadScope = {
  allows: [{ repoId: null, branch: null, pathPrefix: null }],
  denies: [],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let defaultDbPromise: Promise<Db> | undefined;

async function getDefaultDb(): Promise<Db> {
  defaultDbPromise ??= createPoolFromSecret().then(createDb);
  return defaultDbPromise;
}

/**
 * User grants are the union of direct-user and coarse-role rows. Agent keys use
 * only their own rows: inheriting a role row here could silently widen a scoped
 * key beyond its issuance ceiling when W4-06 begins constructing key contexts.
 */
export function permissionSubjects(ctx: AuthContext): PermissionSubject[] {
  if (ctx.subjectType === 'agent_key') {
    return [{ type: 'agent_key', id: ctx.agentKeyId }];
  }

  return [
    { type: 'user', id: ctx.userId },
    ...ctx.roles.map((role) => ({ type: 'role' as const, id: role })),
  ];
}

function normalizeBranch(branch: string | null): string | null {
  const value = branch?.trim();
  if (!value) return null;
  return value.startsWith('refs/') ? value : `refs/heads/${value}`;
}

function normalizeRule(
  row: PermissionRow,
): { rule: AuthorizationRule; validPath: boolean } {
  const normalizedPath = normalizePermissionPathPrefix(row.pathPrefix);
  return {
    rule: {
      repoId: row.repoId,
      branch: normalizeBranch(row.branch),
      pathPrefix: normalizedPath.pathPrefix,
    },
    validPath: normalizedPath.valid,
  };
}

function deduplicate(rules: AuthorizationRule[]): AuthorizationRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = JSON.stringify([rule.repoId, rule.branch, rule.pathPrefix]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scopeFromRows(rows: readonly PermissionRow[]): ReadScope {
  const allows: AuthorizationRule[] = [];
  const denies: AuthorizationRule[] = [];

  for (const row of rows) {
    const normalized = normalizeRule(row);
    // Only the exact persisted value "allow" grants data. Unknown effects fail
    // closed as denies because the current schema predates CHECK constraints.
    if (row.effect === 'allow') {
      // A malformed allow must never widen access.
      if (normalized.validPath) allows.push(normalized.rule);
    } else {
      // A malformed deny cannot safely identify a narrower subtree. Treat it
      // as a root deny within the same repo/ref boundary.
      denies.push(
        normalized.validPath
          ? normalized.rule
          : { ...normalized.rule, pathPrefix: null },
      );
    }
  }

  return { allows: deduplicate(allows), denies: deduplicate(denies) };
}

export interface ScopedGraphResource {
  repoId: string;
  refName: string;
  path: string;
}

function ruleMatches(
  rule: AuthorizationRule,
  resource: ScopedGraphResource,
  malformedPathMatches: boolean,
): boolean {
  if (rule.repoId !== null && rule.repoId !== resource.repoId) return false;
  if (rule.branch !== null && rule.branch !== resource.refName) return false;
  if (rule.pathPrefix === null) return true;
  const canonicalPrefix = canonicalRelativePath(rule.pathPrefix);
  if (canonicalPrefix === null || canonicalPrefix === '') {
    return malformedPathMatches;
  }
  return (
    resource.path === canonicalPrefix ||
    resource.path.startsWith(`${canonicalPrefix}/`)
  );
}

/** Defense-in-depth mirror of the predicate embedded in each Cypher query. */
export function canReadResource(scope: ReadScope, resource: ScopedGraphResource): boolean {
  if (canonicalRelativePath(resource.path) !== resource.path) return false;
  return (
    scope.allows.some((rule) => ruleMatches(rule, resource, false)) &&
    !scope.denies.some((rule) => ruleMatches(rule, resource, true))
  );
}

export function cypherRules(
  rules: readonly AuthorizationRule[],
  malformedPathPolicy: 'drop' | 'deny-root' = 'drop',
): Array<Record<string, string | null>> {
  const result: Array<Record<string, string | null>> = [];
  for (const rule of rules) {
    if (rule.pathPrefix === null) {
      result.push({
        repo_id: rule.repoId,
        branch: rule.branch,
        path_prefix: null,
      });
      continue;
    }
    const pathPrefix = canonicalRelativePath(rule.pathPrefix);
    if (pathPrefix === null || pathPrefix === '') {
      if (malformedPathPolicy === 'deny-root') {
        result.push({
            repo_id: rule.repoId,
            branch: rule.branch,
            path_prefix: null,
        });
      }
      continue;
    }
    result.push({
      repo_id: rule.repoId,
      branch: rule.branch,
      path_prefix: pathPrefix,
    });
  }
  return result;
}

export class PostgresPermissionStore implements PermissionStore {
  constructor(private readonly database: () => Promise<Db> = getDefaultDb) {}

  async getReadScope(ctx: AuthContext, repoId?: string): Promise<ReadScope> {
    // The owner role is the tenant root and is intentionally omniscient within
    // its server-derived org. This also keeps local owner-mode usable before a
    // permission-management UI exists. Graph queries still inject org_id.
    if (ctx.subjectType === 'user' && ctx.roles.includes('owner')) return OWNER_SCOPE;

    // repositories.id is UUID-backed. A malformed route/MCP argument cannot be
    // bound safely to Postgres and should reveal no permission rows.
    if (repoId !== undefined && !UUID_RE.test(repoId)) return EMPTY_SCOPE;

    const subjects = permissionSubjects(ctx);
    const subjectClause = or(
      ...subjects.map((subject) =>
        and(
          eq(permissions.subjectType, subject.type),
          eq(permissions.subjectId, subject.id),
        ),
      ),
    );
    if (!subjectClause) return EMPTY_SCOPE;

    const db = await this.database();
    const rows = await withOrgContext(db, ctx.orgId, (tx) =>
      tx
        .select({
          repoId: permissions.repoId,
          branch: permissions.branch,
          pathPrefix: permissions.pathPrefix,
          effect: permissions.effect,
        })
        .from(permissions)
        .where(
          and(
            eq(permissions.orgId, ctx.orgId),
            subjectClause,
            inArray(permissions.action, ['read', 'write', 'admin']),
            repoId === undefined
              ? undefined
              : or(isNull(permissions.repoId), eq(permissions.repoId, repoId)),
          ),
        ),
    );

    return scopeFromRows(rows);
  }
}

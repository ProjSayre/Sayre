import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AuthContext } from '../auth/context';
import { createDb, createPoolFromSecret, type Db, withOrgContext } from '../db/client';
import { mcpClientKeys, permissions, users } from '../db/schema';

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

function normalizePathPrefix(prefix: string | null): string | null {
  const value = prefix?.trim().replaceAll('\\', '/');
  if (!value || value === '/') return null;
  const rooted = value.startsWith('/') ? value : `/${value}`;
  return rooted.replace(/\/+$/, '');
}

function normalizeRule(row: PermissionRow): AuthorizationRule {
  return {
    repoId: row.repoId,
    branch: normalizeBranch(row.branch),
    pathPrefix: normalizePathPrefix(row.pathPrefix),
  };
}

export function normalizeAuthorizationRule(
  rule: AuthorizationRule,
): AuthorizationRule {
  return {
    repoId: rule.repoId?.trim() || null,
    branch: normalizeBranch(rule.branch),
    pathPrefix: normalizePathPrefix(rule.pathPrefix),
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
    // Only the exact persisted value "allow" grants data. Unknown effects fail
    // closed as denies because the current schema predates CHECK constraints.
    (row.effect === 'allow' ? allows : denies).push(normalizeRule(row));
  }

  return { allows: deduplicate(allows), denies: deduplicate(denies) };
}

function compatibleExact(
  left: string | null,
  right: string | null,
): string | null | undefined {
  if (left === null) return right;
  if (right === null) return left;
  return left === right ? left : undefined;
}

function intersectPath(
  left: string | null,
  right: string | null,
): string | null | undefined {
  if (left === null) return right;
  if (right === null) return left;
  if (left === right || left.startsWith(`${right}/`)) return left;
  if (right.startsWith(`${left}/`)) return right;
  return undefined;
}

function intersectRules(
  left: AuthorizationRule,
  right: AuthorizationRule,
): AuthorizationRule | null {
  const repoId = compatibleExact(left.repoId, right.repoId);
  const branch = compatibleExact(left.branch, right.branch);
  const pathPrefix = intersectPath(left.pathPrefix, right.pathPrefix);
  if (
    repoId === undefined ||
    branch === undefined ||
    pathPrefix === undefined
  ) {
    return null;
  }
  return { repoId, branch, pathPrefix };
}

/**
 * Agent-key reads are always the intersection of their immutable issuance
 * grants and the issuing user's current effective scope. Revoking or narrowing
 * the issuer therefore narrows the key on its very next graph query.
 */
export function intersectReadScopes(
  ceiling: ReadScope,
  issuer: ReadScope,
): ReadScope {
  const allows: AuthorizationRule[] = [];
  for (const keyRule of ceiling.allows) {
    for (const issuerRule of issuer.allows) {
      const intersection = intersectRules(keyRule, issuerRule);
      if (intersection) allows.push(intersection);
    }
  }
  return {
    allows: deduplicate(allows),
    denies: deduplicate([...ceiling.denies, ...issuer.denies]),
  };
}

function ruleContains(
  parent: AuthorizationRule,
  child: AuthorizationRule,
): boolean {
  if (parent.repoId !== null && parent.repoId !== child.repoId) return false;
  if (parent.branch !== null && parent.branch !== child.branch) return false;
  if (parent.pathPrefix === null) return true;
  return (
    child.pathPrefix !== null &&
    (child.pathPrefix === parent.pathPrefix ||
      child.pathPrefix.startsWith(`${parent.pathPrefix}/`))
  );
}

function rulesOverlap(
  left: AuthorizationRule,
  right: AuthorizationRule,
): boolean {
  return intersectRules(left, right) !== null;
}

/** Used by issuance to reject grants broader than the admin's current scope. */
export function isRuleWithinScope(
  input: AuthorizationRule,
  scope: ReadScope,
): boolean {
  const rule = normalizeAuthorizationRule(input);
  return (
    scope.allows.some((allow) => ruleContains(allow, rule)) &&
    !scope.denies.some((deny) => rulesOverlap(deny, rule))
  );
}

export interface ScopedGraphResource {
  repoId: string;
  refName: string;
  path: string;
}

function ruleMatches(rule: AuthorizationRule, resource: ScopedGraphResource): boolean {
  if (rule.repoId !== null && rule.repoId !== resource.repoId) return false;
  if (rule.branch !== null && rule.branch !== resource.refName) return false;
  if (rule.pathPrefix === null) return true;
  return resource.path === rule.pathPrefix || resource.path.startsWith(`${rule.pathPrefix}/`);
}

/** Defense-in-depth mirror of the predicate embedded in each Cypher query. */
export function canReadResource(scope: ReadScope, resource: ScopedGraphResource): boolean {
  return (
    scope.allows.some((rule) => ruleMatches(rule, resource)) &&
    !scope.denies.some((rule) => ruleMatches(rule, resource))
  );
}

export function cypherRules(rules: readonly AuthorizationRule[]): Array<Record<string, string | null>> {
  return rules.map((rule) => ({
    repo_id: rule.repoId,
    branch: rule.branch,
    path_prefix: rule.pathPrefix,
  }));
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

    if (ctx.subjectType === 'agent_key') {
      const db = await this.database();
      return withOrgContext(db, ctx.orgId, async (tx) => {
        const [key] = await tx
          .select({
            createdBy: mcpClientKeys.createdBy,
            revokedAt: mcpClientKeys.revokedAt,
            expiresAt: mcpClientKeys.expiresAt,
          })
          .from(mcpClientKeys)
          .where(
            and(
              eq(mcpClientKeys.orgId, ctx.orgId),
              eq(mcpClientKeys.keyPrefix, ctx.agentKeyId),
            ),
          )
          .limit(1);
        if (
          !key?.createdBy ||
          key.revokedAt !== null ||
          (key.expiresAt !== null && key.expiresAt <= new Date())
        ) {
          return EMPTY_SCOPE;
        }

        const [issuer] = await tx
          .select({ orgRole: users.orgRole })
          .from(users)
          .where(
            and(eq(users.orgId, ctx.orgId), eq(users.id, key.createdBy)),
          )
          .limit(1);
        if (!issuer) return EMPTY_SCOPE;

        const keyRows = await tx
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
              eq(permissions.subjectType, 'agent_key'),
              eq(permissions.subjectId, ctx.agentKeyId),
              inArray(permissions.action, ['read', 'write', 'admin']),
              repoId === undefined
                ? undefined
                : or(isNull(permissions.repoId), eq(permissions.repoId, repoId)),
            ),
          );

        const issuerScope =
          issuer.orgRole === 'owner'
            ? OWNER_SCOPE
            : scopeFromRows(
                await tx
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
                      or(
                        and(
                          eq(permissions.subjectType, 'user'),
                          eq(permissions.subjectId, key.createdBy),
                        ),
                        and(
                          eq(permissions.subjectType, 'role'),
                          eq(permissions.subjectId, issuer.orgRole),
                        ),
                      ),
                      inArray(permissions.action, ['read', 'write', 'admin']),
                      repoId === undefined
                        ? undefined
                        : or(
                            isNull(permissions.repoId),
                            eq(permissions.repoId, repoId),
                          ),
                    ),
                  ),
              );
        return intersectReadScopes(scopeFromRows(keyRows), issuerScope);
      });
    }

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

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { McpCredentialKind, McpReadGrant } from '@sayre/shared-types';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { mcpClientKeys, organizations, permissions, users } from './schema';

export interface McpKeyLookup {
  id: string;
  orgId: string;
  keyPrefix: string;
  keyHmac: string;
  pepperVersion: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  rateLimitPerMinute: number;
  /** CH-01. `null` when the stored value is not a recognized kind — fail closed. */
  kind: McpCredentialKind | null;
  /** CH-01. Non-null only for `kind === 'chat_ephemeral'`. */
  conversationId: string | null;
}

export interface StoredMcpKey {
  id: string;
  name: string;
  keyPrefix: string;
  grants: McpReadGrant[];
  expiresAt: Date | null;
  createdAt: Date;
  createdByLabel: string;
  revokedAt: Date | null;
  revokedByLabel: string | null;
  lastUsedAt: Date | null;
}

export interface StoreMcpKeyInput {
  name: string;
  keyPrefix: string;
  keyHmac: string;
  pepperVersion: number;
  expiresAt: Date | null;
  createdBy: string;
  createdByLabel: string;
  grants: McpReadGrant[];
}

export interface McpKeyStore {
  resolve(keyPrefix: string): Promise<McpKeyLookup | null>;
  list(orgId: string): Promise<StoredMcpKey[]>;
  issue(orgId: string, input: StoreMcpKeyInput): Promise<StoredMcpKey>;
  revoke(
    orgId: string,
    keyId: string,
    actorId: string,
    actorLabel: string,
  ): Promise<StoredMcpKey | null>;
  markUsed(orgId: string, keyPrefix: string, usedAt: Date): Promise<boolean>;
  getRateLimit(orgId: string): Promise<number>;
  setRateLimit(orgId: string, rateLimitPerMinute: number): Promise<number>;
  getActorLabel(orgId: string, userId: string): Promise<string | null>;
}

interface BootstrapRow {
  key_id: string;
  org_id: string;
  key_prefix: string;
  key_hmac: string;
  pepper_version: number;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_by: string | null;
  rate_limit_per_minute: number;
  kind: string;
  conversation_id: string | null;
}

/**
 * CH-01. Maps the raw DB value to the two known kinds, or `null` for
 * anything else (including missing/unrecognized values) — never a
 * default-to-'agent' fallback. Called from `resolve()` only.
 */
function credentialKind(value: unknown): McpCredentialKind | null {
  return value === 'agent' || value === 'chat_ephemeral' ? value : null;
}

export interface PostgresMcpKeyStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresMcpKeyStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

function dateValue(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function grantKey(grant: McpReadGrant): string {
  return JSON.stringify([grant.repoId, grant.branch, grant.pathPrefix]);
}

function toStored(
  row: typeof mcpClientKeys.$inferSelect,
  grants: readonly McpReadGrant[],
): StoredMcpKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    grants: [...grants],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdByLabel: row.createdByLabel ?? 'Deleted administrator',
    revokedAt: row.revokedAt,
    revokedByLabel: row.revokedByLabel,
    lastUsedAt: row.lastUsedAt,
  };
}

export class PostgresMcpKeyStore implements McpKeyStore {
  constructor(
    private readonly deps: PostgresMcpKeyStoreDeps = defaultDeps,
  ) {}

  async resolve(keyPrefix: string): Promise<McpKeyLookup | null> {
    const db = await this.deps.getDb();
    const result = await db.transaction(async (tx) => {
      // The migration grants only this SECURITY DEFINER function to the runtime
      // role. It returns one sanitized row before org_id is known.
      await tx.execute(sql`set local role sayre_app`);
      return tx.execute(
        sql`select * from resolve_mcp_client_key(${keyPrefix})`,
      );
    });
    const row = (result.rows as unknown as BootstrapRow[])[0];
    return row
      ? {
          id: row.key_id,
          orgId: row.org_id,
          keyPrefix: row.key_prefix,
          keyHmac: row.key_hmac,
          pepperVersion: row.pepper_version,
          expiresAt: dateValue(row.expires_at),
          revokedAt: dateValue(row.revoked_at),
          createdBy: row.created_by,
          rateLimitPerMinute: row.rate_limit_per_minute,
          kind: credentialKind(row.kind),
          conversationId: row.conversation_id,
        }
      : null;
  }

  async list(orgId: string): Promise<StoredMcpKey[]> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const keyRows = await tx
        .select()
        .from(mcpClientKeys)
        .where(
          and(eq(mcpClientKeys.orgId, orgId), eq(mcpClientKeys.kind, 'agent')),
        )
        .orderBy(mcpClientKeys.createdAt);
      const prefixes = keyRows.map((row) => row.keyPrefix);
      const grantRows =
        prefixes.length === 0
          ? []
          : await tx
              .select({
                subjectId: permissions.subjectId,
                repoId: permissions.repoId,
                branch: permissions.branch,
                pathPrefix: permissions.pathPrefix,
              })
              .from(permissions)
              .where(
                and(
                  eq(permissions.orgId, orgId),
                  eq(permissions.subjectType, 'agent_key'),
                  eq(permissions.action, 'read'),
                  eq(permissions.effect, 'allow'),
                  inArray(permissions.subjectId, prefixes),
                ),
              );
      const byPrefix = new Map<string, McpReadGrant[]>();
      for (const grant of grantRows) {
        const values = byPrefix.get(grant.subjectId) ?? [];
        values.push({
          repoId: grant.repoId,
          branch: grant.branch,
          pathPrefix: grant.pathPrefix,
        });
        byPrefix.set(grant.subjectId, values);
      }
      return keyRows
        .map((row) => {
          const grants = byPrefix.get(row.keyPrefix) ?? [];
          grants.sort((left, right) =>
            grantKey(left).localeCompare(grantKey(right)),
          );
          return toStored(row, grants);
        })
        .reverse();
    });
  }

  async issue(
    orgId: string,
    input: StoreMcpKeyInput,
  ): Promise<StoredMcpKey> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(mcpClientKeys)
        .values({
          orgId,
          name: input.name,
          keyPrefix: input.keyPrefix,
          keyHmac: input.keyHmac,
          pepperVersion: input.pepperVersion,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          createdByLabel: input.createdByLabel,
        })
        .returning();
      if (!row) throw new Error('MCP key insert returned no row.');
      await tx.insert(permissions).values(
        input.grants.map((grant) => ({
          orgId,
          subjectType: 'agent_key',
          subjectId: input.keyPrefix,
          repoId: grant.repoId,
          branch: grant.branch,
          pathPrefix: grant.pathPrefix,
          action: 'read',
          effect: 'allow',
        })),
      );
      return toStored(row, input.grants);
    });
  }

  async revoke(
    orgId: string,
    keyId: string,
    actorId: string,
    actorLabel: string,
  ): Promise<StoredMcpKey | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(mcpClientKeys)
        .set({
          revokedAt: new Date(),
          revokedBy: actorId,
          revokedByLabel: actorLabel,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpClientKeys.orgId, orgId),
            eq(mcpClientKeys.id, keyId),
            eq(mcpClientKeys.kind, 'agent'),
            isNull(mcpClientKeys.revokedAt),
          ),
        )
        .returning();
      if (!row) return null;
      const grantRows = await tx
        .select({
          repoId: permissions.repoId,
          branch: permissions.branch,
          pathPrefix: permissions.pathPrefix,
        })
        .from(permissions)
        .where(
          and(
            eq(permissions.orgId, orgId),
            eq(permissions.subjectType, 'agent_key'),
            eq(permissions.subjectId, row.keyPrefix),
            eq(permissions.action, 'read'),
            eq(permissions.effect, 'allow'),
          ),
        );
      return toStored(row, grantRows);
    });
  }

  async markUsed(
    orgId: string,
    keyPrefix: string,
    usedAt: Date,
  ): Promise<boolean> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const rows = await tx
        .update(mcpClientKeys)
        .set({ lastUsedAt: usedAt, updatedAt: usedAt })
        .where(
          and(
            eq(mcpClientKeys.orgId, orgId),
            eq(mcpClientKeys.keyPrefix, keyPrefix),
            isNull(mcpClientKeys.revokedAt),
          ),
        )
        .returning({ id: mcpClientKeys.id });
      return rows.length === 1;
    });
  }

  async getRateLimit(orgId: string): Promise<number> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .select({ value: organizations.mcpRateLimitPerMinute })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!row) throw new Error('Organization not found.');
      return row.value;
    });
  }

  async setRateLimit(
    orgId: string,
    rateLimitPerMinute: number,
  ): Promise<number> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(organizations)
        .set({
          mcpRateLimitPerMinute: rateLimitPerMinute,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, orgId))
        .returning({ value: organizations.mcpRateLimitPerMinute });
      if (!row) throw new Error('Organization not found.');
      return row.value;
    });
  }

  async getActorLabel(orgId: string, userId: string): Promise<string | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.id, userId)))
        .limit(1);
      return row ? row.name?.trim() || row.email : null;
    });
  }
}

export const mcpKeyStore: McpKeyStore = new PostgresMcpKeyStore();

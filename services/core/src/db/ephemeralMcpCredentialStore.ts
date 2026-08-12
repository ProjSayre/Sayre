// CH-01. Postgres store for the `chat_ephemeral` half of `mcp_client_keys`,
// mirroring `db/mcpKeyStore.ts`'s shape: a plain interface + a `Postgres*Store`
// implementation backed by `withOrgContext` (RLS), plus a module-level
// singleton export.
//
// `issue()` writes the key row and its ceiling `permissions` rows inside ONE
// `withOrgContext` transaction — see spec.md's "Why the credential lives in
// mcp_client_keys" note: those `permissions` rows, with `subject_type =
// 'agent_key'` and `subject_id = <key prefix>`, are what let the existing
// agent-key RBAC-ceiling machinery in graph-query/permissions.ts apply with
// zero changes to that file.

import { and, eq, inArray, lte } from 'drizzle-orm';
import type { McpReadGrant } from '@sayre/shared-types';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { mcpClientKeys, permissions, users } from './schema';

/** Mint-time snapshot of the issuer's effective scope, persisted as `permissions` rows. */
export interface EphemeralScopeSnapshot {
  allows: McpReadGrant[];
  denies: McpReadGrant[];
}

export interface StoreEphemeralMcpCredentialInput {
  keyPrefix: string;
  keyHmac: string;
  pepperVersion: number;
  conversationId: string;
  /** Written to `created_at` explicitly so the DB TTL CHECK compares one clock. */
  issuedAt: Date;
  expiresAt: Date;
  createdBy: string;
  createdByLabel: string;
  ceiling: EphemeralScopeSnapshot;
}

export interface StoredEphemeralMcpCredential {
  id: string;
  keyPrefix: string;
  conversationId: string;
  createdAt: Date;
  createdBy: string | null;
  createdByLabel: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface EphemeralMcpCredentialStore {
  /** Inserts the key row and its ceiling `permissions` rows in ONE transaction. */
  issue(
    orgId: string,
    input: StoreEphemeralMcpCredentialInput,
  ): Promise<StoredEphemeralMcpCredential>;
  /** `issuedBy === null` means "every issuer in this org" (admin/owner read). */
  listByConversation(
    orgId: string,
    conversationId: string,
    issuedBy: string | null,
  ): Promise<StoredEphemeralMcpCredential[]>;
  /** Deletes expired `chat_ephemeral` rows and their `permissions` rows. Returns rows deleted. */
  deleteExpired(orgId: string, before: Date, limit: number): Promise<number>;
  getActorLabel(orgId: string, userId: string): Promise<string | null>;
}

export interface PostgresEphemeralMcpCredentialStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: PostgresEphemeralMcpCredentialStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

/** Ceiling rows are always written NOT NULL — a missing label falls back like `createdByLabel` elsewhere. */
const EPHEMERAL_CREDENTIAL_NAME = 'Ask Sayre chat session';

function toStored(
  row: typeof mcpClientKeys.$inferSelect,
): StoredEphemeralMcpCredential {
  if (row.conversationId === null || row.expiresAt === null) {
    // The DB shape CHECK already guarantees this for kind='chat_ephemeral'
    // rows; this is defense in depth against a caller misusing the store.
    throw new Error('Ephemeral credential row is missing its required shape.');
  }
  return {
    id: row.id,
    keyPrefix: row.keyPrefix,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    createdByLabel: row.createdByLabel ?? 'Deleted user',
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export class PostgresEphemeralMcpCredentialStore
  implements EphemeralMcpCredentialStore
{
  constructor(
    private readonly deps: PostgresEphemeralMcpCredentialStoreDeps = defaultDeps,
  ) {}

  async issue(
    orgId: string,
    input: StoreEphemeralMcpCredentialInput,
  ): Promise<StoredEphemeralMcpCredential> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .insert(mcpClientKeys)
        .values({
          orgId,
          name: EPHEMERAL_CREDENTIAL_NAME,
          keyPrefix: input.keyPrefix,
          keyHmac: input.keyHmac,
          pepperVersion: input.pepperVersion,
          kind: 'chat_ephemeral',
          conversationId: input.conversationId,
          createdAt: input.issuedAt,
          updatedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          createdByLabel: input.createdByLabel,
        })
        .returning();
      if (!row) throw new Error('Ephemeral MCP credential insert returned no row.');

      const ceilingRows = [
        ...input.ceiling.allows.map((grant) => ({ ...grant, effect: 'allow' as const })),
        ...input.ceiling.denies.map((grant) => ({ ...grant, effect: 'deny' as const })),
      ];
      if (ceilingRows.length > 0) {
        await tx.insert(permissions).values(
          ceilingRows.map((grant) => ({
            orgId,
            subjectType: 'agent_key',
            subjectId: input.keyPrefix,
            repoId: grant.repoId,
            branch: grant.branch,
            pathPrefix: grant.pathPrefix,
            action: 'read',
            effect: grant.effect,
          })),
        );
      }

      return toStored(row);
    });
  }

  async listByConversation(
    orgId: string,
    conversationId: string,
    issuedBy: string | null,
  ): Promise<StoredEphemeralMcpCredential[]> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(mcpClientKeys)
        .where(
          and(
            eq(mcpClientKeys.orgId, orgId),
            eq(mcpClientKeys.kind, 'chat_ephemeral'),
            eq(mcpClientKeys.conversationId, conversationId),
            issuedBy === null ? undefined : eq(mcpClientKeys.createdBy, issuedBy),
          ),
        )
        .orderBy(mcpClientKeys.createdAt);
      return rows.map(toStored);
    });
  }

  async deleteExpired(orgId: string, before: Date, limit: number): Promise<number> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const due = await tx
        .select({ keyPrefix: mcpClientKeys.keyPrefix })
        .from(mcpClientKeys)
        .where(
          and(
            eq(mcpClientKeys.orgId, orgId),
            eq(mcpClientKeys.kind, 'chat_ephemeral'),
            lte(mcpClientKeys.expiresAt, before),
          ),
        )
        .orderBy(mcpClientKeys.createdAt)
        .limit(limit);
      const prefixes = due.map((row) => row.keyPrefix);
      if (prefixes.length === 0) return 0;

      // Ceiling rows first, then the key rows, so a mid-transaction failure
      // never leaves an orphaned ceiling for a deleted credential.
      await tx
        .delete(permissions)
        .where(
          and(
            eq(permissions.orgId, orgId),
            eq(permissions.subjectType, 'agent_key'),
            inArray(permissions.subjectId, prefixes),
          ),
        );
      const deleted = await tx
        .delete(mcpClientKeys)
        .where(
          and(
            eq(mcpClientKeys.orgId, orgId),
            eq(mcpClientKeys.kind, 'chat_ephemeral'),
            inArray(mcpClientKeys.keyPrefix, prefixes),
          ),
        )
        .returning({ keyPrefix: mcpClientKeys.keyPrefix });
      return deleted.length;
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

export const ephemeralMcpCredentialStore: EphemeralMcpCredentialStore =
  new PostgresEphemeralMcpCredentialStore();

// Postgres store for `jira_connections` (W3-10), mirroring `db/mcpKeyStore.ts`'s
// shape: a plain interface + a `Postgres*Store` implementation backed by
// `withOrgContext` (RLS), plus a module-level singleton export.
//
// SECURITY-SENSITIVE (.claude/rules/security-multitenancy.md): this module,
// `integrations/tickets/jira/orgSecrets.ts`, and `db/schema.ts`'s definition
// site are the ONLY places allowed to reference `jiraAccessTokenEnc` /
// `jiraRefreshTokenEnc` (`jira_access_token_enc` / `jira_refresh_token_enc`) —
// enforced by `scripts/check-org-secret-access.mjs` in CI. Every token column
// is encrypted on write / decrypted on read via `jiraTokenCipher` — this store
// never returns raw ciphertext to a caller, and never accepts plaintext that
// it doesn't immediately encrypt.

import { and, eq, isNull } from 'drizzle-orm';
import { withOrgContext, type Db } from './client';
import { getRuntimeDb } from './installations';
import { jiraConnections } from './schema';
import {
  decryptToken,
  encryptToken,
} from '../integrations/tickets/jira/jiraTokenCipher';

/** Decrypted row, for internal use only (orgSecrets.ts / the refresh path). Never serialized toward the browser. */
export interface JiraConnectionRow {
  id: string;
  orgId: string;
  cloudId: string;
  siteUrl: string;
  siteName: string | null;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string | null;
  connectedByUserId: string | null;
  connectedByLabel: string;
  connectedByAccountId: string | null;
  lastSyncedAt: Date | null;
  connectedAt: Date;
  revokedAt: Date | null;
}

/** Safe projection toward the UI — NO tokens, NO cloudId, NO org_id echo. */
export interface JiraConnectionStatusView {
  connected: boolean;
  siteUrl: string;
  siteName: string | null;
  connectedByLabel: string;
  connectedByAccountId: string | null;
  lastSyncedAt: Date | null;
  connectedAt: Date;
}

export interface ConnectJiraInput {
  cloudId: string;
  siteUrl: string;
  siteName: string | null;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
  connectedByUserId: string;
  connectedByLabel: string;
  connectedByAccountId: string;
}

export interface RefreshJiraTokensInput {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}

/** Handed to `withLockedActiveConnection`'s callback while the row lock is held. */
export interface LockedJiraConnection {
  row: JiraConnectionRow;
  /** Persists rotated tokens onto the SAME locked row, inside the SAME transaction. */
  persistRefresh(next: RefreshJiraTokensInput): Promise<void>;
  /** Soft-revokes the SAME locked row (e.g. on `invalid_grant`), inside the SAME transaction. */
  revoke(): Promise<void>;
}

export interface JiraConnectionStore {
  /** Upsert the single active connection for the org (revoke any prior active row first, or reuse). */
  connect(
    orgId: string,
    input: ConnectJiraInput,
  ): Promise<JiraConnectionStatusView>;
  /** Active (revoked_at IS NULL) row incl. decrypted tokens, or null. Not locked — see withLockedActiveConnection for the refresh path. */
  resolveActive(orgId: string): Promise<JiraConnectionRow | null>;
  /** Locks the active row (SELECT … FOR UPDATE), re-checks expiry, and persists rotated tokens. */
  refreshTokens(orgId: string, next: RefreshJiraTokensInput): Promise<void>;
  softRevoke(
    orgId: string,
    actorUserId: string | null,
    actorLabel: string | null,
  ): Promise<JiraConnectionStatusView | null>;
  touchLastSynced(orgId: string, at: Date): Promise<void>;
  statusView(orgId: string): Promise<JiraConnectionStatusView | null>;
  /**
   * Beyond spec.md's literal five methods above (see .pipeline/changes.md
   * "Decisions made"): holds one Postgres row lock (`SELECT … FOR UPDATE`)
   * across `fn`, which may itself perform the Jira token-refresh network call
   * before persisting — this is what actually prevents two concurrent jobs
   * from both spending the same (single-use, rotating) Jira refresh token.
   * `resolveActive` + `refreshTokens` alone cannot express this: they are two
   * independent transactions with an unlocked window in between. Returns
   * `null` (and never invokes `fn`) when there is no active connection.
   */
  withLockedActiveConnection<T>(
    orgId: string,
    fn: (locked: LockedJiraConnection) => Promise<T>,
  ): Promise<T | null>;
}

interface JiraConnectionStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

const defaultDeps: JiraConnectionStoreDeps = {
  getDb: getRuntimeDb,
  withOrg: withOrgContext,
};

type JiraConnectionSelectRow = typeof jiraConnections.$inferSelect;

async function toRow(row: JiraConnectionSelectRow): Promise<JiraConnectionRow> {
  if (row.jiraAccessTokenEnc === null || row.jiraRefreshTokenEnc === null) {
    // Only an active row is ever decoded into a JiraConnectionRow; a revoked
    // row's tokens are already nulled and must never reach a caller expecting
    // a usable credential.
    throw new Error('Jira connection row has no usable (revoked) tokens.');
  }
  const [accessToken, refreshToken] = await Promise.all([
    decryptToken(row.jiraAccessTokenEnc),
    decryptToken(row.jiraRefreshTokenEnc),
  ]);
  return {
    id: row.id,
    orgId: row.orgId,
    cloudId: row.cloudId,
    siteUrl: row.siteUrl,
    siteName: row.siteName,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scopes: row.scopes,
    connectedByUserId: row.connectedByUserId,
    connectedByLabel: row.connectedByLabel,
    connectedByAccountId: row.connectedByAccountId,
    lastSyncedAt: row.lastSyncedAt,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
  };
}

function toStatusView(row: JiraConnectionSelectRow): JiraConnectionStatusView {
  return {
    connected: row.revokedAt === null,
    siteUrl: row.siteUrl,
    siteName: row.siteName,
    connectedByLabel: row.connectedByLabel,
    connectedByAccountId: row.connectedByAccountId,
    lastSyncedAt: row.lastSyncedAt,
    connectedAt: row.connectedAt,
  };
}

export class PostgresJiraConnectionStore implements JiraConnectionStore {
  constructor(private readonly deps: JiraConnectionStoreDeps = defaultDeps) {}

  async connect(
    orgId: string,
    input: ConnectJiraInput,
  ): Promise<JiraConnectionStatusView> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
        encryptToken(input.accessToken),
        encryptToken(input.refreshToken),
      ]);
      const now = new Date();
      const shared = {
        cloudId: input.cloudId,
        siteUrl: input.siteUrl,
        siteName: input.siteName,
        jiraAccessTokenEnc: accessTokenEnc,
        jiraRefreshTokenEnc: refreshTokenEnc,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        scopes: input.scopes,
        connectedByUserId: input.connectedByUserId,
        connectedByLabel: input.connectedByLabel,
        connectedByAccountId: input.connectedByAccountId,
      };

      // Reconnect-while-connected supersedes the SAME active row in place
      // (rather than revoke-then-insert) so the partial-unique active-row
      // index never has to arbitrate a transient two-row state.
      const [updated] = await tx
        .update(jiraConnections)
        .set({
          ...shared,
          lastSyncedAt: null,
          connectedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .returning();
      if (updated) return toStatusView(updated);

      const [inserted] = await tx
        .insert(jiraConnections)
        .values({ orgId, ...shared })
        .returning();
      if (!inserted) throw new Error('Jira connection insert returned no row.');
      return toStatusView(inserted);
    });
  }

  async resolveActive(orgId: string): Promise<JiraConnectionRow | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(jiraConnections)
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .limit(1);
      return row ? toRow(row) : null;
    });
  }

  async refreshTokens(
    orgId: string,
    next: RefreshJiraTokensInput,
  ): Promise<void> {
    const db = await this.deps.getDb();
    await this.deps.withOrg(db, orgId, async (tx) => {
      // Use the query builder's own row-typed `.for('update')` (drizzle-orm
      // 0.38+), NOT a raw `tx.execute(sql\`...\`)` -- a raw query returns
      // snake_case column keys straight from `pg`, which silently produced
      // `undefined` when later code (mistakenly) read them as the
      // camelCase-keyed `JiraConnectionSelectRow` shape (caught during manual
      // verification against a real Postgres instance; see
      // .pipeline/changes.md "Decisions made").
      const [lockedRow] = await tx
        .select({ id: jiraConnections.id })
        .from(jiraConnections)
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .for('update')
        .limit(1);
      if (!lockedRow) return; // Revoked/absent since the caller last checked — nothing to persist.

      const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
        encryptToken(next.accessToken),
        encryptToken(next.refreshToken),
      ]);
      await tx
        .update(jiraConnections)
        .set({
          jiraAccessTokenEnc: accessTokenEnc,
          jiraRefreshTokenEnc: refreshTokenEnc,
          accessTokenExpiresAt: next.accessTokenExpiresAt,
          scopes: next.scopes,
          updatedAt: new Date(),
        })
        .where(eq(jiraConnections.id, lockedRow.id));
    });
  }

  async softRevoke(
    orgId: string,
    actorUserId: string | null,
    actorLabel: string | null,
  ): Promise<JiraConnectionStatusView | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .update(jiraConnections)
        .set({
          revokedAt: new Date(),
          revokedBy: actorUserId,
          revokedByLabel: actorLabel,
          // Null out both encrypted token columns to shrink the at-rest blast
          // radius (spec.md "Disconnect / revocation") — the row is retained
          // for audit, the tokens are not.
          jiraAccessTokenEnc: null,
          jiraRefreshTokenEnc: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .returning();
      return row ? toStatusView(row) : null;
    });
  }

  async touchLastSynced(orgId: string, at: Date): Promise<void> {
    const db = await this.deps.getDb();
    await this.deps.withOrg(db, orgId, async (tx) => {
      await tx
        .update(jiraConnections)
        .set({ lastSyncedAt: at, updatedAt: at })
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        );
    });
  }

  async statusView(orgId: string): Promise<JiraConnectionStatusView | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(jiraConnections)
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .limit(1);
      return row ? toStatusView(row) : null;
    });
  }

  async withLockedActiveConnection<T>(
    orgId: string,
    fn: (locked: LockedJiraConnection) => Promise<T>,
  ): Promise<T | null> {
    const db = await this.deps.getDb();
    return this.deps.withOrg(db, orgId, async (tx) => {
      // Query-builder `.for('update')` (drizzle-orm 0.38+), NOT raw SQL — see
      // refreshTokens()'s matching comment for why a raw `tx.execute(sql\`...\`)`
      // row here is unsafe (snake_case keys silently mismatch the camelCase
      // `JiraConnectionSelectRow` shape `toRow()` expects).
      const [lockedRow] = await tx
        .select()
        .from(jiraConnections)
        .where(
          and(eq(jiraConnections.orgId, orgId), isNull(jiraConnections.revokedAt)),
        )
        .for('update')
        .limit(1);
      if (!lockedRow) return null;

      const row = await toRow(lockedRow);
      return fn({
        row,
        persistRefresh: async (next) => {
          const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
            encryptToken(next.accessToken),
            encryptToken(next.refreshToken),
          ]);
          await tx
            .update(jiraConnections)
            .set({
              jiraAccessTokenEnc: accessTokenEnc,
              jiraRefreshTokenEnc: refreshTokenEnc,
              accessTokenExpiresAt: next.accessTokenExpiresAt,
              scopes: next.scopes,
              updatedAt: new Date(),
            })
            .where(eq(jiraConnections.id, lockedRow.id));
        },
        revoke: async () => {
          await tx
            .update(jiraConnections)
            .set({
              revokedAt: new Date(),
              jiraAccessTokenEnc: null,
              jiraRefreshTokenEnc: null,
              updatedAt: new Date(),
            })
            .where(eq(jiraConnections.id, lockedRow.id));
        },
      });
    });
  }
}

export const jiraConnectionStore: JiraConnectionStore =
  new PostgresJiraConnectionStore();

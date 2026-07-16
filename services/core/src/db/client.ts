// Postgres client factory + the per-request org session-context transaction
// wrapper. Tenant isolation is enforced by PostgreSQL Row-Level Security
// (see drizzle/0001_*_rls_and_role.sql); this module only ever sets the
// transaction-local `app.org_id` GUC that those policies read. It never
// implements node-level (org/repo/branch/path) RBAC itself — see
// .claude/rules/security-multitenancy.md.

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getSecret, type SecretRef } from "@sayre/config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Creates a `pg` connection pool. Fails fast (no hung connection) when
 * the resolved database URL is missing rather than letting `pg` attempt a default
 * localhost connection silently.
 */
export function createPool(url: string | undefined): Pool {
  if (!url) {
    throw new Error(
      "createPool: resolved database URL is not set. Provide the appropriate secret reference via infra/.env (see infra/.env.example) or the environment.",
    );
  }
  return new Pool({ connectionString: url });
}

/** Resolve the credential-bearing DSN before constructing the pg client. */
export async function createPoolFromSecret(
  ref: SecretRef | string = "env://DATABASE_RUNTIME_URL",
): Promise<Pool> {
  return createPool(await getSecret(ref));
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction with `app.org_id` set (transaction-local) so
 * RLS scopes every statement to `orgId`. `orgId` is SERVER-INJECTED — never
 * accept it from client input (see .claude/rules/security-multitenancy.md).
 *
 * Key invariants:
 *  (a) `set_config(..., true)` is transaction-local (is_local = true) — it
 *      MUST run inside the transaction so a pooled connection never carries
 *      stale org context into the next checkout from the pool.
 *  (b) `orgId` is validated as a UUID before any SQL is issued; a malformed
 *      value never reaches Postgres.
 */
export async function withOrgContext<T>(
  db: Db,
  orgId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    throw new Error("withOrgContext: orgId must be a UUID");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

// Postgres client factory + the per-request org session-context transaction
// wrapper. Tenant isolation is enforced by PostgreSQL Row-Level Security
// (see drizzle/0001_*_rls_and_role.sql); this module only ever sets the
// transaction-local `app.org_id` GUC that those policies read. It never
// implements node-level (org/repo/branch/path) RBAC itself — see
// .claude/rules/security-multitenancy.md.

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Creates a `pg` connection pool. Fails fast (no hung connection) when
 * `DATABASE_URL` is missing rather than letting `pg` attempt a default
 * localhost connection silently.
 */
export function createPool(url: string | undefined = process.env.DATABASE_URL): Pool {
  if (!url) {
    throw new Error(
      "createPool: DATABASE_URL is not set. Provide it via infra/.env (see infra/.env.example) or the environment.",
    );
  }
  return new Pool({ connectionString: url });
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
 *  (a) `SET LOCAL ROLE sayre_app` drops the connection off the login role
 *      (`sayre_dev`, a superuser in local dev per infra/.env.example) onto
 *      the NOBYPASSRLS, non-owner runtime role, BEFORE `set_config` runs —
 *      without this, FORCE-RLS is silently bypassed and tenant queries are
 *      NOT actually isolated (this was a live defect; see W0-05 v2 spec.md
 *      "client.ts — the RLS-enforcement fix"). `SET LOCAL` is transaction-
 *      scoped, so it auto-resets on commit/rollback — pool-safe.
 *  (b) `set_config(..., true)` is transaction-local (is_local = true) — it
 *      MUST run inside the transaction so a pooled connection never carries
 *      stale org context into the next checkout from the pool.
 *  (c) `orgId` is validated as a UUID before any SQL is issued; a malformed
 *      value never reaches Postgres.
 *
 * Deployment dependency: this works in local dev because the login role
 * (`sayre_dev`) is a superuser (superusers may `SET ROLE` to any role). In
 * production, the login role must be `GRANT`ed membership in `sayre_app` —
 * that grant is a later infra concern (already flagged in 0001's header
 * comment). This fix is fail-closed if the membership is missing (`SET
 * LOCAL ROLE` errors rather than silently bypassing RLS).
 *
 * The migrate/admin path (`migrate.ts`, any direct `createDb(pool)` use)
 * does NOT go through `withOrgContext` and is unaffected — migrations must
 * run as the superuser/owner.
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
    // Role name is a trusted constant, not user input -- a static
    // `sql`set local role sayre_app`` (no interpolation) is correct; `SET
    // ROLE` takes an identifier, not a bindable value.
    await tx.execute(sql`set local role sayre_app`);
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

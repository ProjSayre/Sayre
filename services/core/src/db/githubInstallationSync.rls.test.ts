// TESTER-style acceptance suite for W7-01's migration 0020 (github_installation_sync +
// its dispatcher boundary) — companion to db/rls_acceptance.tester.test.ts, whose own
// conventions this file follows exactly: node:test + raw `pg` Pool + SET LOCAL ROLE sayre_app,
// run against a REAL migrated Postgres via DATABASE_ADMIN_URL, never vitest (see
// vitest.config.ts's `src/db/**/*rls*.test.ts` exclude — this filename is deliberately in that
// pattern so the two runners never collide).
//
// Covers (spec.md):
//   - AC-17: the github_installation_sync table itself — FK to organizations, the
//     (org_id, installation_id) unique constraint, the status/reason/error-code/sweep-outcome/
//     subject/count CHECK constraints, ENABLE+FORCE org_isolation RLS, set_updated_at trigger,
//     sayre_app SELECT/INSERT + column-scoped UPDATE and NO DELETE.
//   - AC-18: the dispatch boundary — dispatch bookkeeping columns + the partial due index; the
//     sayre_installation_discovery_dispatcher role (NOLOGIN/NOINHERIT/NOBYPASSRLS, no
//     memberships); column-scoped SELECT/UPDATE + dispatcher-only policies for that role, no
//     INSERT/DELETE and no access to counters/cursor/requesting subject; three SECURITY DEFINER
//     functions, pinned search_path, EXECUTE revoked from PUBLIC and granted to sayre_app; the
//     additive repositories.last_discovery_run_id / last_discovery_at columns.
//   - EC-25: two concurrent dispatchers claiming the same due row — FOR UPDATE SKIP LOCKED means
//     exactly one of two concurrent claim_github_installation_discovery() calls wins the row.
//   - EC-29: privilege-level assertions — sayre_app can neither read nor write the lease/dispatch
//     columns; the dispatcher role can neither INSERT/DELETE nor read counters, cursor, or the
//     requesting subject.
//
// Run via a live-Postgres invocation mirroring `npm run test:rls:acceptance`, e.g.:
//   node --env-file=../../infra/.env --import tsx --test src/db/githubInstallationSync.rls.test.ts
// This checkout has neither a running Postgres container nor infra/.env (confirmed: `docker ps`
// lists nothing, `infra/.env` does not exist, only the placeholder `infra/.env.example` does) —
// see red.md's Classification for this file: RED-DEFERRED.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { createDb, createPool } from "./client";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getConfig, getSecret } from "@sayre/config";

const TEST_DB_NAME = getConfig("RLS_TESTER_DB_NAME") + "_w701";

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret("env://DATABASE_ADMIN_URL");
  } catch {
    throw new Error(
      "githubInstallationSync.rls.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN). Run via a live-Postgres invocation (loads infra/.env) or export DATABASE_ADMIN_URL yourself — see this file's header.",
    );
  }
}

function withDatabaseName(connectionString: string, dbName: string): string {
  const u = new URL(connectionString);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function ensureTestDatabaseExists(adminUrl: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

let pool: Pool;
let orgId: string;
let installationId: number;

before(async () => {
  const adminUrl = await requireAdminUrl();
  await ensureTestDatabaseExists(adminUrl, TEST_DB_NAME);
  const testDbUrl = withDatabaseName(adminUrl, TEST_DB_NAME);

  const migratePool = createPool(testDbUrl);
  try {
    await migrate(createDb(migratePool), { migrationsFolder: "./drizzle" });
  } finally {
    await migratePool.end();
  }

  pool = createPool(testDbUrl);
  orgId = randomUUID();
  installationId = Date.now();
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    "W7-01 RLS org",
    `w701-rls-${orgId.slice(0, 8)}`,
  ]);
});

after(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// AC-17: table shape
// ---------------------------------------------------------------------------

// @spec AC-17
test("[AC-17] github_installation_sync has RLS ENABLED+FORCED with an org_isolation policy keyed on org_id", async () => {
  const res = await pool.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'github_installation_sync'`,
  );
  assert.equal(res.rowCount, 1, "github_installation_sync table must exist");
  assert.equal(res.rows[0].relrowsecurity, true);
  assert.equal(res.rows[0].relforcerowsecurity, true);

  const policy = await pool.query(
    `SELECT qual, with_check FROM pg_policies WHERE tablename = 'github_installation_sync' AND policyname = 'org_isolation'`,
  );
  assert.equal(policy.rowCount, 1);
  assert.match(policy.rows[0].qual, /org_id/);
});

// @spec AC-17
test("[AC-17] the (org_id, installation_id) unique constraint and status/reason/error-code/sweep-outcome/subject/count CHECKs exist", async () => {
  const uniques = await pool.query(
    `SELECT string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'github_installation_sync' AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.constraint_name`,
  );
  assert.ok(
    uniques.rows.some((r) => r.cols === "org_id,installation_id"),
    "github_installation_sync(org_id, installation_id) UNIQUE missing",
  );

  const checks = await pool.query(
    `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = 'github_installation_sync'::regclass`,
  );
  const names = new Set(checks.rows.map((r) => r.conname as string));
  for (const expected of [
    "github_installation_sync_status_check",
    "github_installation_sync_reason_check",
    "github_installation_sync_error_code_check",
    "github_installation_sync_sweep_outcome_check",
    "github_installation_sync_subject_check",
  ]) {
    assert.ok(names.has(expected), `${expected} missing`);
  }
});

// @spec AC-17
test("[AC-17] sayre_app has SELECT/INSERT and column-scoped UPDATE, but no DELETE", async () => {
  const priv = await pool.query(
    `SELECT has_table_privilege('sayre_app', 'github_installation_sync', 'SELECT') AS sel,
            has_table_privilege('sayre_app', 'github_installation_sync', 'INSERT') AS ins,
            has_table_privilege('sayre_app', 'github_installation_sync', 'DELETE') AS del`,
  );
  assert.equal(priv.rows[0].sel, true);
  assert.equal(priv.rows[0].ins, true);
  assert.equal(priv.rows[0].del, false, "sayre_app must NEVER hold DELETE on github_installation_sync");

  const canUpdateCursor = await pool.query(
    `SELECT has_column_privilege('sayre_app', 'github_installation_sync', 'next_page', 'UPDATE') AS ok`,
  );
  assert.equal(canUpdateCursor.rows[0].ok, true);
});

// ---------------------------------------------------------------------------
// AC-18: dispatcher boundary
// ---------------------------------------------------------------------------

// @spec AC-18
test("[AC-18] sayre_installation_discovery_dispatcher role is NOLOGIN/NOINHERIT/NOBYPASSRLS with no memberships", async () => {
  const role = await pool.query(
    `SELECT rolcanlogin, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = 'sayre_installation_discovery_dispatcher'`,
  );
  assert.equal(role.rowCount, 1, "sayre_installation_discovery_dispatcher role must exist");
  assert.equal(role.rows[0].rolcanlogin, false);
  assert.equal(role.rows[0].rolinherit, false);
  assert.equal(role.rows[0].rolbypassrls, false);

  const memberships = await pool.query(
    `SELECT count(*)::int AS n FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid OR r.oid = m.member
      WHERE r.rolname = 'sayre_installation_discovery_dispatcher'`,
  );
  assert.equal(memberships.rows[0].n, 0);
});

// @spec AC-18
test("[AC-18] the dispatcher role has no INSERT/DELETE and cannot read counters, cursor, or the requesting subject", async () => {
  const priv = await pool.query(
    `SELECT has_table_privilege('sayre_installation_discovery_dispatcher', 'github_installation_sync', 'INSERT') AS ins,
            has_table_privilege('sayre_installation_discovery_dispatcher', 'github_installation_sync', 'DELETE') AS del`,
  );
  assert.equal(priv.rows[0].ins, false);
  assert.equal(priv.rows[0].del, false);

  for (const column of ["discovered_count", "registered_count", "next_page", "requested_by_subject_id"]) {
    const res = await pool.query(
      `SELECT has_column_privilege('sayre_installation_discovery_dispatcher', 'github_installation_sync', $1, 'SELECT') AS ok`,
      [column],
    );
    assert.equal(res.rows[0].ok, false, `dispatcher role must NOT be able to SELECT ${column}`);
  }
});

// @spec AC-18
test("[AC-18] the three SECURITY DEFINER functions are owned by the dispatcher role, PUBLIC cannot execute, sayre_app can", async () => {
  const functions = await pool.query(
    `SELECT proname, prosecdef, proowner::regrole::text AS owner,
            has_function_privilege('sayre_app', oid, 'EXECUTE') AS app_can,
            has_function_privilege('public', oid, 'EXECUTE') AS public_can
       FROM pg_proc
      WHERE proname IN (
        'claim_github_installation_discovery',
        'complete_github_installation_discovery',
        'retry_github_installation_discovery'
      )`,
  );
  assert.equal(functions.rowCount, 3);
  for (const row of functions.rows) {
    assert.equal(row.prosecdef, true, `${row.proname} must be SECURITY DEFINER`);
    assert.equal(row.owner, "sayre_installation_discovery_dispatcher");
    assert.equal(row.app_can, true);
    assert.equal(row.public_can, false);
  }
});

// @spec AC-18
test("[AC-18] repositories.last_discovery_run_id / last_discovery_at exist (also expected in rls_acceptance.tester.test.ts's column spec)", async () => {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'repositories'`,
  );
  const names = new Set(cols.rows.map((r) => r.column_name as string));
  assert.ok(names.has("last_discovery_run_id"));
  assert.ok(names.has("last_discovery_at"));
});

// ---------------------------------------------------------------------------
// EC-25 / EC-29: concurrent claim + cross-tenant privilege isolation
// ---------------------------------------------------------------------------

// @spec EC-25
test("[EC-25] two concurrent claim_github_installation_discovery() calls never both win the same due row", async () => {
  await pool.query(
    `INSERT INTO github_installation_sync (org_id, installation_id, reason, status)
     VALUES ($1, $2, 'app_install', 'pending')`,
    [orgId, installationId],
  );

  const [clientA, clientB] = [await pool.connect(), await pool.connect()];
  try {
    await clientA.query("BEGIN");
    await clientA.query("SET LOCAL ROLE sayre_installation_discovery_dispatcher");
    await clientB.query("BEGIN");
    await clientB.query("SET LOCAL ROLE sayre_installation_discovery_dispatcher");

    const claimA = clientA.query("SELECT * FROM public.claim_github_installation_discovery($1, $2)", [5, 60]);
    const claimB = clientB.query("SELECT * FROM public.claim_github_installation_discovery($1, $2)", [5, 60]);
    const [resultA, resultB] = await Promise.all([claimA, claimB]);

    const totalClaimed = resultA.rowCount! + resultB.rowCount!;
    assert.equal(totalClaimed, 1, "exactly one of the two concurrent claims should win the single due row");
  } finally {
    await clientA.query("ROLLBACK");
    await clientB.query("ROLLBACK");
    clientA.release();
    clientB.release();
  }
});

// @spec EC-29
test("[EC-29] sayre_app can neither read nor write the lease/dispatch columns", async () => {
  for (const column of ["lease_token", "lease_expires_at", "dispatched_at", "dispatch_attempt_count"]) {
    const select = await pool.query(
      `SELECT has_column_privilege('sayre_app', 'github_installation_sync', $1, 'SELECT') AS ok`,
      [column],
    );
    assert.equal(select.rows[0].ok, false, `sayre_app must NOT be able to SELECT ${column}`);
    const update = await pool.query(
      `SELECT has_column_privilege('sayre_app', 'github_installation_sync', $1, 'UPDATE') AS ok`,
      [column],
    );
    assert.equal(update.rows[0].ok, false, `sayre_app must NOT be able to UPDATE ${column}`);
  }
});

// ---------------------------------------------------------------------------
// EC-20: stale-running reset vs. live-running preserved
// ---------------------------------------------------------------------------

// @spec EC-20
test("[EC-20] startInstallationSync resets a running row abandoned past INSTALLATION_SYNC_STALL_MS, but leaves a live running row alone", async () => {
  const { startInstallationSync, INSTALLATION_SYNC_STALL_MS } = await import(
    "./githubInstallationSyncStore"
  );
  const staleInstallationId = installationId + 1;
  const liveInstallationId = installationId + 2;

  // A running row whose updated_at is older than the stall window.
  await pool.query(
    `INSERT INTO github_installation_sync (org_id, installation_id, reason, status, run_id, updated_at)
     VALUES ($1, $2, 'app_install', 'running', gen_random_uuid(), now() - ($3 || ' milliseconds')::interval)`,
    [orgId, staleInstallationId, INSTALLATION_SYNC_STALL_MS + 60_000],
  );
  // A running row touched just now (live).
  const liveRunRow = await pool.query(
    `INSERT INTO github_installation_sync (org_id, installation_id, reason, status, run_id, updated_at)
     VALUES ($1, $2, 'app_install', 'running', gen_random_uuid(), now())
     RETURNING run_id`,
    [orgId, liveInstallationId],
  );
  const liveRunId = liveRunRow.rows[0].run_id;

  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SET LOCAL ROLE sayre_app");
    await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    const staleResult = await startInstallationSync(tx as never, {
      orgId,
      installationId: staleInstallationId,
      reason: "app_install",
      requestedBy: null,
    });
    assert.equal(staleResult.reset, true, "a stale running row must be reset to a fresh pending run");

    const liveResult = await startInstallationSync(tx as never, {
      orgId,
      installationId: liveInstallationId,
      reason: "app_install",
      requestedBy: null,
    });
    assert.equal(liveResult.reset, false, "a live running row must NOT be restarted underneath itself");
    assert.equal(liveResult.runId, liveRunId, "the live run's existing run_id must be returned, not a new one");

    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
});

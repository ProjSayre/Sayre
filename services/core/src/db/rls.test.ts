// Automated RLS isolation test (the acceptance gate for W0-05).
//
// Uses a raw `pg` Pool on the admin `DATABASE_URL` (superuser) for
// setup/seed (superuser bypasses RLS), and simulates a tenant session on
// the same connection via `SET LOCAL ROLE sayre_app` inside a transaction
// (non-superuser -> RLS applies).
//
// Coordination note (this ticket runs alongside parallel tickets sharing the
// same sayre-postgres container / sayre_dev database): this test does NOT
// run against sayre_dev directly. It creates and migrates its own throwaway
// database (default name `w005_rls_test`, override via RLS_TEST_DB_NAME) off
// of the admin DATABASE_URL's host/credentials, so it never assumes
// exclusive ownership of sayre_dev.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./client";

const TEST_DB_NAME = process.env.RLS_TEST_DB_NAME ?? "w005_rls_test";

const TABLE_NAMES = [
  "organizations",
  "users",
  "repositories",
  "permissions",
  "ticket_cache",
  "style_rules",
  "onboarding_steps",
] as const;
type TableName = (typeof TABLE_NAMES)[number];

function requireAdminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "rls.test.ts requires DATABASE_URL (admin/superuser DSN) -- see infra/.env.example. " +
        "Run via `npm run test:rls` (loads infra/.env) or export DATABASE_URL yourself.",
    );
  }
  return url;
}

/** Swaps the database name in a Postgres connection string, keeping host/credentials. */
function withDatabaseName(connectionString: string, dbName: string): string {
  const u = new URL(connectionString);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Creates the dedicated test database if it doesn't already exist. Runs on a
 * plain `pg.Client` (not the pool) because `CREATE DATABASE` cannot execute
 * inside a transaction block. `dbName` is never client-controlled (constant
 * or CI-set env var), so a literal identifier is safe here.
 */
async function ensureTestDatabaseExists(adminUrl: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

interface SeededOrg {
  orgId: string;
  userId: string;
  repoId: string;
  permissionId: string;
  ticketId: string;
  styleRuleId: string;
  onboardingStepId: string;
}

function idsByTable(seed: SeededOrg): Record<TableName, string> {
  return {
    organizations: seed.orgId,
    users: seed.userId,
    repositories: seed.repoId,
    permissions: seed.permissionId,
    ticket_cache: seed.ticketId,
    style_rules: seed.styleRuleId,
    onboarding_steps: seed.onboardingStepId,
  };
}

/** Seeds one row in every one of the seven tables for a throwaway org, as the admin (bypasses RLS). */
async function seedOrg(pool: Pool, label: string): Promise<SeededOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const repoId = randomUUID();
  const permissionId = randomUUID();
  const ticketId = randomUUID();
  const styleRuleId = randomUUID();
  const onboardingStepId = randomUUID();

  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    `Org ${label}`,
    `org-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  await pool.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
    userId,
    orgId,
    `user-${label}-${userId.slice(0, 8)}@example.com`,
  ]);
  await pool.query("INSERT INTO repositories (id, org_id, name) VALUES ($1, $2, $3)", [
    repoId,
    orgId,
    `repo-${label}`,
  ]);
  await pool.query(
    "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, action) VALUES ($1, $2, $3, $4, $5, $6)",
    [permissionId, orgId, "user", userId, repoId, "read"],
  );
  await pool.query(
    "INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id, payload) VALUES ($1, $2, $3, $4, $5, $6)",
    [ticketId, orgId, repoId, "jira", `PROJ-${label}`, JSON.stringify({ hello: label })],
  );
  await pool.query(
    "INSERT INTO style_rules (id, org_id, repo_id, rule_type, content) VALUES ($1, $2, $3, $4, $5)",
    [styleRuleId, orgId, repoId, "coding_style", `rules for ${label}`],
  );
  await pool.query(
    "INSERT INTO onboarding_steps (id, org_id, repo_id, sequence, title) VALUES ($1, $2, $3, $4, $5)",
    [onboardingStepId, orgId, repoId, 1, `Step 1 for ${label}`],
  );

  return { orgId, userId, repoId, permissionId, ticketId, styleRuleId, onboardingStepId };
}

/**
 * Runs `fn` as the least-privilege, org-scoped tenant session: drops to the
 * non-superuser `sayre_app` role (RLS-subject) inside a transaction, then
 * sets `app.org_id` transaction-locally. Passing `orgId = undefined` skips
 * `set_config` entirely (the "unset context" edge case); pass `""` to test
 * the "empty-string context" edge case explicitly.
 */
async function withTenantSession<T>(
  pool: Pool,
  orgId: string | undefined,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE sayre_app");
    if (orgId !== undefined) {
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    }
    return await fn(c);
  } finally {
    // SET LOCAL + set_config(..., true) are transaction-scoped and auto-reset here.
    await c.query("ROLLBACK");
    c.release();
  }
}

let pool: Pool;
let orgA: SeededOrg;
let orgB: SeededOrg;
let idsA: Record<TableName, string>;
let idsB: Record<TableName, string>;

before(async () => {
  const adminUrl = requireAdminUrl();
  await ensureTestDatabaseExists(adminUrl, TEST_DB_NAME);
  const testDbUrl = withDatabaseName(adminUrl, TEST_DB_NAME);

  const migratePool = createPool(testDbUrl);
  try {
    await migrate(createDb(migratePool), { migrationsFolder: "./drizzle" });
  } finally {
    await migratePool.end();
  }

  pool = createPool(testDbUrl);
  orgA = await seedOrg(pool, "A");
  orgB = await seedOrg(pool, "B");
  idsA = idsByTable(orgA);
  idsB = idsByTable(orgB);
});

after(async () => {
  await pool.query("TRUNCATE organizations CASCADE");
  await pool.end();
});

test("org A tenant session sees only its own row (and zero org B rows) across all 7 tables", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    for (const table of TABLE_NAMES) {
      const own = await c.query(`SELECT id FROM ${table}`);
      assert.equal(own.rowCount, 1, `${table}: org A should see exactly its own 1 row`);
      assert.equal(own.rows[0].id, idsA[table]);

      const cross = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [idsB[table]]);
      assert.equal(cross.rowCount, 0, `${table}: org A must not see org B's row by direct PK lookup`);
    }
  });
});

test("org B tenant session sees only its own row (and zero org A rows) across all 7 tables", async () => {
  await withTenantSession(pool, orgB.orgId, async (c) => {
    for (const table of TABLE_NAMES) {
      const own = await c.query(`SELECT id FROM ${table}`);
      assert.equal(own.rowCount, 1, `${table}: org B should see exactly its own 1 row`);
      assert.equal(own.rows[0].id, idsB[table]);

      const cross = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [idsA[table]]);
      assert.equal(cross.rowCount, 0, `${table}: org B must not see org A's row by direct PK lookup`);
    }
  });
});

test("unset app.org_id -> every table returns zero rows (fail-closed, not fail-open)", async () => {
  await withTenantSession(pool, undefined, async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: expected 0 rows with no org context set`);
    }
  });
});

test("empty-string app.org_id -> zero rows, no invalid-uuid cast error (nullif maps '' to NULL)", async () => {
  await withTenantSession(pool, "", async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: expected 0 rows with empty-string org context`);
    }
  });
});

test("malformed app.org_id raises 'invalid input syntax for type uuid' on select (documented, acceptable)", async () => {
  await assert.rejects(
    withTenantSession(pool, "not-a-uuid", async (c) => {
      await c.query("SELECT id FROM users");
    }),
    /invalid input syntax for type uuid/,
  );
});

test("cross-org INSERT (org_id = B) is rejected under org A context; same-org INSERT succeeds", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    await assert.rejects(
      c.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
        randomUUID(),
        orgB.orgId,
        "cross-org-attempt@example.com",
      ]),
      /row-level security/i,
    );
  });

  // Separate transaction/connection (the prior one aborted on the rejected insert).
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const newId = randomUUID();
    await c.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
      newId,
      orgA.orgId,
      "same-org-insert@example.com",
    ]);
    const check = await c.query("SELECT id FROM users WHERE id = $1", [newId]);
    assert.equal(check.rowCount, 1, "same-org insert must succeed under matching context");
  });
  // Both sessions ROLLBACK in withTenantSession's finally -> no persistent side effect.
});

test("admin (superuser) connection ignores RLS entirely, even with app.org_id set (the vacuous-pass trap)", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Deliberately NOT `SET LOCAL ROLE sayre_app` -- stays on the superuser role.
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgA.orgId]);
    const res = await client.query("SELECT id FROM organizations");
    assert.equal(
      res.rowCount,
      2,
      "superuser must see both orgs regardless of app.org_id -- RLS does not apply to superusers/table owners without FORCE",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("connection-pool leakage: context A then context B back-to-back on the same pool do not bleed", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT id FROM organizations");
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].id, orgA.orgId);
  });
  await withTenantSession(pool, orgB.orgId, async (c) => {
    const res = await c.query("SELECT id FROM organizations");
    assert.equal(res.rowCount, 1);
    assert.equal(res.rows[0].id, orgB.orgId);
  });
});

test("ticket_cache.payload accepts and returns a JSON object under a tenant session (jsonb round-trip)", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT payload FROM ticket_cache WHERE id = $1", [orgA.ticketId]);
    assert.equal(res.rowCount, 1);
    assert.deepEqual(res.rows[0].payload, { hello: "A" });
  });
});

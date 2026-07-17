// TESTER-stage acceptance suite for W0-05 (companion to src/db/rls.test.ts).
//
// This file covers the spec's acceptance criteria and "Edge cases (for Tester)"
// that the dev's rls.test.ts does not already assert:
//   - schema/DDL shape (all 9 tables, columns, uniques, FK cascade, prefix index)  [AC-3]
//   - RLS enabled+FORCED + org_isolation policy metadata per table                 [AC-4]
//   - sayre_app role privileges / non-ownership / NOBYPASSRLS                       [AC-5]
//   - withOrgContext: UUID validation + transaction-local GUC + fail-closed reset   [AC-6]
//   - migrate() idempotency (2nd run no-ops; no duplicate policies/role)            [edge]
//   - write-path RLS: unset-context INSERT, cross-org UPDATE SET org_id, USING-filtered UPDATE [edge]
//   - FK + cascade under RLS (cascade delete; documented FK-RI-bypasses-RLS behavior) [edge]
//   - concurrent sessions with different app.org_id do not bleed                    [edge]
//   - unknown/unseeded org context -> fail-closed (0 rows)                          [edge]
//   - missing DATABASE_URL -> createPool fails fast                                 [edge]
//   - updated_at BEFORE-UPDATE trigger fires (0002)
//
// W0-05 follow-up (mcp_client_keys, model_provider) table-specific coverage added
// by the tester stage per spec.md's "Edge cases (for Tester)" list:
//   - no-plaintext-key-column guard on mcp_client_keys; no raw-credential column
//     on model_provider beyond credential_ref
//   - mcp_client_keys.key_prefix global uniqueness (not just per-org)
//   - model_provider one-row-per-org (unique(org_id)) enforcement
//   - created_by/revoked_by SET NULL on the referenced users row being deleted
//   - soft-revocation semantics (revoked_at set != row removed/hidden)
//   - roles jsonb round-trip
//   - updated_at trigger on both new tables
//   - documented FK-RI-bypasses-RLS case for mcp_client_keys.created_by
//   - both new tables folded into the existing generic TABLE_NAMES-driven loops
//     (columns, RLS enabled+forced+policy, privileges, cascade-delete, concurrent
//     sessions, unknown-org fail-closed, migrate idempotency count)
//
// Runs against its OWN dedicated database (w005_rls_tester) so it never collides
// with rls.test.ts's w005_rls_test nor with the shared sayre_dev database.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool, withOrgContext } from "./client";

const TEST_DB_NAME = process.env.RLS_TESTER_DB_NAME ?? "w005_rls_tester";

const TABLE_NAMES = [
  "organizations",
  "users",
  "repositories",
  "permissions",
  "ticket_cache",
  "style_rules",
  "onboarding_steps",
  "mcp_client_keys",
  "model_provider",
] as const;
type TableName = (typeof TABLE_NAMES)[number];

/** Which column each table's org_isolation policy keys on. */
const POLICY_KEY: Record<TableName, string> = {
  organizations: "id",
  users: "org_id",
  repositories: "org_id",
  permissions: "org_id",
  ticket_cache: "org_id",
  style_rules: "org_id",
  onboarding_steps: "org_id",
  mcp_client_keys: "org_id",
  model_provider: "org_id",
};

/** Expected column shape per spec's "Table shapes" section: [dataType, nullable]. */
const EXPECTED_COLUMNS: Record<TableName, Record<string, [string, boolean]>> = {
  organizations: {
    id: ["uuid", false],
    name: ["text", false],
    slug: ["text", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  users: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    email: ["text", false],
    name: ["text", true],
    external_auth_id: ["text", true],
    org_role: ["text", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  repositories: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    name: ["text", false],
    provider: ["text", false],
    external_id: ["text", true],
    default_branch: ["text", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  permissions: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    subject_type: ["text", false],
    subject_id: ["text", false],
    repo_id: ["uuid", true],
    branch: ["text", true],
    path_prefix: ["text", true],
    action: ["text", false],
    effect: ["text", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  ticket_cache: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repo_id: ["uuid", true],
    provider: ["text", false],
    external_ticket_id: ["text", false],
    title: ["text", true],
    status: ["text", true],
    url: ["text", true],
    graph_node_id: ["text", true],
    payload: ["jsonb", true],
    synced_at: ["timestamp with time zone", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  style_rules: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repo_id: ["uuid", true],
    rule_type: ["text", false],
    scope_node_id: ["text", true],
    branch: ["text", true],
    path_prefix: ["text", true],
    content: ["text", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  onboarding_steps: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repo_id: ["uuid", true],
    branch: ["text", true],
    sequence: ["integer", false],
    title: ["text", false],
    body: ["text", true],
    command: ["text", true],
    graph_node_id: ["text", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  mcp_client_keys: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    name: ["text", false],
    key_prefix: ["text", false],
    key_hash: ["text", false],
    roles: ["jsonb", false],
    created_by: ["uuid", true],
    revoked_at: ["timestamp with time zone", true],
    revoked_by: ["uuid", true],
    last_used_at: ["timestamp with time zone", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  model_provider: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    provider_type: ["text", false],
    endpoint_url: ["text", true],
    credential_ref: ["text", true],
    default_model: ["text", true],
    config: ["jsonb", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
};

function requireAdminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "rls_acceptance.tester.test.ts requires DATABASE_URL (admin/superuser DSN). Run via node --env-file=../../infra/.env.",
    );
  }
  return url;
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
  mcpClientKeyId: string;
  modelProviderId: string;
}

/** Seeds one row in every table for a throwaway org, as admin (bypasses RLS). */
async function seedOrg(execPool: Pool, label: string): Promise<SeededOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const repoId = randomUUID();
  const permissionId = randomUUID();
  const ticketId = randomUUID();
  const styleRuleId = randomUUID();
  const onboardingStepId = randomUUID();
  const mcpClientKeyId = randomUUID();
  const modelProviderId = randomUUID();

  await execPool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    `Org ${label}`,
    `tester-org-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  await execPool.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
    userId,
    orgId,
    `user-${label}-${userId.slice(0, 8)}@example.com`,
  ]);
  await execPool.query("INSERT INTO repositories (id, org_id, name) VALUES ($1, $2, $3)", [
    repoId,
    orgId,
    `repo-${label}`,
  ]);
  await execPool.query(
    "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, action) VALUES ($1, $2, $3, $4, $5, $6)",
    [permissionId, orgId, "user", userId, repoId, "read"],
  );
  await execPool.query(
    "INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id, payload) VALUES ($1, $2, $3, $4, $5, $6)",
    [ticketId, orgId, repoId, "jira", `PROJ-${label}`, JSON.stringify({ hello: label })],
  );
  await execPool.query(
    "INSERT INTO style_rules (id, org_id, repo_id, rule_type, content) VALUES ($1, $2, $3, $4, $5)",
    [styleRuleId, orgId, repoId, "coding_style", `rules for ${label}`],
  );
  await execPool.query(
    "INSERT INTO onboarding_steps (id, org_id, repo_id, sequence, title) VALUES ($1, $2, $3, $4, $5)",
    [onboardingStepId, orgId, repoId, 1, `Step 1 for ${label}`],
  );
  // key_prefix is globally unique (mcp_client_keys_key_prefix_unique) -- derive
  // from the org label + an id slice so it's unique per org across the suite.
  await execPool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash, roles) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      mcpClientKeyId,
      orgId,
      `MCP key for ${label}`,
      `mcp_live_${label.toLowerCase()}_${mcpClientKeyId.slice(0, 8)}`,
      `sha256:${mcpClientKeyId}`,
      JSON.stringify(["read"]),
    ],
  );
  // model_provider is one row per org (model_provider_org_id_unique).
  await execPool.query(
    "INSERT INTO model_provider (id, org_id, provider_type, default_model) VALUES ($1, $2, $3, $4)",
    [modelProviderId, orgId, "anthropic", "claude-opus-4"],
  );

  return {
    orgId,
    userId,
    repoId,
    permissionId,
    ticketId,
    styleRuleId,
    onboardingStepId,
    mcpClientKeyId,
    modelProviderId,
  };
}

/** Runs fn as the least-privilege, org-scoped tenant session (sayre_app + app.org_id). */
async function withTenantSession<T>(
  p: Pool,
  orgId: string | undefined,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE sayre_app");
    if (orgId !== undefined) {
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    }
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

let pool: Pool;
let db: ReturnType<typeof createDb>;
let testDbUrl: string;
let orgA: SeededOrg;
let orgB: SeededOrg;

before(async () => {
  const adminUrl = requireAdminUrl();
  await ensureTestDatabaseExists(adminUrl, TEST_DB_NAME);
  testDbUrl = withDatabaseName(adminUrl, TEST_DB_NAME);

  const migratePool = createPool(testDbUrl);
  try {
    await migrate(createDb(migratePool), { migrationsFolder: "./drizzle" });
  } finally {
    await migratePool.end();
  }

  pool = createPool(testDbUrl);
  db = createDb(pool);
  // Start from a clean slate in case a prior run left rows behind.
  await pool.query("TRUNCATE organizations CASCADE");
  orgA = await seedOrg(pool, "A");
  orgB = await seedOrg(pool, "B");
});

after(async () => {
  if (pool) {
    await pool.query("TRUNCATE organizations CASCADE");
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// AC-3: schema / DDL shape
// ---------------------------------------------------------------------------

test("[AC-3] all 9 tables exist with exactly the spec's columns (type + nullability)", async () => {
  for (const table of TABLE_NAMES) {
    const res = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const actual = new Map<string, { data_type: string; is_nullable: string }>(
      res.rows.map((r) => [r.column_name, { data_type: r.data_type, is_nullable: r.is_nullable }]),
    );
    const expected = EXPECTED_COLUMNS[table];

    // No unexpected columns for this ticket's authoritative column list.
    for (const col of actual.keys()) {
      assert.ok(expected[col], `${table}: unexpected column '${col}' not in spec's column list`);
    }
    for (const [col, [dataType, nullable]] of Object.entries(expected)) {
      const got = actual.get(col);
      assert.ok(got, `${table}.${col} is missing`);
      assert.equal(got!.data_type, dataType, `${table}.${col} type mismatch`);
      assert.equal(
        got!.is_nullable,
        nullable ? "YES" : "NO",
        `${table}.${col} nullability mismatch`,
      );
    }
  }
});

test("[AC-3] composite UNIQUE + slug UNIQUE constraints exist", async () => {
  const res = await pool.query(
    `SELECT tc.table_name, tc.constraint_name,
            string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'UNIQUE'
      GROUP BY tc.table_name, tc.constraint_name`,
  );
  const uniques = new Set(res.rows.map((r) => `${r.table_name}:${r.cols}`));
  assert.ok(uniques.has("organizations:slug"), "organizations(slug) UNIQUE missing");
  assert.ok(uniques.has("users:org_id,email"), "users(org_id,email) UNIQUE missing");
  assert.ok(
    uniques.has("repositories:org_id,provider,external_id"),
    "repositories(org_id,provider,external_id) UNIQUE missing",
  );
  assert.ok(
    uniques.has("ticket_cache:org_id,provider,external_ticket_id"),
    "ticket_cache(org_id,provider,external_ticket_id) UNIQUE missing",
  );
  assert.ok(uniques.has("mcp_client_keys:key_prefix"), "mcp_client_keys(key_prefix) UNIQUE missing");
  assert.ok(uniques.has("model_provider:org_id"), "model_provider(org_id) UNIQUE missing");
});

test("[AC-3] every non-organizations table has an org_id FK to organizations with ON DELETE CASCADE", async () => {
  const res = await pool.query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`,
  );
  const orgFks = new Map(
    res.rows
      .filter((r) => r.column_name === "org_id" && r.ref_table === "organizations")
      .map((r) => [r.table_name, r.delete_rule]),
  );
  for (const table of TABLE_NAMES.filter((t) => t !== "organizations")) {
    assert.equal(orgFks.get(table), "CASCADE", `${table}.org_id FK must be ON DELETE CASCADE`);
  }
  // repo_id FKs (child tables) also cascade.
  const repoFks = res.rows.filter((r) => r.column_name === "repo_id" && r.ref_table === "repositories");
  assert.ok(repoFks.length >= 4, "expected repo_id FKs on permissions/ticket_cache/style_rules/onboarding_steps");
  for (const r of repoFks) {
    assert.equal(r.delete_rule, "CASCADE", `${r.table_name}.repo_id FK must be ON DELETE CASCADE`);
  }
});

test("[AC-2/0002] permissions prefix index (text_pattern_ops) exists", async () => {
  const res = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='permissions'
        AND indexname='permissions_org_repo_branch_path_prefix_idx'`,
  );
  assert.equal(res.rowCount, 1, "permissions prefix index missing");
  assert.match(res.rows[0].indexdef, /text_pattern_ops/, "prefix index should use text_pattern_ops opclass");
});

// ---------------------------------------------------------------------------
// AC-4: RLS enabled + FORCED + org_isolation policy per table
// ---------------------------------------------------------------------------

test("[AC-4] every table has RLS ENABLED and FORCED", async () => {
  const res = await pool.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
    [TABLE_NAMES],
  );
  assert.equal(res.rowCount, TABLE_NAMES.length, `expected all ${TABLE_NAMES.length} tables present in pg_class`);
  for (const row of res.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: ROW LEVEL SECURITY must be ENABLED`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname}: ROW LEVEL SECURITY must be FORCED`);
  }
});

test("[AC-4] each table has an org_isolation policy (cmd ALL, USING + WITH CHECK, correct key column)", async () => {
  const res = await pool.query(
    `SELECT tablename, policyname, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname='public' AND tablename = ANY($1)`,
    [TABLE_NAMES],
  );
  const byTable = new Map(res.rows.map((r) => [r.tablename, r]));
  for (const table of TABLE_NAMES) {
    const p = byTable.get(table);
    assert.ok(p, `${table}: org_isolation policy missing`);
    assert.equal(p!.policyname, "org_isolation", `${table}: policy should be named org_isolation`);
    assert.equal(p!.cmd, "ALL", `${table}: policy should apply to ALL commands`);
    assert.ok(p!.qual, `${table}: policy must have a USING clause`);
    assert.ok(p!.with_check, `${table}: policy must have a WITH CHECK clause`);
    // keyed on the right column and reads app.org_id via current_setting(..., true)
    const key = POLICY_KEY[table];
    for (const clause of [p!.qual, p!.with_check]) {
      assert.match(clause, new RegExp(`\\b${key}\\b`), `${table}: policy clause must key on ${key}`);
      // Postgres stores the expression with an explicit ::text cast on the literal,
      // i.e. current_setting('app.org_id'::text, true) -- allow the optional cast.
      assert.match(
        clause,
        /current_setting\('app\.org_id'(::text)?, true\)/,
        `${table}: policy must read app.org_id (missing_ok)`,
      );
      assert.match(clause, /NULLIF/i, `${table}: policy must nullif empty-string to NULL`);
      assert.match(clause, /::uuid/, `${table}: policy must cast the GUC to uuid`);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-5: sayre_app role
// ---------------------------------------------------------------------------

test("[AC-5] sayre_app role exists as non-super, NOBYPASSRLS, NOLOGIN", async () => {
  const res = await pool.query(
    "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'sayre_app'",
  );
  assert.equal(res.rowCount, 1, "sayre_app role must exist");
  assert.equal(res.rows[0].rolsuper, false, "sayre_app must NOT be superuser");
  assert.equal(res.rows[0].rolbypassrls, false, "sayre_app must be NOBYPASSRLS");
  assert.equal(res.rows[0].rolcanlogin, false, "sayre_app must be NOLOGIN (privilege bundle only)");
});

test("[AC-5] sayre_app has SELECT/INSERT/UPDATE/DELETE on all 9 tables and owns none of them", async () => {
  for (const table of TABLE_NAMES) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const res = await pool.query("SELECT has_table_privilege('sayre_app', $1, $2) AS ok", [table, priv]);
      assert.equal(res.rows[0].ok, true, `sayre_app must have ${priv} on ${table}`);
    }
    const owner = await pool.query(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = $1 AND relnamespace='public'::regnamespace",
      [table],
    );
    assert.notEqual(owner.rows[0].owner, "sayre_app", `sayre_app must NOT own ${table}`);
  }
});

// ---------------------------------------------------------------------------
// AC-6: withOrgContext
// ---------------------------------------------------------------------------

test("[AC-6] withOrgContext rejects a non-UUID orgId before issuing any SQL", async () => {
  for (const bad of ["", "not-a-uuid", "12345", "'; DROP TABLE users; --", `${randomUUID()}x`]) {
    await assert.rejects(
      withOrgContext(db, bad, async () => {
        throw new Error("fn must NOT run for an invalid orgId");
      }),
      /orgId must be a UUID/,
      `withOrgContext should reject orgId=${JSON.stringify(bad)}`,
    );
  }
});

test("[AC-6] withOrgContext sets app.org_id transaction-locally, returns fn's value, and resets after commit", async () => {
  const inside = await withOrgContext(db, orgA.orgId, async (tx) => {
    const r = await tx.execute(sql`select current_setting('app.org_id', true) as v`);
    return (r as unknown as { rows: Array<{ v: string }> }).rows[0].v;
  });
  assert.equal(inside, orgA.orgId, "app.org_id must equal the injected orgId inside the transaction");

  // set_config(..., true) is transaction-local -> after commit it must be reset
  // (fail-closed: policy sees nullif(...,'') IS NULL). Robust to NULL-or-'' reset.
  const afterRes = await db.execute(
    sql`select nullif(current_setting('app.org_id', true), '') as v`,
  );
  const after = (afterRes as unknown as { rows: Array<{ v: string | null }> }).rows[0].v;
  assert.equal(after, null, "app.org_id must not leak past the transaction (transaction-local)");
});

test("[AC-6] back-to-back withOrgContext with different orgs do not bleed context", async () => {
  const a = await withOrgContext(db, orgA.orgId, async (tx) => {
    const r = await tx.execute(sql`select current_setting('app.org_id', true) as v`);
    return (r as unknown as { rows: Array<{ v: string }> }).rows[0].v;
  });
  const b = await withOrgContext(db, orgB.orgId, async (tx) => {
    const r = await tx.execute(sql`select current_setting('app.org_id', true) as v`);
    return (r as unknown as { rows: Array<{ v: string }> }).rows[0].v;
  });
  assert.equal(a, orgA.orgId);
  assert.equal(b, orgB.orgId);
});

// ---------------------------------------------------------------------------
// Edge: migrate idempotency
// ---------------------------------------------------------------------------

test("[edge] running migrate() a second time is a no-op (no throw, no duplicate policies/role)", async () => {
  const p2 = createPool(testDbUrl);
  try {
    await migrate(createDb(p2), { migrationsFolder: "./drizzle" });
  } finally {
    await p2.end();
  }
  // Exactly one org_isolation policy per table (not duplicated).
  const pol = await pool.query(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND policyname='org_isolation'`,
  );
  assert.equal(pol.rows[0].n, TABLE_NAMES.length, "expected exactly one org_isolation policy per table");
  // Exactly one sayre_app role.
  const role = await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='sayre_app'");
  assert.equal(role.rows[0].n, 1, "sayre_app role must not be duplicated");
});

// ---------------------------------------------------------------------------
// Edge: write-path RLS
// ---------------------------------------------------------------------------

test("[edge] unset context -> INSERT is rejected by WITH CHECK (fail-closed writes)", async () => {
  await withTenantSession(pool, undefined, async (c) => {
    await assert.rejects(
      c.query("INSERT INTO users (org_id, email) VALUES ($1, $2)", [orgA.orgId, "noctx@example.com"]),
      /row-level security/i,
      "insert with no org context must be blocked",
    );
  });
});

test("[edge] cross-org UPDATE ... SET org_id = B under context A is rejected by WITH CHECK", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    await assert.rejects(
      c.query("UPDATE users SET org_id = $1 WHERE id = $2", [orgB.orgId, orgA.userId]),
      /row-level security/i,
      "reparenting a row to another org must be blocked",
    );
  });
});

test("[edge] UPDATE targeting org B's row under context A affects 0 rows (USING filters it out)", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("UPDATE users SET name = 'hacked' WHERE id = $1", [orgB.userId]);
    assert.equal(res.rowCount, 0, "org A must not be able to update org B's row");
  });
});

test("[edge] cross-org INSERT (org_id = A) into a child table is rejected under context B", async () => {
  await withTenantSession(pool, orgB.orgId, async (c) => {
    await assert.rejects(
      c.query(
        "INSERT INTO ticket_cache (org_id, provider, external_ticket_id) VALUES ($1, $2, $3)",
        [orgA.orgId, "jira", "CROSS-1"],
      ),
      /row-level security/i,
      "child-table insert with a foreign org_id must be blocked",
    );
  });
});

test(
  "[edge] unset context -> INSERT into mcp_client_keys / model_provider is rejected by WITH CHECK (fail-closed writes)",
  async () => {
    await withTenantSession(pool, undefined, async (c) => {
      await assert.rejects(
        c.query(
          "INSERT INTO mcp_client_keys (org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)",
          [orgA.orgId, "noctx-key", `mcp_live_noctx_${randomUUID().slice(0, 8)}`, "sha256:noctx"],
        ),
        /row-level security/i,
        "mcp_client_keys insert with no org context must be blocked",
      );
    });
    await withTenantSession(pool, undefined, async (c) => {
      await assert.rejects(
        c.query("INSERT INTO model_provider (org_id, provider_type) VALUES ($1, $2)", [orgA.orgId, "openai"]),
        /row-level security/i,
        "model_provider insert with no org context must be blocked",
      );
    });
  },
);

test(
  "[edge] cross-org INSERT (org_id = B) into mcp_client_keys / model_provider is rejected under context A",
  async () => {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await assert.rejects(
        c.query(
          "INSERT INTO mcp_client_keys (org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)",
          [orgB.orgId, "cross-org-key", `mcp_live_cross_${randomUUID().slice(0, 8)}`, "sha256:cross"],
        ),
        /row-level security/i,
        "mcp_client_keys insert with a foreign org_id must be blocked",
      );
    });
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await assert.rejects(
        c.query("INSERT INTO model_provider (org_id, provider_type) VALUES ($1, $2)", [orgB.orgId, "openai"]),
        /row-level security/i,
        "model_provider insert with a foreign org_id must be blocked",
      );
    });
  },
);

test(
  "[edge] cross-org UPDATE ... SET org_id = B on mcp_client_keys / model_provider under context A is rejected by WITH CHECK",
  async () => {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await assert.rejects(
        c.query("UPDATE mcp_client_keys SET org_id = $1 WHERE id = $2", [orgB.orgId, orgA.mcpClientKeyId]),
        /row-level security/i,
        "reparenting an mcp_client_keys row to another org must be blocked",
      );
    });
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await assert.rejects(
        c.query("UPDATE model_provider SET org_id = $1 WHERE id = $2", [orgB.orgId, orgA.modelProviderId]),
        /row-level security/i,
        "reparenting a model_provider row to another org must be blocked",
      );
    });
  },
);

test(
  "[edge] UPDATE targeting the other org's mcp_client_keys / model_provider row affects 0 rows (USING filters it out)",
  async () => {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      const res = await c.query("UPDATE mcp_client_keys SET name = 'hacked' WHERE id = $1", [orgB.mcpClientKeyId]);
      assert.equal(res.rowCount, 0, "org A must not be able to update org B's mcp_client_keys row");
    });
    await withTenantSession(pool, orgA.orgId, async (c) => {
      const res = await c.query("UPDATE model_provider SET default_model = 'hacked' WHERE id = $1", [
        orgB.modelProviderId,
      ]);
      assert.equal(res.rowCount, 0, "org A must not be able to update org B's model_provider row");
    });
  },
);

// ---------------------------------------------------------------------------
// Edge: FK + cascade under RLS
// ---------------------------------------------------------------------------

test("[edge] deleting an org as admin cascades to all its child rows", async () => {
  const orgC = await seedOrg(pool, "C");
  const before = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id = $1", [orgC.orgId]);
  assert.equal(before.rows[0].n, 1, "precondition: org C has a seeded user");

  await pool.query("DELETE FROM organizations WHERE id = $1", [orgC.orgId]);

  for (const table of [
    "users",
    "repositories",
    "permissions",
    "ticket_cache",
    "style_rules",
    "onboarding_steps",
    "mcp_client_keys",
    "model_provider",
  ]) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgC.orgId]);
    assert.equal(res.rows[0].n, 0, `${table}: org C's rows must be cascade-deleted`);
  }
});

test("[edge][documented] FK RI bypasses RLS: an own-org row MAY reference another org's FK, but stays org-isolated", async () => {
  // Under context A, insert a ticket_cache row with org_id=A (passes WITH CHECK)
  // that references org B's repo_id (a parent hidden by RLS). PostgreSQL's
  // referential-integrity checks run outside the caller's RLS, so this SUCCEEDS.
  // The tenant-isolation boundary is org_id (WITH CHECK + USING), NOT the FK:
  // the row is org A's and remains invisible to org B.
  //
  // NOTE (coverage): the spec's edge-case wording ("child rows referencing a FK
  // in another org must be blocked by RLS / can't even see the parent") does not
  // hold literally -- this is inherent PostgreSQL FK-vs-RLS behavior, not an
  // implementation defect, and no cross-tenant READ leak results.
  const crossId = randomUUID();
  await withTenantSession(pool, orgA.orgId, async (c) => {
    await c.query(
      "INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id) VALUES ($1, $2, $3, $4, $5)",
      [crossId, orgA.orgId, orgB.repoId, "jira", "FK-HIDDEN-PARENT"],
    );
    const mine = await c.query("SELECT id FROM ticket_cache WHERE id = $1", [crossId]);
    assert.equal(mine.rowCount, 1, "org A owns the row it just inserted");
  });
  // The row is org A's -> org B cannot see it.
  await withTenantSession(pool, orgB.orgId, async (c) => {
    const res = await c.query("SELECT id FROM ticket_cache WHERE id = $1", [crossId]);
    assert.equal(res.rowCount, 0, "org B must not see org A's cross-referencing row");
  });
});

test(
  "[edge][documented] FK RI bypasses RLS: mcp_client_keys.created_by may reference a user hidden by RLS, without leaking cross-tenant reads",
  async () => {
    // Same documented FK-RI-vs-RLS behavior as ticket_cache.repo_id above, but for
    // the new table's created_by -> users.id FK: org A's key can reference org B's
    // (RLS-hidden) user as its issuer, but the key row itself stays org A's and
    // invisible to org B.
    const crossId = randomUUID();
    const prefix = `mcp_live_fkri_${crossId.slice(0, 8)}`;
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await c.query(
        "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [crossId, orgA.orgId, "fk-ri-key", prefix, `sha256:${crossId}`, orgB.userId],
      );
      const mine = await c.query("SELECT id FROM mcp_client_keys WHERE id = $1", [crossId]);
      assert.equal(
        mine.rowCount,
        1,
        "org A owns the row it just inserted, even though created_by references org B's (RLS-hidden) user",
      );
    });
    await withTenantSession(pool, orgB.orgId, async (c) => {
      const res = await c.query("SELECT id FROM mcp_client_keys WHERE id = $1", [crossId]);
      assert.equal(res.rowCount, 0, "org B must not see org A's key merely because created_by references one of its users");
    });
    await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [crossId]);
  },
);

// ---------------------------------------------------------------------------
// Edge: concurrent sessions
// ---------------------------------------------------------------------------

test("[edge] two concurrent sessions with different app.org_id do not bleed into each other", async () => {
  const cA = await pool.connect();
  const cB = await pool.connect();
  try {
    await cA.query("BEGIN");
    await cA.query("SET LOCAL ROLE sayre_app");
    await cA.query("SELECT set_config('app.org_id', $1, true)", [orgA.orgId]);

    await cB.query("BEGIN");
    await cB.query("SET LOCAL ROLE sayre_app");
    await cB.query("SELECT set_config('app.org_id', $1, true)", [orgB.orgId]);

    // Interleave: each connection must still see only its own org.
    const a1 = await cA.query("SELECT id FROM organizations");
    const b1 = await cB.query("SELECT id FROM organizations");
    const a2 = await cA.query("SELECT id FROM organizations WHERE id = $1", [orgB.orgId]);
    const b2 = await cB.query("SELECT id FROM organizations WHERE id = $1", [orgA.orgId]);

    assert.equal(a1.rowCount, 1);
    assert.equal(a1.rows[0].id, orgA.orgId);
    assert.equal(b1.rowCount, 1);
    assert.equal(b1.rows[0].id, orgB.orgId);
    assert.equal(a2.rowCount, 0, "session A must not see org B even by direct PK");
    assert.equal(b2.rowCount, 0, "session B must not see org A even by direct PK");

    // Same interleaved check for the two W0-05-follow-up tables.
    const mcA1 = await cA.query("SELECT id FROM mcp_client_keys");
    const mcB1 = await cB.query("SELECT id FROM mcp_client_keys");
    const mcA2 = await cA.query("SELECT id FROM mcp_client_keys WHERE id = $1", [orgB.mcpClientKeyId]);
    const mcB2 = await cB.query("SELECT id FROM mcp_client_keys WHERE id = $1", [orgA.mcpClientKeyId]);
    assert.equal(mcA1.rowCount, 1);
    assert.equal(mcA1.rows[0].id, orgA.mcpClientKeyId);
    assert.equal(mcB1.rowCount, 1);
    assert.equal(mcB1.rows[0].id, orgB.mcpClientKeyId);
    assert.equal(mcA2.rowCount, 0, "session A must not see org B's mcp_client_keys row");
    assert.equal(mcB2.rowCount, 0, "session B must not see org A's mcp_client_keys row");

    const mpA1 = await cA.query("SELECT id FROM model_provider");
    const mpB1 = await cB.query("SELECT id FROM model_provider");
    const mpA2 = await cA.query("SELECT id FROM model_provider WHERE id = $1", [orgB.modelProviderId]);
    const mpB2 = await cB.query("SELECT id FROM model_provider WHERE id = $1", [orgA.modelProviderId]);
    assert.equal(mpA1.rowCount, 1);
    assert.equal(mpA1.rows[0].id, orgA.modelProviderId);
    assert.equal(mpB1.rowCount, 1);
    assert.equal(mpB1.rows[0].id, orgB.modelProviderId);
    assert.equal(mpA2.rowCount, 0, "session A must not see org B's model_provider row");
    assert.equal(mpB2.rowCount, 0, "session B must not see org A's model_provider row");
  } finally {
    await cA.query("ROLLBACK");
    await cB.query("ROLLBACK");
    cA.release();
    cB.release();
  }
});

// ---------------------------------------------------------------------------
// Edge: unknown / empty org context
// ---------------------------------------------------------------------------

test("[edge] a valid-but-unseeded org context returns 0 rows everywhere (fail-closed for unknown org)", async () => {
  const unknownOrg = randomUUID();
  await withTenantSession(pool, unknownOrg, async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: unknown org must see 0 rows`);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge: missing DATABASE_URL
// ---------------------------------------------------------------------------

test("[edge] createPool() fails fast with a clear error when DATABASE_URL is missing", async () => {
  const saved = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    assert.throws(() => createPool(), /DATABASE_URL is not set/, "createPool() must fail fast, not hang");
    // An explicit empty string is also rejected (falsy guard).
    assert.throws(() => createPool(""), /DATABASE_URL is not set/);
  } finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  }
});

// ---------------------------------------------------------------------------
// 0002: updated_at trigger
// ---------------------------------------------------------------------------

test("[0002] BEFORE UPDATE trigger overwrites a caller-supplied updated_at with now()", async () => {
  // Insert a fresh org (admin) and try to UPDATE it with a bogus stale updated_at;
  // the trigger must overwrite it to ~now(), proving the trigger fires.
  const orgId = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    "trigger-org",
    `trigger-org-${orgId.slice(0, 8)}`,
  ]);
  await pool.query("UPDATE organizations SET name = 'renamed', updated_at = '2000-01-01T00:00:00Z' WHERE id = $1", [
    orgId,
  ]);
  const res = await pool.query(
    "SELECT extract(year from updated_at)::int AS yr, updated_at > created_at AS advanced FROM organizations WHERE id = $1",
    [orgId],
  );
  assert.notEqual(res.rows[0].yr, 2000, "trigger must overwrite the caller-supplied stale updated_at");
  assert.equal(res.rows[0].advanced, true, "updated_at must advance past created_at after an UPDATE");
  await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
});

test("[0002] BEFORE UPDATE trigger overwrites a caller-supplied updated_at on mcp_client_keys and model_provider", async () => {
  const keyId = randomUUID();
  const prefix = `mcp_live_trig_${keyId.slice(0, 8)}`;
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)",
    [keyId, orgA.orgId, "trigger-key", prefix, `sha256:${keyId}`],
  );
  await pool.query(
    "UPDATE mcp_client_keys SET name = 'renamed', updated_at = '2000-01-01T00:00:00Z' WHERE id = $1",
    [keyId],
  );
  const keyRes = await pool.query(
    "SELECT extract(year from updated_at)::int AS yr, updated_at > created_at AS advanced FROM mcp_client_keys WHERE id = $1",
    [keyId],
  );
  assert.notEqual(keyRes.rows[0].yr, 2000, "mcp_client_keys trigger must overwrite the caller-supplied stale updated_at");
  assert.equal(keyRes.rows[0].advanced, true, "mcp_client_keys.updated_at must advance past created_at after an UPDATE");
  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [keyId]);

  await pool.query(
    "UPDATE model_provider SET default_model = 'gpt-4', updated_at = '2000-01-01T00:00:00Z' WHERE id = $1",
    [orgA.modelProviderId],
  );
  const mpRes = await pool.query(
    "SELECT extract(year from updated_at)::int AS yr, updated_at > created_at AS advanced FROM model_provider WHERE id = $1",
    [orgA.modelProviderId],
  );
  assert.notEqual(mpRes.rows[0].yr, 2000, "model_provider trigger must overwrite the caller-supplied stale updated_at");
  assert.equal(mpRes.rows[0].advanced, true, "model_provider.updated_at must advance past created_at after an UPDATE");
  // Restore the seed value so any later test relying on orgA's original model_provider row is unaffected.
  await pool.query("UPDATE model_provider SET default_model = 'claude-opus-4' WHERE id = $1", [orgA.modelProviderId]);
});

// ---------------------------------------------------------------------------
// W0-05 follow-up: mcp_client_keys / model_provider table-specific edge cases
// ---------------------------------------------------------------------------

test("[AC-5/no-plaintext] mcp_client_keys has no raw key/secret column; model_provider has no raw-credential column", async () => {
  const mcpCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_client_keys'`,
  );
  const mcpColNames = new Set(mcpCols.rows.map((r) => r.column_name as string));
  for (const forbidden of ["key", "secret", "raw_key", "token", "password"]) {
    assert.ok(!mcpColNames.has(forbidden), `mcp_client_keys must NOT have a '${forbidden}' column`);
  }
  assert.ok(mcpColNames.has("key_hash"), "mcp_client_keys must have key_hash (the only key-material column)");
  assert.ok(mcpColNames.has("key_prefix"), "mcp_client_keys must have key_prefix (non-secret lookup id)");

  const mpCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'model_provider'`,
  );
  const mpColNames = new Set(mpCols.rows.map((r) => r.column_name as string));
  for (const forbidden of ["credential", "raw_credential", "token", "password", "secret", "api_key"]) {
    assert.ok(!mpColNames.has(forbidden), `model_provider must NOT have a '${forbidden}' column`);
  }
  assert.ok(mpColNames.has("credential_ref"), "model_provider must have credential_ref (a reference, not a raw secret)");
});

test("[edge] mcp_client_keys.key_prefix is globally unique across orgs, not just per-org", async () => {
  const sharedPrefix = `mcp_live_dup_${randomUUID().slice(0, 8)}`;
  const idOne = randomUUID();
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)",
    [idOne, orgA.orgId, "dup-1", sharedPrefix, `sha256:${idOne}`],
  );
  const idTwo = randomUUID();
  await assert.rejects(
    pool.query(
      "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)",
      [idTwo, orgB.orgId, "dup-2", sharedPrefix, `sha256:${idTwo}`],
    ),
    /mcp_client_keys_key_prefix_unique/,
    "a second key with the same key_prefix in a DIFFERENT org must violate the global unique constraint",
  );
  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [idOne]);
});

test("[edge][AC-6/O-1] model_provider enforces one row per org: a second insert for an org that already has one fails", async () => {
  await assert.rejects(
    pool.query("INSERT INTO model_provider (id, org_id, provider_type) VALUES ($1, $2, $3)", [
      randomUUID(),
      orgA.orgId,
      "openai",
    ]),
    /model_provider_org_id_unique/,
    "a second model_provider row for an org that already has one must violate unique(org_id)",
  );
});

test("[edge] deleting a users row referenced by created_by/revoked_by sets both to NULL (key row survives)", async () => {
  const adminUserId = randomUUID();
  await pool.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
    adminUserId,
    orgA.orgId,
    `admin-${adminUserId.slice(0, 8)}@example.com`,
  ]);
  const keyId = randomUUID();
  const prefix = `mcp_live_setnull_${keyId.slice(0, 8)}`;
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash, created_by, revoked_by, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [keyId, orgA.orgId, "set-null-key", prefix, `sha256:${keyId}`, adminUserId, adminUserId, new Date().toISOString()],
  );

  await pool.query("DELETE FROM users WHERE id = $1", [adminUserId]);

  const res = await pool.query("SELECT created_by, revoked_by FROM mcp_client_keys WHERE id = $1", [keyId]);
  assert.equal(res.rowCount, 1, "the key row must survive the admin user's deletion (SET NULL, not CASCADE/blocked)");
  assert.equal(res.rows[0].created_by, null, "created_by must be set NULL after the referenced user is deleted");
  assert.equal(res.rows[0].revoked_by, null, "revoked_by must be set NULL after the referenced user is deleted");

  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [keyId]);
});

test("[edge] soft revocation: setting revoked_at does not remove the row; it stays SELECT-able under its own org context", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const before = await c.query("SELECT revoked_at FROM mcp_client_keys WHERE id = $1", [orgA.mcpClientKeyId]);
    assert.equal(before.rowCount, 1);
    assert.equal(before.rows[0].revoked_at, null, "precondition: seeded key starts active (revoked_at NULL)");
  });

  await pool.query("UPDATE mcp_client_keys SET revoked_at = now() WHERE id = $1", [orgA.mcpClientKeyId]);

  await withTenantSession(pool, orgA.orgId, async (c) => {
    const after = await c.query("SELECT revoked_at FROM mcp_client_keys WHERE id = $1", [orgA.mcpClientKeyId]);
    assert.equal(
      after.rowCount,
      1,
      "a revoked key must still be SELECT-able under its own org context -- RLS does not enforce revocation, only org_id",
    );
    assert.notEqual(after.rows[0].revoked_at, null, "revoked_at must be persisted");
  });

  // Restore to active so later/other tests relying on orgA.mcpClientKeyId's default state are unaffected.
  await pool.query("UPDATE mcp_client_keys SET revoked_at = NULL WHERE id = $1", [orgA.mcpClientKeyId]);
});

test("[edge] mcp_client_keys.roles jsonb round-trips as a JSON array under a tenant session", async () => {
  const keyId = randomUUID();
  const prefix = `mcp_live_roles_${keyId.slice(0, 8)}`;
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hash, roles) VALUES ($1, $2, $3, $4, $5, $6)",
    [keyId, orgA.orgId, "roles-key", prefix, `sha256:${keyId}`, JSON.stringify(["read"])],
  );
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT roles FROM mcp_client_keys WHERE id = $1", [keyId]);
    assert.equal(res.rowCount, 1);
    assert.deepEqual(res.rows[0].roles, ["read"]);
  });
  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [keyId]);
});

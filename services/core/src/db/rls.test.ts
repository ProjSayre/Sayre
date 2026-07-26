// Automated RLS isolation test (the acceptance gate for W0-05).
//
// Uses a raw `pg` Pool on the admin `DATABASE_ADMIN_URL` (superuser) for
// setup/seed (superuser bypasses RLS), and simulates a tenant session on
// the same connection via `SET LOCAL ROLE sayre_app` inside a transaction
// (non-superuser -> RLS applies). It also exercises the REAL app path,
// `withOrgContext` (src/db/client.ts), directly on the admin pool -- see the
// AC-10 tests below, which prove the RLS-bypass fix (SET LOCAL ROLE
// sayre_app now runs inside withOrgContext's transaction).
//
// W0-05 v2/W3-08: extended from 9 to 14 tables (github_app_installations,
// mcp_client_keys redesign, model_provider -> model_provider_configs
// rename/reshape, repository_refs, code_chunks, code_embeddings) per
// docs/wave0-foundation-contracts.md "Persistence and tenant enforcement",
// plus the minimal model_provider_job_states visibility contract.
//
// Coordination note (this ticket runs alongside parallel tickets sharing the
// same sayre-postgres container / sayre_dev database): this test does NOT
// run against sayre_dev directly. It creates and migrates its own throwaway
// database (default name `w005_rls_test`, override via RLS_TEST_DB_NAME) off
// of the admin DATABASE_ADMIN_URL's host/credentials, so it never assumes
// exclusive ownership of sayre_dev.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool, withOrgContext, type Db } from "./client";
import { resolveInstallationOrg } from "./installations";
import { getConfig, getSecret } from "@sayre/config";
import {
  claimInitialParseOutbox,
  completeInitialParseOutbox,
  enqueueInitialParseOutbox,
  retryInitialParseOutbox,
} from "./githubInitialParseOutbox";
import { makeEnvelope } from "../queue/envelope";

const TEST_DB_NAME = getConfig("RLS_TEST_DB_NAME");

const TABLE_NAMES = [
  "organizations",
  "users",
  "repositories",
  "permissions",
  "ticket_cache",
  "style_rules",
  "onboarding_steps",
  "github_app_installations",
  "mcp_client_keys",
  "model_provider_configs",
  "model_provider_job_states",
  "repository_refs",
  "code_chunks",
  "code_embeddings",
] as const;
type TableName = (typeof TABLE_NAMES)[number];

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret("env://DATABASE_ADMIN_URL");
  } catch {
    throw new Error(
      "rls.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN) -- see infra/.env.example. " +
        "Run via `npm run test:rls` (loads infra/.env) or export DATABASE_ADMIN_URL yourself.",
    );
  }
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

/** 1024-dim zero vector literal for pgvector round-trip seeding (spec.md step 6). */
function zeroVector1024(): string {
  return `[${Array(1024).fill(0).join(",")}]`;
}

/** Monotonic-ish unique bigint for `github_app_installations.installation_id` (globally unique). */
function uniqueInstallationId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

interface SeededOrg {
  orgId: string;
  userId: string;
  repoId: string;
  permissionId: string;
  ticketId: string;
  styleRuleId: string;
  onboardingStepId: string;
  githubAppInstallationId: string;
  mcpClientKeyId: string;
  modelProviderConfigId: string;
  modelProviderJobStateId: string;
  repositoryRefId: string;
  codeChunkId: string;
  codeEmbeddingId: string;
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
    github_app_installations: seed.githubAppInstallationId,
    mcp_client_keys: seed.mcpClientKeyId,
    model_provider_configs: seed.modelProviderConfigId,
    model_provider_job_states: seed.modelProviderJobStateId,
    repository_refs: seed.repositoryRefId,
    code_chunks: seed.codeChunkId,
    code_embeddings: seed.codeEmbeddingId,
  };
}

/** Seeds one row in every one of the fourteen tables for a throwaway org, as the admin (bypasses RLS). */
async function seedOrg(pool: Pool, label: string): Promise<SeededOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const repoId = randomUUID();
  const permissionId = randomUUID();
  const ticketId = randomUUID();
  const styleRuleId = randomUUID();
  const onboardingStepId = randomUUID();
  const githubAppInstallationId = randomUUID();
  const mcpClientKeyId = randomUUID();
  const modelProviderConfigId = randomUUID();
  const modelProviderJobStateId = randomUUID();
  const repositoryRefId = randomUUID();
  const codeChunkId = randomUUID();
  const codeEmbeddingId = randomUUID();

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
  // installation_id is globally unique -- derive from a time+random source.
  await pool.query(
    "INSERT INTO github_app_installations (id, org_id, installation_id, account_login, account_type) VALUES ($1, $2, $3, $4, $5)",
    [githubAppInstallationId, orgId, uniqueInstallationId(), `${label}-account`, "Organization"],
  );
  // key_prefix is globally unique (mcp_client_keys_key_prefix_unique) -- derive
  // from the org label + an id slice so it's unique per org across the suite.
  // pepper_version is NOT NULL (redesigned column -- no default `roles` array anymore).
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      mcpClientKeyId,
      orgId,
      `MCP key for ${label}`,
      `mcp_live_${label.toLowerCase()}_${mcpClientKeyId.slice(0, 8)}`,
      `hmac-sha256:${mcpClientKeyId}`,
      1,
    ],
  );
  // model_provider_configs is purpose-keyed: unique(org_id, purpose), not unique(org_id).
  await pool.query(
    "INSERT INTO model_provider_configs (id, org_id, purpose, provider, model) VALUES ($1, $2, $3, $4, $5)",
    [modelProviderConfigId, orgId, "generation", "anthropic", "claude-opus-4"],
  );
  await pool.query(
    "INSERT INTO model_provider_job_states (id, org_id, repository_id, ref_name, revision_sha, surface, status, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      modelProviderJobStateId,
      orgId,
      repoId,
      "refs/heads/main",
      `${label.toLowerCase()}${"0".repeat(39)}`.slice(0, 40),
      "product",
      "degraded",
      "timeout",
    ],
  );
  await pool.query(
    "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
    [repositoryRefId, orgId, repoId, "refs/heads/main", `${label.toLowerCase()}${"0".repeat(39)}`.slice(0, 40)],
  );
  await pool.query(
    "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      codeChunkId,
      orgId,
      repoId,
      repositoryRefId,
      `${label.toLowerCase()}${"0".repeat(39)}`.slice(0, 40),
      0,
      `content for ${label}`,
      `hash-${codeChunkId}`,
    ],
  );
  // 1024-dim vector round-trip (spec.md step 6).
  await pool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      codeEmbeddingId,
      orgId,
      repoId,
      repositoryRefId,
      `${label.toLowerCase()}${"0".repeat(39)}`.slice(0, 40),
      codeChunkId,
      zeroVector1024(),
      "voyage",
      "voyage-3",
    ],
  );

  return {
    orgId,
    userId,
    repoId,
    permissionId,
    ticketId,
    styleRuleId,
    onboardingStepId,
    githubAppInstallationId,
    mcpClientKeyId,
    modelProviderConfigId,
    modelProviderJobStateId,
    repositoryRefId,
    codeChunkId,
    codeEmbeddingId,
  };
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
let db: Db;
let orgA: SeededOrg;
let orgB: SeededOrg;
let idsA: Record<TableName, string>;
let idsB: Record<TableName, string>;

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
  db = createDb(pool);
  orgA = await seedOrg(pool, "A");
  orgB = await seedOrg(pool, "B");
  idsA = idsByTable(orgA);
  idsB = idsByTable(orgB);
});

after(async () => {
  await pool.query("TRUNCATE organizations CASCADE");
  await pool.end();
});

test("org A tenant session sees only its own row (and zero org B rows) across all 14 tables", async () => {
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

test("org B tenant session sees only its own row (and zero org A rows) across all 14 tables", async () => {
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

test("code_embeddings.embedding round-trips a 1024-dim vector under a tenant session", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT embedding FROM code_embeddings WHERE id = $1", [
      orgA.codeEmbeddingId,
    ]);
    assert.equal(res.rowCount, 1);
    // pg returns the pgvector text representation, e.g. "[0,0,...,0]".
    const raw = res.rows[0].embedding as string;
    const values = raw.slice(1, -1).split(",");
    assert.equal(values.length, 1024, "embedding must round-trip as exactly 1024 dimensions");
  });
});

// ---------------------------------------------------------------------------
// AC-10: the RLS-bypass fix, proven through the REAL app path (withOrgContext)
// ---------------------------------------------------------------------------

test(
  "[AC-10] withOrgContext (invoked on the admin/superuser pool, as this suite does) now enforces RLS: " +
    "cross-org rows are invisible through the app path itself -- this would have leaked before the fix",
  async () => {
    for (const table of TABLE_NAMES) {
      const ownRows = await withOrgContext(db, orgA.orgId, async (tx) => {
        const r = await tx.execute(sql.raw(`select id from ${table}`));
        return (r as unknown as { rows: Array<{ id: string }> }).rows;
      });
      assert.equal(ownRows.length, 1, `${table}: withOrgContext(orgA) should return exactly 1 row`);
      assert.equal(ownRows[0].id, idsA[table]);

      const crossRows = await withOrgContext(db, orgA.orgId, async (tx) => {
        const r = await tx.execute(
          sql.raw(`select id from ${table} where id = '${idsB[table]}'`),
        );
        return (r as unknown as { rows: Array<{ id: string }> }).rows;
      });
      assert.equal(
        crossRows.length,
        0,
        `${table}: withOrgContext(orgA) must return ZERO org B rows -- proves the sayre_app role drop is in effect`,
      );
    }
  },
);

test("[AC-10] withOrgContext rejects a non-UUID orgId before issuing any SQL", async () => {
  await assert.rejects(
    withOrgContext(db, "not-a-uuid", async () => {
      throw new Error("fn must NOT run for an invalid orgId");
    }),
    /orgId must be a UUID/,
  );
});

test("[AC-10] withOrgContext sets app.org_id transaction-locally and resets it after commit", async () => {
  const inside = await withOrgContext(db, orgA.orgId, async (tx) => {
    const r = await tx.execute(sql`select current_setting('app.org_id', true) as v`);
    return (r as unknown as { rows: Array<{ v: string }> }).rows[0].v;
  });
  assert.equal(inside, orgA.orgId, "app.org_id must equal the injected orgId inside the transaction");

  const afterRes = await db.execute(sql`select nullif(current_setting('app.org_id', true), '') as v`);
  const after = (afterRes as unknown as { rows: Array<{ v: string | null }> }).rows[0].v;
  assert.equal(after, null, "app.org_id must not leak past the transaction (transaction-local)");
});

test("[AC-10] back-to-back withOrgContext calls for different orgs do not bleed context", async () => {
  const a = await withOrgContext(db, orgA.orgId, async (tx) => {
    const r = await tx.execute(sql`select id from organizations`);
    return (r as unknown as { rows: Array<{ id: string }> }).rows;
  });
  const b = await withOrgContext(db, orgB.orgId, async (tx) => {
    const r = await tx.execute(sql`select id from organizations`);
    return (r as unknown as { rows: Array<{ id: string }> }).rows;
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].id, orgA.orgId);
  assert.equal(b.length, 1);
  assert.equal(b[0].id, orgB.orgId);
});

test("[AC-10] cross-org write inside withOrgContext is rejected by WITH CHECK", async () => {
  await assert.rejects(
    withOrgContext(db, orgA.orgId, async (tx) => {
      await tx.execute(
        sql`insert into users (org_id, email) values (${orgB.orgId}, 'cross-org-via-with-org-context@example.com')`,
      );
    }),
    /row-level security/i,
  );
});

// ---------------------------------------------------------------------------
// GitHub installation pre-tenant resolution (migration 0011)
// ---------------------------------------------------------------------------

test("installation resolver crosses FORCE RLS only through the exact bigint -> org_id/active function", async () => {
  const seeded = await pool.query<{ installation_id: string }>(
    "SELECT installation_id FROM github_app_installations WHERE id = $1",
    [orgA.githubAppInstallationId],
  );
  const installationId = Number(seeded.rows[0].installation_id);

  const resolved = await resolveInstallationOrg(db, installationId);
  assert.deepEqual(resolved, { orgId: orgA.orgId, active: true });
  assert.equal(await resolveInstallationOrg(db, 9_000_000_000_000_000), null);
});

test("installation resolver reports suspended/revoked state without exposing lifecycle metadata", async () => {
  const seeded = await pool.query<{ installation_id: string }>(
    "SELECT installation_id FROM github_app_installations WHERE id = $1",
    [orgB.githubAppInstallationId],
  );
  const installationId = Number(seeded.rows[0].installation_id);
  await pool.query(
    "UPDATE github_app_installations SET suspended_at = now() WHERE id = $1",
    [orgB.githubAppInstallationId],
  );

  assert.deepEqual(await resolveInstallationOrg(db, installationId), {
    orgId: orgB.orgId,
    active: false,
  });
});

test("installation resolver role is NOLOGIN/NOBYPASSRLS, membership-free, and cannot read account metadata", async () => {
  const role = await pool.query<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    membership_count: string;
  }>(`
    SELECT role.rolcanlogin,
           role.rolsuper,
           role.rolbypassrls,
           (
             SELECT count(*)::text
               FROM pg_auth_members AS membership
              WHERE membership.roleid = role.oid
                 OR membership.member = role.oid
           ) AS membership_count
      FROM pg_roles AS role
     WHERE role.rolname = 'sayre_installation_resolver'
  `);
  assert.deepEqual(role.rows[0], {
    rolcanlogin: false,
    rolsuper: false,
    rolbypassrls: false,
    membership_count: "0",
  });

  const allowed = await pool.connect();
  try {
    await allowed.query("BEGIN");
    await allowed.query("SET LOCAL ROLE sayre_installation_resolver");
    const rows = await allowed.query(
      "SELECT installation_id, org_id, suspended_at, revoked_at FROM github_app_installations",
    );
    assert.equal(rows.rowCount, 2);
  } finally {
    await allowed.query("ROLLBACK");
    allowed.release();
  }

  const forbidden = await pool.connect();
  try {
    await forbidden.query("BEGIN");
    await forbidden.query("SET LOCAL ROLE sayre_installation_resolver");
    await assert.rejects(
      forbidden.query("SELECT account_login FROM github_app_installations"),
      /permission denied/i,
    );
  } finally {
    await forbidden.query("ROLLBACK");
    forbidden.release();
  }
});

test("initial-parse outbox is tenant-atomic, immutable, and recoverable through its narrow dispatcher", async () => {
  const revision = "c".repeat(40);
  const envelope = makeEnvelope({
    message_id: randomUUID(),
    idempotency_key:
      `github:initial_parse:555:42:refs/heads/main:${revision}`,
    org_id: orgA.orgId,
    type: "repo.initial_parse",
    source: "github-app-install",
    payload: {
      provider: "github" as const,
      type: "initial_parse" as const,
      repo: {
        repo_id: orgA.repoId,
        provider_repo_id: "42",
        full_name: "acme/widgets",
      },
      ref: "refs/heads/main",
      revision_sha: revision,
      installation_id: "555",
      reason: "app_install" as const,
    },
  });

  await withOrgContext(db, orgA.orgId, async (tx) => {
    await enqueueInitialParseOutbox(tx, envelope);
    // A replay is a no-op on the deterministic tenant/idempotency identity.
    await enqueueInitialParseOutbox(tx, envelope);
  });

  const stored = await pool.query<{
    envelope: unknown;
    delivered_at: Date | null;
  }>(
    "SELECT envelope, delivered_at FROM github_initial_parse_outbox WHERE org_id = $1",
    [orgA.orgId],
  );
  assert.equal(stored.rowCount, 1);
  assert.deepEqual(stored.rows[0].envelope, envelope);
  assert.equal(stored.rows[0].delivered_at, null);

  await assert.rejects(
    withOrgContext(db, orgB.orgId, async (tx) => {
      await enqueueInitialParseOutbox(tx, envelope);
    }),
    /row-level security/i,
  );

  await withTenantSession(pool, orgA.orgId, async (c) => {
    await assert.rejects(
      c.query("SELECT envelope FROM github_initial_parse_outbox"),
      /permission denied/i,
    );
  });

  const claims = await claimInitialParseOutbox(db, 5, 30);
  const claimed = claims.find(
    (event) => event.envelope.idempotency_key === envelope.idempotency_key,
  );
  assert.ok(claimed);
  assert.deepEqual(claimed.envelope, envelope);
  assert.equal(
    await completeInitialParseOutbox(
      db,
      claimed.id,
      "00000000-0000-4000-8000-000000000099",
    ),
    false,
  );
  assert.equal(
    await retryInitialParseOutbox(db, claimed.id, claimed.leaseToken, 1),
    true,
  );
  const tooEarly = await claimInitialParseOutbox(db, 5, 30);
  assert.equal(
    tooEarly.some(
      (event) => event.envelope.idempotency_key === envelope.idempotency_key,
    ),
    false,
  );

  // Simulate the bounded retry delay elapsing without making the suite sleep.
  await pool.query(
    "UPDATE github_initial_parse_outbox SET next_attempt_at = now() WHERE id = $1",
    [claimed.id],
  );
  const recovered = (
    await claimInitialParseOutbox(db, 5, 30)
  ).find(
    (event) => event.envelope.idempotency_key === envelope.idempotency_key,
  );
  assert.ok(recovered);
  assert.equal(recovered.attemptCount, 2);
  assert.deepEqual(recovered.envelope, envelope);
  assert.equal(
    await completeInitialParseOutbox(db, recovered.id, recovered.leaseToken),
    true,
  );

  const delivered = await pool.query<{ delivered: boolean }>(
    "SELECT delivered_at IS NOT NULL AS delivered FROM github_initial_parse_outbox WHERE org_id = $1",
    [orgA.orgId],
  );
  assert.equal(delivered.rows[0].delivered, true);
});

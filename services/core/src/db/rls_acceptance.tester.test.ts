// TESTER-stage acceptance suite for W0-05 v2 (companion to src/db/rls.test.ts).
//
// Independently verifies the spec's acceptance criteria (AC-1..AC-12) and the
// "Edge cases (exhaustive, for Tester)" list in .pipeline/spec.md against the
// REAL schema/migrations on disk. Written independently of rls.test.ts (dev's
// suite) -- similar test-harness shape (raw `pg` Pool + SET LOCAL ROLE
// sayre_app for tenant sessions) is unavoidable since both suites verify the
// same RLS mechanism, but the assertions/table-specific edge cases here are
// tester's own, not copy-pasted from dev's file.
//
// Runs against its own dedicated database (w005_rls_tester) so it never
// collides with rls.test.ts's w005_rls_test nor the shared sayre_dev database.
//
// Covers:
//   - AC-1/AC-2/AC-3: schema/DDL shape for all 14 tables (columns incl. the
//     code_embeddings.embedding USER-DEFINED/vector special case), composite
//     uniques, org_id FK cascade, RLS ENABLE+FORCE+org_isolation policy,
//     purpose/graph_version CHECKs, same-org-actor trigger, updated_at
//     triggers, hnsw cosine index, sayre_app grants.
//   - AC-4: org A/org B isolation (SELECT + PK) and cross-org write rejection
//     across all 14 tables under a non-superuser sayre_app session; fail-closed
//     on unset/empty app.org_id.
//   - AC-5: mcp_client_keys has no plaintext key/secret column, only
//     key_prefix/key_hmac; pepper_version NOT NULL; expires_at nullable.
//     model_provider_configs has only credential_ref, no raw-credential column.
//   - AC-6: model_provider_configs unique(org_id, purpose) + purpose CHECK.
//   - AC-7: code_embeddings.embedding vector(1024) dimension guard + round-trip
//     + hnsw vector_cosine_ops index.
//   - AC-8: mcp_client_keys same-org-actor trigger (cross-org created_by/
//     revoked_by rejected with check_violation on INSERT and UPDATE; same-org
//     succeeds; NULL allowed); durable created_by_label/revoked_by_label
//     surviving referenced-user deletion.
//   - AC-9: github_app_installations.installation_id global uniqueness +
//     independent suspended_at/revoked_at; repository_refs unique(org_id,
//     repository_id, ref_name) + graph_version >= 0 CHECK; org-delete cascade
//     across all seven new/reshaped tables; code_chunks/code_embeddings cascade
//     on parent (ref_id/chunk_id) delete.
//   - AC-10: withOrgContext positive RLS-enforcement + UUID validation +
//     transaction-local reset + cross-org write rejection + the superuser
//     vacuous-pass trap (independently re-verified here, not just in dev's
//     suite).
//   - AC-11/AC-12 are CI/verification-order concerns, not exercised by this
//     file directly (see test-results.md).
//   - Migration idempotency: 2nd migrate() run is a no-op (14 org_isolation
//     policies, 1 sayre_app role, 1 vector extension, 1 same_org_actor trigger).
//   - Documented FK-RI-vs-RLS behavior for the plain (non-triggered) FKs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool, withOrgContext } from "./client";
import { getConfig, getSecret } from "@sayre/config";

const TEST_DB_NAME = getConfig("RLS_TESTER_DB_NAME");

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

const NEW_OR_RESHAPED_TABLES: TableName[] = [
  "github_app_installations",
  "mcp_client_keys",
  "model_provider_configs",
  "model_provider_job_states",
  "repository_refs",
  "code_chunks",
  "code_embeddings",
];

/** Which column each table's org_isolation policy keys on. */
const POLICY_KEY: Record<TableName, string> = {
  organizations: "id",
  users: "org_id",
  repositories: "org_id",
  permissions: "org_id",
  ticket_cache: "org_id",
  style_rules: "org_id",
  onboarding_steps: "org_id",
  github_app_installations: "org_id",
  mcp_client_keys: "org_id",
  model_provider_configs: "org_id",
  model_provider_job_states: "org_id",
  repository_refs: "org_id",
  code_chunks: "org_id",
  code_embeddings: "org_id",
};

/**
 * Expected column shape per spec.md's "Interfaces / signatures": [dataType, nullable].
 * `code_embeddings.embedding` is special-cased separately (information_schema
 * reports `USER-DEFINED` / `udt_name = 'vector'`, not a plain data_type string)
 * -- see the dedicated vector-column handling in the shape test below; it is
 * still listed here (with a sentinel type) so the "no unexpected columns"
 * check doesn't flag it.
 */
const VECTOR_SENTINEL = "__vector__";
const EXPECTED_COLUMNS: Record<TableName, Record<string, [string, boolean]>> = {
  organizations: {
    id: ["uuid", false],
    name: ["text", false],
    slug: ["text", false],
    mcp_rate_limit_per_minute: ["integer", false],
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
    revoked_at: ["timestamp with time zone", true],
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
    inferred_reference_node_id: ["text", true],
    inferred_reference_score: ["real", true],
    inferred_reference_computed_at: ["timestamp with time zone", true],
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
  github_app_installations: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    installation_id: ["bigint", false],
    account_login: ["text", true],
    account_type: ["text", true],
    repository_selection: ["text", true],
    suspended_at: ["timestamp with time zone", true],
    revoked_at: ["timestamp with time zone", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  mcp_client_keys: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    name: ["text", false],
    key_prefix: ["text", false],
    key_hmac: ["text", false],
    pepper_version: ["integer", false],
    expires_at: ["timestamp with time zone", true],
    created_by: ["uuid", true],
    created_by_label: ["text", true],
    revoked_at: ["timestamp with time zone", true],
    revoked_by: ["uuid", true],
    revoked_by_label: ["text", true],
    last_used_at: ["timestamp with time zone", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
    // CH-01 (drizzle/0020_ch01_ephemeral_mcp_credentials.sql): ephemeral,
    // conversation-bound chat credentials live in this same table,
    // discriminated by `kind`, rather than in a new one -- see that migration's
    // header. These are the only two columns 0020 adds, and it adds no column
    // to any other table. `expires_at` above is reused as the ephemeral expiry
    // (already present, already nullable) rather than duplicated.
    // Extending the expected set, never relaxing the exact-match check: an
    // unexpected column is still a failure, and both entries below carry the
    // same [dataType, nullable] pinning as every other column here.
    kind: ["text", false],
    conversation_id: ["uuid", true],
  },
  model_provider_configs: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    purpose: ["text", false],
    provider: ["text", false],
    endpoint_url: ["text", true],
    credential_ref: ["text", true],
    model: ["text", false],
    dimension: ["integer", true],
    config: ["jsonb", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  model_provider_job_states: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repository_id: ["uuid", false],
    ref_name: ["text", false],
    revision_sha: ["text", false],
    surface: ["text", false],
    status: ["text", false],
    reason_code: ["text", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  repository_refs: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repository_id: ["uuid", false],
    ref_name: ["text", false],
    revision_sha: ["text", false],
    graph_version: ["bigint", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  code_chunks: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repository_id: ["uuid", false],
    ref_id: ["uuid", false],
    revision_sha: ["text", false],
    graph_node_id: ["text", true],
    chunk_index: ["integer", false],
    content: ["text", false],
    content_hash: ["text", false],
    start_line: ["integer", true],
    end_line: ["integer", true],
    token_count: ["integer", true],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
  code_embeddings: {
    id: ["uuid", false],
    org_id: ["uuid", false],
    repository_id: ["uuid", false],
    ref_id: ["uuid", false],
    revision_sha: ["text", false],
    chunk_id: ["uuid", false],
    graph_node_id: ["text", true],
    embedding: [VECTOR_SENTINEL, false],
    provider: ["text", false],
    model: ["text", false],
    dimension: ["integer", false],
    created_at: ["timestamp with time zone", false],
    updated_at: ["timestamp with time zone", false],
  },
};

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret("env://DATABASE_ADMIN_URL");
  } catch {
    throw new Error(
      "rls_acceptance.tester.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN). Run via `npm run test:rls:acceptance` (loads infra/.env) or export DATABASE_ADMIN_URL yourself.",
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
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

/** dim-length vector literal (default all-zero, or a fill value) for pgvector seeding. */
function vectorLiteral(dim: number, fill = 0): string {
  return `[${Array(dim).fill(fill).join(",")}]`;
}

/** Monotonic-ish unique bigint for `github_app_installations.installation_id` (globally unique). */
function uniqueInstallationId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function shaLike(label: string): string {
  return `${label.toLowerCase()}${"0".repeat(39)}`.slice(0, 40);
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

/** Seeds one row in every one of the 14 tables for a throwaway org, as admin (bypasses RLS). */
async function seedOrg(execPool: Pool, label: string): Promise<SeededOrg> {
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
  await execPool.query(
    "INSERT INTO github_app_installations (id, org_id, installation_id, account_login, account_type) VALUES ($1, $2, $3, $4, $5)",
    [githubAppInstallationId, orgId, uniqueInstallationId(), `${label}-account`, "Organization"],
  );
  await execPool.query(
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
  await execPool.query(
    "INSERT INTO model_provider_configs (id, org_id, purpose, provider, model) VALUES ($1, $2, $3, $4, $5)",
    [modelProviderConfigId, orgId, "generation", "anthropic", "claude-opus-4"],
  );
  await execPool.query(
    "INSERT INTO model_provider_job_states (id, org_id, repository_id, ref_name, revision_sha, surface, status, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      modelProviderJobStateId,
      orgId,
      repoId,
      "refs/heads/main",
      shaLike(label),
      "product",
      "degraded",
      "timeout",
    ],
  );
  await execPool.query(
    "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
    [repositoryRefId, orgId, repoId, "refs/heads/main", shaLike(label)],
  );
  await execPool.query(
    "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [codeChunkId, orgId, repoId, repositoryRefId, shaLike(label), 0, `content for ${label}`, `hash-${codeChunkId}`],
  );
  await execPool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      codeEmbeddingId,
      orgId,
      repoId,
      repositoryRefId,
      shaLike(label),
      codeChunkId,
      vectorLiteral(1024),
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
 * Builds a syntactically-valid INSERT (columns + values) for `table`, scoped
 * to `orgId`, reusing `seed`'s own FK children (repoId/refId/chunkId/userId)
 * so the row is otherwise realistic. Used to test the org_id boundary in
 * isolation (WITH CHECK), not FK validity. `organizations` is intentionally
 * excluded -- it has no org_id column to vary (it IS the tenant root).
 */
function buildInsertRow(
  table: Exclude<TableName, "organizations">,
  orgId: string,
  seed: SeededOrg,
  uniq: string,
): { cols: string[]; vals: unknown[] } {
  switch (table) {
    case "users":
      return { cols: ["id", "org_id", "email"], vals: [randomUUID(), orgId, `wtest-${uniq}@example.com`] };
    case "repositories":
      return { cols: ["id", "org_id", "name"], vals: [randomUUID(), orgId, `repo-wtest-${uniq}`] };
    case "permissions":
      return {
        cols: ["id", "org_id", "subject_type", "subject_id", "repo_id", "action"],
        vals: [randomUUID(), orgId, "user", seed.userId, seed.repoId, "read"],
      };
    case "ticket_cache":
      return {
        cols: ["id", "org_id", "repo_id", "provider", "external_ticket_id"],
        vals: [randomUUID(), orgId, seed.repoId, "jira", `WTEST-${uniq}`],
      };
    case "style_rules":
      return {
        cols: ["id", "org_id", "repo_id", "rule_type", "content"],
        vals: [randomUUID(), orgId, seed.repoId, "coding_style", `rule ${uniq}`],
      };
    case "onboarding_steps":
      return {
        cols: ["id", "org_id", "repo_id", "sequence", "title"],
        vals: [randomUUID(), orgId, seed.repoId, 1, `step ${uniq}`],
      };
    case "github_app_installations":
      return {
        cols: ["id", "org_id", "installation_id", "account_login"],
        vals: [randomUUID(), orgId, uniqueInstallationId(), `acct-${uniq}`],
      };
    case "mcp_client_keys":
      return {
        cols: ["id", "org_id", "name", "key_prefix", "key_hmac", "pepper_version"],
        vals: [randomUUID(), orgId, `key ${uniq}`, `mcp_live_wtest_${uniq}`, `hmac:${uniq}`, 1],
      };
    case "model_provider_configs":
      // Use 'embedding' (seed only ever writes 'generation') so a would-be
      // successful cross-org insert can't be masked by a unique(org_id,purpose)
      // collision with the target org's own seeded row.
      return {
        cols: ["id", "org_id", "purpose", "provider", "model"],
        vals: [randomUUID(), orgId, "embedding", "voyage", "voyage-3"],
      };
    case "model_provider_job_states":
      return {
        cols: [
          "id",
          "org_id",
          "repository_id",
          "ref_name",
          "revision_sha",
          "surface",
          "status",
          "reason_code",
        ],
        vals: [
          randomUUID(),
          orgId,
          seed.repoId,
          `refs/heads/wtest-${uniq}`,
          shaLike(uniq),
          "product",
          "degraded",
          "timeout",
        ],
      };
    case "repository_refs":
      return {
        cols: ["id", "org_id", "repository_id", "ref_name", "revision_sha"],
        vals: [randomUUID(), orgId, seed.repoId, `refs/heads/wtest-${uniq}`, shaLike(uniq)],
      };
    case "code_chunks":
      return {
        cols: ["id", "org_id", "repository_id", "ref_id", "revision_sha", "chunk_index", "content", "content_hash"],
        vals: [randomUUID(), orgId, seed.repoId, seed.repositoryRefId, shaLike(uniq), 99, `content ${uniq}`, `hash-${uniq}`],
      };
    case "code_embeddings":
      return {
        cols: ["id", "org_id", "repository_id", "ref_id", "revision_sha", "chunk_id", "embedding", "provider", "model"],
        vals: [
          randomUUID(),
          orgId,
          seed.repoId,
          seed.repositoryRefId,
          shaLike(uniq),
          seed.codeChunkId,
          vectorLiteral(1024),
          "voyage",
          `voyage-wtest-${uniq}`,
        ],
      };
  }
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
let idsA: Record<TableName, string>;
let idsB: Record<TableName, string>;

before(async () => {
  const adminUrl = await requireAdminUrl();
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
  idsA = idsByTable(orgA);
  idsB = idsByTable(orgB);
});

after(async () => {
  if (pool) {
    await pool.query("TRUNCATE organizations CASCADE");
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-2: schema / DDL shape
// ---------------------------------------------------------------------------

test("[AC-1/AC-2] all 14 tables exist with exactly the spec's columns (type + nullability)", async () => {
  for (const table of TABLE_NAMES) {
    const res = await pool.query(
      `SELECT column_name, data_type, is_nullable, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    const actual = new Map<string, { data_type: string; is_nullable: string; udt_name: string }>(
      res.rows.map((r) => [r.column_name, { data_type: r.data_type, is_nullable: r.is_nullable, udt_name: r.udt_name }]),
    );
    const expected = EXPECTED_COLUMNS[table];

    for (const col of actual.keys()) {
      assert.ok(expected[col], `${table}: unexpected column '${col}' not in spec's column list`);
    }
    for (const [col, [dataType, nullable]] of Object.entries(expected)) {
      const got = actual.get(col);
      assert.ok(got, `${table}.${col} is missing`);
      assert.equal(
        got!.is_nullable,
        nullable ? "YES" : "NO",
        `${table}.${col} nullability mismatch`,
      );
      if (dataType === VECTOR_SENTINEL) {
        // pgvector columns report data_type = 'USER-DEFINED'; assert on udt_name.
        assert.equal(got!.data_type, "USER-DEFINED", `${table}.${col} should be a USER-DEFINED (pgvector) type`);
        assert.equal(got!.udt_name, "vector", `${table}.${col} udt_name must be 'vector'`);
      } else {
        assert.equal(got!.data_type, dataType, `${table}.${col} type mismatch`);
      }
    }
  }
});

test("[AC-1/AC-2] composite/global UNIQUE constraints exist on all 14 tables", async () => {
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
  assert.ok(
    uniques.has("model_provider_configs:org_id,purpose"),
    "model_provider_configs(org_id,purpose) UNIQUE missing",
  );
  assert.ok(
    uniques.has("model_provider_job_states:org_id,repository_id,ref_name,surface"),
    "model_provider_job_states(org_id,repository_id,ref_name,surface) UNIQUE missing",
  );
  assert.ok(
    uniques.has("github_app_installations:installation_id"),
    "github_app_installations(installation_id) UNIQUE missing",
  );
  assert.ok(
    uniques.has("repository_refs:org_id,repository_id,ref_name"),
    "repository_refs(org_id,repository_id,ref_name) UNIQUE missing",
  );
  assert.ok(
    uniques.has("code_chunks:org_id,ref_id,graph_node_id,chunk_index,content_hash"),
    "code_chunks(org_id,ref_id,graph_node_id,chunk_index,content_hash) UNIQUE missing",
  );
  assert.ok(
    uniques.has("code_embeddings:chunk_id,provider,model"),
    "code_embeddings(chunk_id,provider,model) UNIQUE missing",
  );
});

test("[AC-2] every non-organizations table has an org_id FK to organizations with ON DELETE CASCADE", async () => {
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
  const repoFks = res.rows.filter((r) => r.column_name === "repository_id" && r.ref_table === "repositories");
  assert.ok(repoFks.length >= 3, "expected repository_id FKs on repository_refs/code_chunks/code_embeddings");
  for (const r of repoFks) {
    assert.equal(r.delete_rule, "CASCADE", `${r.table_name}.repository_id FK must be ON DELETE CASCADE`);
  }
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: RLS enabled + FORCED + org_isolation policy per table
// ---------------------------------------------------------------------------

test("[AC-3] every table has RLS ENABLED and FORCED", async () => {
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

test("[AC-3] each table has an org_isolation policy (cmd ALL, USING + WITH CHECK, correct key column)", async () => {
  const res = await pool.query(
    `SELECT tablename, policyname, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname='public'
        AND policyname='org_isolation'
        AND tablename = ANY($1)`,
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
    const key = POLICY_KEY[table];
    for (const clause of [p!.qual, p!.with_check]) {
      assert.match(clause, new RegExp(`\\b${key}\\b`), `${table}: policy clause must key on ${key}`);
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

test("[AC-3] purpose, graph_version, provider-state, and MCP rate CHECK constraints exist", async () => {
  const res = await pool.query(
    `SELECT conname, conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`,
  );
  const byName = new Map(res.rows.map((r) => [r.conname, r]));
  const purposeCheck = byName.get("model_provider_configs_purpose_check");
  assert.ok(purposeCheck, "model_provider_configs_purpose_check missing");
  assert.match(purposeCheck!.def, /purpose/);
  assert.match(purposeCheck!.def, /'generation'/);
  assert.match(purposeCheck!.def, /'embedding'/);

  const graphVersionCheck = byName.get("repository_refs_graph_version_nonneg");
  assert.ok(graphVersionCheck, "repository_refs_graph_version_nonneg missing");
  assert.match(graphVersionCheck!.def, /graph_version/);
  assert.match(graphVersionCheck!.def, />=\s*0/);

  for (const name of [
    "model_provider_job_states_surface_check",
    "model_provider_job_states_status_check",
    "model_provider_job_states_reason_check",
    "model_provider_job_states_status_reason_check",
  ]) {
    assert.ok(byName.has(name), `${name} missing`);
  }

  const mcpRateCheck = byName.get("organizations_mcp_rate_limit_check");
  assert.ok(mcpRateCheck, "organizations_mcp_rate_limit_check missing");
  assert.match(mcpRateCheck!.def, /mcp_rate_limit_per_minute/);
  assert.match(mcpRateCheck!.def, />=\s*1/);
  assert.match(mcpRateCheck!.def, /<=\s*10000/);
});

test("[AC-8] the mcp_client_keys_same_org_actor BEFORE INSERT/UPDATE trigger exists exactly once", async () => {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'same_org_actor' AND tgrelid = 'mcp_client_keys'::regclass AND NOT tgisinternal`,
  );
  assert.equal(res.rows[0].n, 1, "expected exactly one same_org_actor trigger on mcp_client_keys");
});

test("[edge] updated_at trigger fires on each new table", async () => {
  const cases: Array<{ table: TableName; id: string; setClause: string }> = [
    { table: "github_app_installations", id: orgA.githubAppInstallationId, setClause: "account_login = 'renamed'" },
    { table: "repository_refs", id: orgA.repositoryRefId, setClause: "revision_sha = revision_sha" },
    { table: "code_chunks", id: orgA.codeChunkId, setClause: "chunk_index = chunk_index" },
    { table: "code_embeddings", id: orgA.codeEmbeddingId, setClause: "model = model" },
    {
      table: "model_provider_job_states",
      id: orgA.modelProviderJobStateId,
      setClause: "revision_sha = revision_sha",
    },
  ];
  for (const { table, id, setClause } of cases) {
    await pool.query(`UPDATE ${table} SET ${setClause}, updated_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [id]);
    const res = await pool.query(
      `SELECT extract(year from updated_at)::int AS yr, updated_at > created_at AS advanced FROM ${table} WHERE id = $1`,
      [id],
    );
    assert.notEqual(res.rows[0].yr, 2000, `${table}: trigger must overwrite the caller-supplied stale updated_at`);
    assert.equal(res.rows[0].advanced, true, `${table}: updated_at must advance past created_at after an UPDATE`);
  }
});

// ---------------------------------------------------------------------------
// AC-4: cross-tenant read isolation across all 14 tables
// ---------------------------------------------------------------------------

test("[AC-4] org A tenant session sees only its own row (and zero org B rows) across all 14 tables", async () => {
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

test("[AC-4] org B tenant session sees only its own row (and zero org A rows) across all 14 tables", async () => {
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

// ---------------------------------------------------------------------------
// AC-4: cross-tenant write rejection across all 14 (non-organizations) tables
// ---------------------------------------------------------------------------

test("[AC-4] cross-org INSERT (org_id = B) is rejected under context A, across every non-organizations table", async () => {
  const tables = TABLE_NAMES.filter((t): t is Exclude<TableName, "organizations"> => t !== "organizations");
  for (const table of tables) {
    const { cols, vals } = buildInsertRow(table, orgB.orgId, orgA, `xw-${table}-${randomUUID().slice(0, 8)}`);
    await withTenantSession(pool, orgA.orgId, async (c) => {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      await assert.rejects(
        c.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`, vals),
        /row-level security/i,
        `${table}: insert with a foreign org_id must be blocked under context A`,
      );
    });
  }
});

test("[AC-4] UPDATE ... SET org_id = B on an own row under context A is rejected by WITH CHECK, for every non-organizations table", async () => {
  const tables = TABLE_NAMES.filter((t): t is Exclude<TableName, "organizations"> => t !== "organizations");
  for (const table of tables) {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      await assert.rejects(
        c.query(`UPDATE ${table} SET org_id = $1 WHERE id = $2`, [orgB.orgId, idsA[table]]),
        /row-level security/i,
        `${table}: reparenting a row to another org must be blocked`,
      );
    });
  }
});

test("[AC-4] UPDATE targeting the other org's row affects 0 rows (USING filters it out), for every table", async () => {
  for (const table of TABLE_NAMES) {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      const res = await c.query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [idsB[table]]);
      assert.equal(res.rowCount, 0, `${table}: org A must not be able to update org B's row`);
    });
  }
});

test("[AC-4] unset app.org_id -> every table returns 0 rows and rejects INSERT (fail-closed writes)", async () => {
  await withTenantSession(pool, undefined, async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: expected 0 rows with no org context set`);
    }
  });
  const tables = TABLE_NAMES.filter((t): t is Exclude<TableName, "organizations"> => t !== "organizations");
  for (const table of tables) {
    const { cols, vals } = buildInsertRow(table, orgA.orgId, orgA, `noctx-${table}-${randomUUID().slice(0, 8)}`);
    await withTenantSession(pool, undefined, async (c) => {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      await assert.rejects(
        c.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`, vals),
        /row-level security/i,
        `${table}: insert with no org context must be blocked`,
      );
    });
  }
});

test("[AC-4] empty-string app.org_id -> zero rows on every table, no invalid-uuid cast error", async () => {
  await withTenantSession(pool, "", async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: expected 0 rows with empty-string org context`);
    }
  });
});

test("[edge] a valid-but-unseeded org context returns 0 rows across all 14 tables (fail-closed for unknown org)", async () => {
  const unknownOrg = randomUUID();
  await withTenantSession(pool, unknownOrg, async (c) => {
    for (const table of TABLE_NAMES) {
      const res = await c.query(`SELECT id FROM ${table}`);
      assert.equal(res.rowCount, 0, `${table}: unknown org must see 0 rows`);
    }
  });
});

test("[edge] two concurrent sessions with different app.org_id do not bleed rows from any table", async () => {
  const cA = await pool.connect();
  const cB = await pool.connect();
  try {
    await cA.query("BEGIN");
    await cA.query("SET LOCAL ROLE sayre_app");
    await cA.query("SELECT set_config('app.org_id', $1, true)", [orgA.orgId]);

    await cB.query("BEGIN");
    await cB.query("SET LOCAL ROLE sayre_app");
    await cB.query("SELECT set_config('app.org_id', $1, true)", [orgB.orgId]);

    for (const table of TABLE_NAMES) {
      const a1 = await cA.query(`SELECT id FROM ${table}`);
      const b1 = await cB.query(`SELECT id FROM ${table}`);
      const a2 = await cA.query(`SELECT id FROM ${table} WHERE id = $1`, [idsB[table]]);
      const b2 = await cB.query(`SELECT id FROM ${table} WHERE id = $1`, [idsA[table]]);
      assert.equal(a1.rowCount, 1, `${table}: session A should see exactly 1 row`);
      assert.equal(a1.rows[0].id, idsA[table]);
      assert.equal(b1.rowCount, 1, `${table}: session B should see exactly 1 row`);
      assert.equal(b1.rows[0].id, idsB[table]);
      assert.equal(a2.rowCount, 0, `${table}: session A must not see org B even by direct PK`);
      assert.equal(b2.rowCount, 0, `${table}: session B must not see org A even by direct PK`);
    }
  } finally {
    await cA.query("ROLLBACK");
    await cB.query("ROLLBACK");
    cA.release();
    cB.release();
  }
});

// ---------------------------------------------------------------------------
// AC-5: sayre_app role + privileges
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

test("[AC-5] sayre_app has SELECT/INSERT/UPDATE/DELETE on all 14 tables and owns none of them", async () => {
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
// AC-5: mcp_client_keys no-plaintext guard + pepper_version/expires_at
// ---------------------------------------------------------------------------

test("[AC-5] mcp_client_keys has no plaintext key/secret column (only key_prefix + key_hmac)", async () => {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_client_keys'`,
  );
  const colNames = new Set(cols.rows.map((r) => r.column_name as string));
  for (const forbidden of ["key", "secret", "raw_key", "token", "password", "key_hash", "roles"]) {
    assert.ok(!colNames.has(forbidden), `mcp_client_keys must NOT have a '${forbidden}' column`);
  }
  assert.ok(colNames.has("key_prefix"), "mcp_client_keys must have key_prefix");
  assert.ok(colNames.has("key_hmac"), "mcp_client_keys must have key_hmac (renamed from key_hash)");
});

test("[W4-06] pre-tenant key bootstrap exposes one exact prefix through sayre_app only", async () => {
  const prefixResult = await pool.query(
    "SELECT key_prefix FROM mcp_client_keys WHERE id = $1",
    [orgA.mcpClientKeyId],
  );
  const prefix = prefixResult.rows[0].key_prefix as string;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE sayre_app");
    const resolved = await client.query(
      "SELECT * FROM resolve_mcp_client_key($1)",
      [prefix],
    );
    assert.equal(resolved.rowCount, 1);
    assert.equal(resolved.rows[0].org_id, orgA.orgId);
    assert.equal(resolved.rows[0].key_prefix, prefix);
    assert.equal(resolved.rows[0].rate_limit_per_minute, 60);
    const unknown = await client.query(
      "SELECT * FROM resolve_mcp_client_key($1)",
      ["mcp_live_unknown_00000000"],
    );
    assert.equal(unknown.rowCount, 0);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const privileges = await pool.query(
    `SELECT has_function_privilege('sayre_app', 'resolve_mcp_client_key(text)', 'EXECUTE') AS app_can,
            has_function_privilege('public', 'resolve_mcp_client_key(text)', 'EXECUTE') AS public_can`,
  );
  assert.equal(privileges.rows[0].app_can, true);
  assert.equal(privileges.rows[0].public_can, false);
});

test("[W4-06] MCP rate policy is tenant-scoped and database-bounded", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const updated = await c.query(
      "UPDATE organizations SET mcp_rate_limit_per_minute = 75 WHERE id = $1 RETURNING mcp_rate_limit_per_minute",
      [orgA.orgId],
    );
    assert.equal(updated.rows[0].mcp_rate_limit_per_minute, 75);
    const cross = await c.query(
      "UPDATE organizations SET mcp_rate_limit_per_minute = 80 WHERE id = $1",
      [orgB.orgId],
    );
    assert.equal(cross.rowCount, 0);
    await assert.rejects(
      c.query(
        "UPDATE organizations SET mcp_rate_limit_per_minute = 0 WHERE id = $1",
        [orgA.orgId],
      ),
      /organizations_mcp_rate_limit_check/,
    );
  });
  await pool.query(
    "UPDATE organizations SET mcp_rate_limit_per_minute = 60 WHERE id = $1",
    [orgA.orgId],
  );
});

test("[AC-5] mcp_client_keys.pepper_version is NOT NULL: an insert omitting it fails", async () => {
  await assert.rejects(
    pool.query("INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac) VALUES ($1, $2, $3, $4, $5)", [
      randomUUID(),
      orgA.orgId,
      "no-pepper",
      `mcp_live_nopepper_${randomUUID().slice(0, 8)}`,
      "hmac:x",
    ]),
    /pepper_version/,
    "omitting pepper_version must violate its NOT NULL constraint",
  );
});

test("[AC-5] mcp_client_keys.expires_at: both NULL and a set value round-trip", async () => {
  const idNull = randomUUID();
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version, expires_at) VALUES ($1, $2, $3, $4, $5, $6, NULL)",
    [idNull, orgA.orgId, "no-expiry", `mcp_live_noexp_${idNull.slice(0, 8)}`, `hmac:${idNull}`, 1],
  );
  const idSet = randomUUID();
  const expiry = new Date(Date.now() + 86400_000).toISOString();
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [idSet, orgA.orgId, "with-expiry", `mcp_live_exp_${idSet.slice(0, 8)}`, `hmac:${idSet}`, 1, expiry],
  );

  const resNull = await pool.query("SELECT expires_at FROM mcp_client_keys WHERE id = $1", [idNull]);
  assert.equal(resNull.rows[0].expires_at, null, "NULL expires_at must round-trip as NULL");
  const resSet = await pool.query("SELECT expires_at FROM mcp_client_keys WHERE id = $1", [idSet]);
  assert.ok(resSet.rows[0].expires_at, "set expires_at must round-trip as a timestamp");

  // RLS does not filter on expiry -- a valid-but-expired row is still SELECT-able under its own org.
  const pastExpiry = new Date(Date.now() - 86400_000).toISOString();
  await pool.query("UPDATE mcp_client_keys SET expires_at = $1 WHERE id = $2", [pastExpiry, idSet]);
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT id FROM mcp_client_keys WHERE id = $1", [idSet]);
    assert.equal(res.rowCount, 1, "an expired-but-own-org key must still be SELECT-able (RLS is org_id only)");
  });

  await pool.query("DELETE FROM mcp_client_keys WHERE id = ANY($1)", [[idNull, idSet]]);
});

test("[edge] mcp_client_keys.key_prefix is globally unique across orgs, not just per-org", async () => {
  const sharedPrefix = `mcp_live_dup_${randomUUID().slice(0, 8)}`;
  const idOne = randomUUID();
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version) VALUES ($1, $2, $3, $4, $5, $6)",
    [idOne, orgA.orgId, "dup-1", sharedPrefix, `hmac:${idOne}`, 1],
  );
  const idTwo = randomUUID();
  await assert.rejects(
    pool.query(
      "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version) VALUES ($1, $2, $3, $4, $5, $6)",
      [idTwo, orgB.orgId, "dup-2", sharedPrefix, `hmac:${idTwo}`, 1],
    ),
    /mcp_client_keys_key_prefix_unique/,
    "a second key with the same key_prefix in a DIFFERENT org must violate the global unique constraint",
  );
  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [idOne]);
});

test("[edge] soft revocation: setting revoked_at does not remove the row; it stays SELECT-able under its own org", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const before = await c.query("SELECT revoked_at FROM mcp_client_keys WHERE id = $1", [orgA.mcpClientKeyId]);
    assert.equal(before.rows[0].revoked_at, null, "precondition: seeded key starts active");
  });
  await pool.query("UPDATE mcp_client_keys SET revoked_at = now() WHERE id = $1", [orgA.mcpClientKeyId]);
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const after = await c.query("SELECT revoked_at FROM mcp_client_keys WHERE id = $1", [orgA.mcpClientKeyId]);
    assert.equal(after.rowCount, 1, "a revoked key must still be SELECT-able under its own org");
    assert.notEqual(after.rows[0].revoked_at, null);
  });
  await pool.query("UPDATE mcp_client_keys SET revoked_at = NULL WHERE id = $1", [orgA.mcpClientKeyId]);
});

// ---------------------------------------------------------------------------
// AC-8: same-org-actor trigger + durable attribution labels
// ---------------------------------------------------------------------------

test("[AC-8] INSERT with created_by referencing a different-org user is rejected with check_violation", async () => {
  const keyId = randomUUID();
  const prefix = `mcp_live_xorg_${keyId.slice(0, 8)}`;
  await assert.rejects(
    pool.query(
      "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [keyId, orgA.orgId, "cross-org-actor", prefix, `hmac:${keyId}`, 1, orgB.userId],
    ),
    /same org/i,
    "created_by referencing a user in a different org must be rejected by the same-org-actor trigger",
  );
});

test("[AC-8] INSERT with revoked_by referencing a different-org user is rejected with check_violation", async () => {
  const keyId = randomUUID();
  const prefix = `mcp_live_xorg2_${keyId.slice(0, 8)}`;
  await assert.rejects(
    pool.query(
      "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version, revoked_by, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())",
      [keyId, orgA.orgId, "cross-org-revoker", prefix, `hmac:${keyId}`, 1, orgB.userId],
    ),
    /same org/i,
    "revoked_by referencing a user in a different org must be rejected by the same-org-actor trigger",
  );
});

test("[AC-8] UPDATE setting created_by/revoked_by to a different-org user is rejected; same-org actor succeeds; NULL is allowed", async () => {
  const keyId = randomUUID();
  const prefix = `mcp_live_upd_${keyId.slice(0, 8)}`;
  // NULL actor allowed at insert time.
  await pool.query(
    "INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version) VALUES ($1, $2, $3, $4, $5, $6)",
    [keyId, orgA.orgId, "update-actor-test", prefix, `hmac:${keyId}`, 1],
  );

  await assert.rejects(
    pool.query("UPDATE mcp_client_keys SET created_by = $1 WHERE id = $2", [orgB.userId, keyId]),
    /same org/i,
    "UPDATE setting created_by to a cross-org user must be rejected",
  );
  await assert.rejects(
    pool.query("UPDATE mcp_client_keys SET revoked_by = $1, revoked_at = now() WHERE id = $2", [orgB.userId, keyId]),
    /same org/i,
    "UPDATE setting revoked_by to a cross-org user must be rejected",
  );

  // Same-org actor succeeds.
  await pool.query("UPDATE mcp_client_keys SET created_by = $1 WHERE id = $2", [orgA.userId, keyId]);
  const res = await pool.query("SELECT created_by FROM mcp_client_keys WHERE id = $1", [keyId]);
  assert.equal(res.rows[0].created_by, orgA.userId, "same-org created_by update must succeed");

  await pool.query("DELETE FROM mcp_client_keys WHERE id = $1", [keyId]);
});

test("[AC-8] durable attribution: deleting the referenced user sets the live pointer NULL but *_label snapshots and the key row survive", async () => {
  // Isolated in its own throwaway org (rather than reusing shared orgA) and
  // wrapped in try/finally: this specific scenario (created_by AND revoked_by
  // both pointing at the SAME user) is exactly the case that trips a bug
  // found while writing this suite (see test-results.md) -- keeping this
  // test's fixtures isolated means a failure here can't leak stray rows into
  // later shared-fixture (orgA/orgB) tests.
  const orgId = randomUUID();
  const adminUserId = randomUUID();
  const keyId = randomUUID();
  try {
    await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
      orgId,
      "durable-attribution-org",
      `durable-attr-org-${orgId.slice(0, 8)}`,
    ]);
    await pool.query("INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)", [
      adminUserId,
      orgId,
      `admin-${adminUserId.slice(0, 8)}@example.com`,
    ]);
    const prefix = `mcp_live_durable_${keyId.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO mcp_client_keys
         (id, org_id, name, key_prefix, key_hmac, pepper_version, created_by, created_by_label, revoked_by, revoked_by_label, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        keyId,
        orgId,
        "durable-attribution-key",
        prefix,
        `hmac:${keyId}`,
        1,
        adminUserId,
        "admin@example.com (snapshot)",
        adminUserId,
        "admin@example.com (snapshot)",
      ],
    );

    // Per spec.md's Defect-B design ("The SET NULL fires a BEFORE-UPDATE on
    // the key row setting the pointer NULL; the same-org trigger sees NULL
    // and skips -- no false rejection"), deleting the referenced user must
    // succeed and set both live pointers NULL while the *_label snapshots
    // and the row survive.
    await pool.query("DELETE FROM users WHERE id = $1", [adminUserId]);

    const res = await pool.query(
      "SELECT created_by, created_by_label, revoked_by, revoked_by_label FROM mcp_client_keys WHERE id = $1",
      [keyId],
    );
    assert.equal(res.rowCount, 1, "the key row must survive the admin user's deletion");
    assert.equal(res.rows[0].created_by, null, "created_by (live pointer) must be set NULL after user deletion");
    assert.equal(res.rows[0].revoked_by, null, "revoked_by (live pointer) must be set NULL after user deletion");
    assert.equal(
      res.rows[0].created_by_label,
      "admin@example.com (snapshot)",
      "created_by_label must survive the referenced user's deletion",
    );
    assert.equal(
      res.rows[0].revoked_by_label,
      "admin@example.com (snapshot)",
      "revoked_by_label must survive the referenced user's deletion",
    );
  } finally {
    // Cascade-delete via the org regardless of where the test failed, so no
    // stray rows (org / user / key) leak into later shared-fixture tests.
    await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
  }
});

// ---------------------------------------------------------------------------
// AC-5/AC-6: model_provider_configs purpose uniqueness, CHECK, no-raw-credential
// ---------------------------------------------------------------------------

test("[AC-5] model_provider_configs has no raw-credential column (only credential_ref)", async () => {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'model_provider_configs'`,
  );
  const colNames = new Set(cols.rows.map((r) => r.column_name as string));
  for (const forbidden of ["credential", "raw_credential", "token", "password", "secret", "api_key"]) {
    assert.ok(!colNames.has(forbidden), `model_provider_configs must NOT have a '${forbidden}' column`);
  }
  assert.ok(colNames.has("credential_ref"), "model_provider_configs must have credential_ref");
});

test("[AC-6] model_provider_configs: second insert for the same (org_id, purpose) fails; different purpose for the same org succeeds", async () => {
  await assert.rejects(
    pool.query("INSERT INTO model_provider_configs (id, org_id, purpose, provider, model) VALUES ($1, $2, $3, $4, $5)", [
      randomUUID(),
      orgA.orgId,
      "generation",
      "openai",
      "gpt-5",
    ]),
    /model_provider_configs_org_purpose_unique/,
    "a second row for the same (org, purpose) must violate the unique constraint",
  );

  const embeddingId = randomUUID();
  await pool.query(
    "INSERT INTO model_provider_configs (id, org_id, purpose, provider, model, dimension) VALUES ($1, $2, $3, $4, $5, $6)",
    [embeddingId, orgA.orgId, "embedding", "voyage", "voyage-3", 1024],
  );
  const check = await pool.query("SELECT id FROM model_provider_configs WHERE id = $1", [embeddingId]);
  assert.equal(check.rowCount, 1, "a different purpose for the same org must succeed");
  await pool.query("DELETE FROM model_provider_configs WHERE id = $1", [embeddingId]);
});

test("[AC-6] model_provider_configs.purpose outside {generation, embedding} is rejected by the CHECK", async () => {
  await assert.rejects(
    pool.query("INSERT INTO model_provider_configs (id, org_id, purpose, provider, model) VALUES ($1, $2, $3, $4, $5)", [
      randomUUID(),
      orgA.orgId,
      "bogus",
      "openai",
      "gpt-5",
    ]),
    /model_provider_configs_purpose_check/,
    "purpose='bogus' must violate the CHECK constraint",
  );
});

// ---------------------------------------------------------------------------
// W3-08: model_provider_job_states minimal/sanitized tenant contract
// ---------------------------------------------------------------------------

test("[W3-08] model_provider_job_states has only scope, closed state, reason, and timestamps", async () => {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'model_provider_job_states'`,
  );
  const colNames = new Set(cols.rows.map((row) => row.column_name as string));
  for (const forbidden of [
    "provider",
    "model",
    "endpoint",
    "endpoint_url",
    "prompt",
    "response",
    "error",
    "error_text",
    "credential_ref",
  ]) {
    assert.ok(!colNames.has(forbidden), `provider job state must not persist ${forbidden}`);
  }
  assert.deepEqual(
    [...colNames].sort(),
    [
      "created_at",
      "id",
      "org_id",
      "reason_code",
      "ref_name",
      "repository_id",
      "revision_sha",
      "status",
      "surface",
      "updated_at",
    ],
  );
});

test("[W3-08] provider-state enums and status/reason coherence are database-enforced", async () => {
  const base = [
    randomUUID(),
    orgA.orgId,
    orgA.repoId,
    `refs/heads/state-${randomUUID().slice(0, 8)}`,
    shaLike("state"),
  ];
  for (const [surface, status, reason, constraint] of [
    ["unknown", "degraded", "timeout", "surface_check"],
    ["product", "unknown", "timeout", "status_check"],
    ["product", "degraded", "raw provider error", "reason_check"],
    ["product", "ready", "timeout", "status_reason_check"],
    ["product", "failed", null, "status_reason_check"],
  ] as const) {
    await assert.rejects(
      pool.query(
        `INSERT INTO model_provider_job_states
          (id, org_id, repository_id, ref_name, revision_sha, surface, status, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), ...base.slice(1), surface, status, reason],
      ),
      new RegExp(`model_provider_job_states_.*${constraint}`),
    );
  }
});

test("[W3-08] forged cross-org repository association is rejected by the composite FK", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO model_provider_job_states
        (id, org_id, repository_id, ref_name, revision_sha, surface, status)
       VALUES ($1, $2, $3, $4, $5, 'product', 'generating')`,
      [randomUUID(), orgA.orgId, orgB.repoId, "refs/heads/forged", shaLike("forged")],
    ),
    /model_provider_job_states_org_repository_fk/,
  );
});

test("[W3-08] provider-state scope/update index exists", async () => {
  const result = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public'
        AND tablename='model_provider_job_states'
        AND indexname='model_provider_job_states_scope_updated_idx'`,
  );
  assert.equal(result.rowCount, 1);
  assert.match(
    result.rows[0].indexdef,
    /\(org_id, repository_id, ref_name, surface, updated_at DESC\)/,
  );
});

// ---------------------------------------------------------------------------
// AC-9: github_app_installations
// ---------------------------------------------------------------------------

test("[AC-9] installation_id is globally unique (bigint)", async () => {
  const dupId = uniqueInstallationId();
  await pool.query(
    "INSERT INTO github_app_installations (id, org_id, installation_id) VALUES ($1, $2, $3)",
    [randomUUID(), orgA.orgId, dupId],
  );
  await assert.rejects(
    pool.query("INSERT INTO github_app_installations (id, org_id, installation_id) VALUES ($1, $2, $3)", [
      randomUUID(),
      orgB.orgId,
      dupId,
    ]),
    /github_app_installations_installation_id_unique/,
    "a second installation with the same installation_id in a different org must violate the unique constraint",
  );
  await pool.query("DELETE FROM github_app_installations WHERE installation_id = $1", [dupId]);
});

test("[AC-9] suspended_at and revoked_at are independent nullable columns, settable independently of each other", async () => {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO github_app_installations (id, org_id, installation_id) VALUES ($1, $2, $3)",
    [id, orgA.orgId, uniqueInstallationId()],
  );
  let res = await pool.query("SELECT suspended_at, revoked_at FROM github_app_installations WHERE id = $1", [id]);
  assert.equal(res.rows[0].suspended_at, null, "precondition: both NULL");
  assert.equal(res.rows[0].revoked_at, null, "precondition: both NULL");

  // Set suspended_at only.
  await pool.query("UPDATE github_app_installations SET suspended_at = now() WHERE id = $1", [id]);
  res = await pool.query("SELECT suspended_at, revoked_at FROM github_app_installations WHERE id = $1", [id]);
  assert.ok(res.rows[0].suspended_at, "suspended_at must be settable independently");
  assert.equal(res.rows[0].revoked_at, null, "revoked_at must remain NULL when only suspended_at is set");

  // GitHub unsuspends -> suspended_at clears back to NULL, independent of revoked_at.
  await pool.query("UPDATE github_app_installations SET suspended_at = NULL WHERE id = $1", [id]);
  res = await pool.query("SELECT suspended_at, revoked_at FROM github_app_installations WHERE id = $1", [id]);
  assert.equal(res.rows[0].suspended_at, null, "suspended_at must be independently clearable (reversible)");

  // Now set revoked_at only (uninstall webhook) -- independent of suspended_at.
  await pool.query("UPDATE github_app_installations SET revoked_at = now() WHERE id = $1", [id]);
  res = await pool.query("SELECT suspended_at, revoked_at FROM github_app_installations WHERE id = $1", [id]);
  assert.equal(res.rows[0].suspended_at, null, "suspended_at must remain NULL when only revoked_at is set");
  assert.ok(res.rows[0].revoked_at, "revoked_at must be settable independently");

  // Both set simultaneously must also be representable (not mutually exclusive at the DB layer).
  await pool.query("UPDATE github_app_installations SET suspended_at = now() WHERE id = $1", [id]);
  res = await pool.query("SELECT suspended_at, revoked_at FROM github_app_installations WHERE id = $1", [id]);
  assert.ok(res.rows[0].suspended_at, "suspended_at and revoked_at can both be non-NULL simultaneously");
  assert.ok(res.rows[0].revoked_at);

  await pool.query("DELETE FROM github_app_installations WHERE id = $1", [id]);
});

// ---------------------------------------------------------------------------
// AC-9: repository_refs
// ---------------------------------------------------------------------------

test("[AC-9] repository_refs: unique(org_id, repository_id, ref_name) enforced; two different refs in the same repo coexist", async () => {
  const dupId = randomUUID();
  await assert.rejects(
    pool.query(
      "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
      [dupId, orgA.orgId, orgA.repoId, "refs/heads/main", shaLike("dup")],
    ),
    /repository_refs_org_repo_ref_unique/,
    "a duplicate (org_id, repository_id, ref_name) must violate the unique constraint",
  );

  const otherRefId = randomUUID();
  await pool.query(
    "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
    [otherRefId, orgA.orgId, orgA.repoId, "refs/heads/develop", shaLike("dev")],
  );
  const check = await pool.query("SELECT id FROM repository_refs WHERE id = $1", [otherRefId]);
  assert.equal(check.rowCount, 1, "a different ref_name in the same repo must succeed");
  await pool.query("DELETE FROM repository_refs WHERE id = $1", [otherRefId]);
});

test("[AC-9] repository_refs.graph_version >= 0 CHECK rejects negative values", async () => {
  await assert.rejects(
    pool.query(
      "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha, graph_version) VALUES ($1, $2, $3, $4, $5, $6)",
      [randomUUID(), orgA.orgId, orgA.repoId, "refs/heads/neg-test", shaLike("neg"), -1],
    ),
    /repository_refs_graph_version_nonneg/,
    "graph_version = -1 must violate the CHECK constraint",
  );
});

// ---------------------------------------------------------------------------
// AC-9: code_chunks / code_embeddings cascades + uniques + indexes
// ---------------------------------------------------------------------------

test("[AC-9] code_chunks: node-scoped chunk identity is unique without collapsing identical snippets", async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const graphNodeId = `file-${randomUUID()}`;
  const contentHash = `hash-${randomUUID()}`;
  await pool.query(
    "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, graph_node_id, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [firstId, orgA.orgId, orgA.repoId, orgA.repositoryRefId, shaLike("dup"), graphNodeId, 1, "dup content", contentHash],
  );
  try {
    await assert.rejects(
      pool.query(
        "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, graph_node_id, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [randomUUID(), orgA.orgId, orgA.repoId, orgA.repositoryRefId, shaLike("dup"), graphNodeId, 1, "dup content", contentHash],
      ),
      /code_chunks_org_ref_node_index_hash_unique/,
      "the same node/index/content identity must violate the unique constraint",
    );
    await pool.query(
      "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, graph_node_id, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [secondId, orgA.orgId, orgA.repoId, orgA.repositoryRefId, shaLike("dup"), `other-${graphNodeId}`, 1, "dup content", contentHash],
    );
  } finally {
    await pool.query("DELETE FROM code_chunks WHERE id = ANY($1::uuid[])", [[firstId, secondId]]);
  }
});

test("[AC-9] code_chunks.graph_node_id index exists", async () => {
  const res = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='code_chunks' AND indexname='code_chunks_graph_node_id_idx'`,
  );
  assert.equal(res.rowCount, 1, "code_chunks_graph_node_id_idx missing");
});

test("[AC-9] deleting the parent repository_refs row cascades to code_chunks and code_embeddings", async () => {
  const refId = randomUUID();
  await pool.query(
    "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
    [refId, orgA.orgId, orgA.repoId, "refs/heads/cascade-test", shaLike("casc")],
  );
  const chunkId = randomUUID();
  await pool.query(
    "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [chunkId, orgA.orgId, orgA.repoId, refId, shaLike("casc"), 0, "cascade content", `hash-cascade-${chunkId}`],
  );
  const embeddingId = randomUUID();
  await pool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [embeddingId, orgA.orgId, orgA.repoId, refId, shaLike("casc"), chunkId, vectorLiteral(1024), "voyage", "voyage-cascade"],
  );

  await pool.query("DELETE FROM repository_refs WHERE id = $1", [refId]);

  const chunkRes = await pool.query("SELECT id FROM code_chunks WHERE id = $1", [chunkId]);
  assert.equal(chunkRes.rowCount, 0, "code_chunks row must cascade-delete when its parent repository_refs row is deleted");
  const embeddingRes = await pool.query("SELECT id FROM code_embeddings WHERE id = $1", [embeddingId]);
  assert.equal(embeddingRes.rowCount, 0, "code_embeddings row must cascade-delete transitively via code_chunks");
});

test("[AC-9] deleting the parent code_chunks row cascades to code_embeddings", async () => {
  const chunkId = randomUUID();
  await pool.query(
    "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [chunkId, orgA.orgId, orgA.repoId, orgA.repositoryRefId, shaLike("chk"), 1, "another chunk", `hash-chunkcasc-${chunkId}`],
  );
  const embeddingId = randomUUID();
  await pool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [embeddingId, orgA.orgId, orgA.repoId, orgA.repositoryRefId, shaLike("chk"), chunkId, vectorLiteral(1024), "voyage", "voyage-chunkcasc"],
  );

  await pool.query("DELETE FROM code_chunks WHERE id = $1", [chunkId]);

  const embeddingRes = await pool.query("SELECT id FROM code_embeddings WHERE id = $1", [embeddingId]);
  assert.equal(embeddingRes.rowCount, 0, "code_embeddings row must cascade-delete when its parent code_chunks row is deleted");
});

// ---------------------------------------------------------------------------
// AC-7: code_embeddings vector(1024) dimension guard, round-trip, cosine ops, hnsw index
// ---------------------------------------------------------------------------

test("[AC-7] code_embeddings.embedding accepts a 1024-dim vector and round-trips it", async () => {
  const id = randomUUID();
  const values = Array.from({ length: 1024 }, (_, i) => (i % 7) - 3);
  await pool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      orgA.orgId,
      orgA.repoId,
      orgA.repositoryRefId,
      shaLike("rt"),
      orgA.codeChunkId,
      `[${values.join(",")}]`,
      "voyage",
      `voyage-roundtrip-${id.slice(0, 8)}`,
    ],
  );
  const res = await pool.query("SELECT embedding FROM code_embeddings WHERE id = $1", [id]);
  const raw = res.rows[0].embedding as string;
  const roundTripped = raw.slice(1, -1).split(",").map(Number);
  assert.equal(roundTripped.length, 1024, "embedding must round-trip as exactly 1024 dimensions");
  assert.deepEqual(roundTripped, values, "embedding values must round-trip exactly");
  await pool.query("DELETE FROM code_embeddings WHERE id = $1", [id]);
});

test("[AC-7] code_embeddings.embedding rejects a 1023-dim or 1025-dim insert", async () => {
  for (const dim of [1023, 1025]) {
    await assert.rejects(
      pool.query(
        "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          randomUUID(),
          orgA.orgId,
          orgA.repoId,
          orgA.repositoryRefId,
          shaLike("bad"),
          orgA.codeChunkId,
          vectorLiteral(dim),
          "voyage",
          `voyage-baddim-${dim}`,
        ],
      ),
      /dimension/i,
      `a ${dim}-dim vector must be rejected by the vector(1024) column`,
    );
  }
});

test("[AC-7] code_embeddings: cosine-distance ORDER BY is usable without error", async () => {
  // NOTE: the shared seed rows (orgA/orgB) use an all-zero vector, which is
  // mathematically degenerate for cosine distance (zero magnitude -> NaN),
  // and Postgres silently drops NaN-distance rows from an ORDER BY ... LIMIT
  // result (no error, just 0 rows) -- confirmed independently via psql. That
  // is a property of NaN + top-N sort, not a schema defect (AC-7 only
  // requires the query not to *error*). Use a non-degenerate embedding here
  // so the "usable" assertion is meaningful rather than accidentally
  // exercising the NaN-drop edge case.
  const id = randomUUID();
  const nonDegenerate = Array.from({ length: 1024 }, (_, i) => Math.sin(i) + 1);
  await pool.query(
    "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      orgA.orgId,
      orgA.repoId,
      orgA.repositoryRefId,
      shaLike("cos"),
      orgA.codeChunkId,
      `[${nonDegenerate.join(",")}]`,
      "voyage",
      `voyage-cosine-${id.slice(0, 8)}`,
    ],
  );
  const probe = vectorLiteral(1024, 0.001);
  const res = await pool.query(
    "SELECT id FROM code_embeddings ORDER BY embedding <=> $1 LIMIT 5",
    [probe],
  );
  assert.ok(res.rowCount !== null && res.rowCount! >= 1, "cosine ORDER BY query must return rows without error");
  await pool.query("DELETE FROM code_embeddings WHERE id = $1", [id]);
});

test("[AC-7] code_embeddings: unique(chunk_id, provider, model) enforced", async () => {
  await assert.rejects(
    pool.query(
      "INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        randomUUID(),
        orgA.orgId,
        orgA.repoId,
        orgA.repositoryRefId,
        shaLike("dup2"),
        orgA.codeChunkId,
        vectorLiteral(1024),
        "voyage",
        "voyage-3", // same (chunk_id, provider, model) as the seeded row
      ],
    ),
    /code_embeddings_chunk_provider_model_unique/,
    "a duplicate (chunk_id, provider, model) must violate the unique constraint",
  );
});

test("[AC-7] hnsw vector_cosine_ops index exists on code_embeddings.embedding", async () => {
  const res = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='code_embeddings' AND indexname='code_embeddings_embedding_cosine_idx'`,
  );
  assert.equal(res.rowCount, 1, "code_embeddings_embedding_cosine_idx missing");
  assert.match(res.rows[0].indexdef, /USING hnsw/i, "index must use the hnsw access method");
  assert.match(res.rows[0].indexdef, /vector_cosine_ops/, "index must use the vector_cosine_ops opclass");
});

// ---------------------------------------------------------------------------
// AC-9: org-delete cascade across all seven new/reshaped tables (+ originals)
// ---------------------------------------------------------------------------

test("[AC-9] deleting an org as admin cascades to all its child rows across all 14 tables", async () => {
  const orgC = await seedOrg(pool, "C");
  const before = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id = $1", [orgC.orgId]);
  assert.equal(before.rows[0].n, 1, "precondition: org C has a seeded user");

  await pool.query("DELETE FROM organizations WHERE id = $1", [orgC.orgId]);

  for (const table of TABLE_NAMES.filter((t) => t !== "organizations")) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgC.orgId]);
    assert.equal(res.rows[0].n, 0, `${table}: org C's rows must be cascade-deleted`);
  }
});

test("[AC-9] org-delete cascade specifically verified for the seven new/reshaped tables", async () => {
  const orgD = await seedOrg(pool, "D");
  await pool.query("DELETE FROM organizations WHERE id = $1", [orgD.orgId]);
  for (const table of NEW_OR_RESHAPED_TABLES) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgD.orgId]);
    assert.equal(res.rows[0].n, 0, `${table}: org D's rows must be cascade-deleted`);
  }
});

// ---------------------------------------------------------------------------
// W0-05 GAP-1: tenant-consistent repository/ref/chunk associations.
// PostgreSQL referential-integrity checks bypass RLS, so every relationship
// that carries org_id must include it in the foreign key itself.
// ---------------------------------------------------------------------------

// @spec AC-1 EC-1
test("[W0-05 GAP-1] repo-scoped base tables reject a foreign-org repository while preserving nullable org-wide scope", async () => {
  const attempts = [
    {
      table: "permissions",
      sql: "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, action) VALUES ($1, $2, 'user', $3, $4, 'read')",
      values: () => [randomUUID(), orgA.orgId, orgA.userId, orgB.repoId],
    },
    {
      table: "ticket_cache",
      sql: "INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id) VALUES ($1, $2, $3, 'jira', $4)",
      values: () => [randomUUID(), orgA.orgId, orgB.repoId, `CROSS-${randomUUID()}`],
    },
    {
      table: "style_rules",
      sql: "INSERT INTO style_rules (id, org_id, repo_id, rule_type, content) VALUES ($1, $2, $3, 'coding_style', 'cross-org')",
      values: () => [randomUUID(), orgA.orgId, orgB.repoId],
    },
    {
      table: "onboarding_steps",
      sql: "INSERT INTO onboarding_steps (id, org_id, repo_id, sequence, title) VALUES ($1, $2, $3, 99, 'cross-org')",
      values: () => [randomUUID(), orgA.orgId, orgB.repoId],
    },
  ] as const;

  for (const attempt of attempts) {
    await assert.rejects(
      pool.query(attempt.sql, attempt.values()),
      new RegExp(`${attempt.table}_org_repository_fk`),
      `${attempt.table} must reject a repository owned by another org`,
    );
  }

  const nullableIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await pool.query(
    "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, action) VALUES ($1, $2, 'user', $3, NULL, 'read')",
    [nullableIds[0], orgA.orgId, orgA.userId],
  );
  await pool.query(
    "INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id) VALUES ($1, $2, NULL, 'jira', $3)",
    [nullableIds[1], orgA.orgId, `ORG-WIDE-${randomUUID()}`],
  );
  await pool.query(
    "INSERT INTO style_rules (id, org_id, repo_id, rule_type, content) VALUES ($1, $2, NULL, 'coding_style', 'org-wide')",
    [nullableIds[2], orgA.orgId],
  );
  await pool.query(
    "INSERT INTO onboarding_steps (id, org_id, repo_id, sequence, title) VALUES ($1, $2, NULL, 100, 'org-wide')",
    [nullableIds[3], orgA.orgId],
  );
  await pool.query("DELETE FROM permissions WHERE id = $1", [nullableIds[0]]);
  await pool.query("DELETE FROM ticket_cache WHERE id = $1", [nullableIds[1]]);
  await pool.query("DELETE FROM style_rules WHERE id = $1", [nullableIds[2]]);
  await pool.query("DELETE FROM onboarding_steps WHERE id = $1", [nullableIds[3]]);
});

// @spec AC-2 EC-3
test("[W0-05 GAP-1] repository ref, chunk, and embedding lineage is tenant- and repository-consistent", async () => {
  await assert.rejects(
    pool.query(
      "INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), orgA.orgId, orgB.repoId, "refs/heads/cross-org", shaLike("cross-org-ref")],
    ),
    /repository_refs_org_repository_fk/,
  );

  await assert.rejects(
    pool.query(
      "INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [randomUUID(), orgA.orgId, orgB.repoId, orgA.repositoryRefId, shaLike("cross-org-chunk"), 5, "cross-org", `hash-${randomUUID()}`],
    ),
    /code_chunks_org_repository_ref_fk/,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO code_embeddings
        (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model, dimension)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, 'w0-05-gap', $8, 1024)`,
      [
        randomUUID(),
        orgA.orgId,
        orgA.repoId,
        orgA.repositoryRefId,
        shaLike("cross-org-embedding"),
        orgB.codeChunkId,
        vectorLiteral(1024),
        `foreign-lineage-${randomUUID()}`,
      ],
    ),
    /code_embeddings_org_repository_ref_chunk_fk/,
  );
});

// @spec AC-3 EC-2 EC-4
test("[W0-05 GAP-1] tenant-consistent constraints are installed without replacing RLS or cascade behavior", async () => {
  const expected = new Set([
    "permissions_org_repository_fk",
    "ticket_cache_org_repository_fk",
    "style_rules_org_repository_fk",
    "onboarding_steps_org_repository_fk",
    "repository_refs_org_repository_fk",
    "code_chunks_org_repository_ref_fk",
    "code_embeddings_org_repository_ref_chunk_fk",
  ]);
  const result = await pool.query<{ conname: string }>(
    `SELECT conname
       FROM pg_constraint
      WHERE conname = ANY($1::text[])
        AND contype = 'f'
        AND confdeltype = 'c'`,
    [[...expected]],
  );
  assert.deepEqual(new Set(result.rows.map((row) => row.conname)), expected);

  for (const table of TABLE_NAMES) {
    const rls = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
      [table],
    );
    assert.equal(rls.rows[0].relrowsecurity, true, `${table}: RLS must remain enabled`);
    assert.equal(rls.rows[0].relforcerowsecurity, true, `${table}: RLS must remain forced`);
  }
});

// ---------------------------------------------------------------------------
// AC-10: withOrgContext (acceptance-suite side, independently re-verified)
// ---------------------------------------------------------------------------

test("[AC-10] withOrgContext returns only org A's rows (0 org B rows) across all 14 tables -- proves the RLS-bypass fix through the real app path", async () => {
  for (const table of TABLE_NAMES) {
    const ownRows = await withOrgContext(db, orgA.orgId, async (tx) => {
      const r = await tx.execute(sql.raw(`select id from ${table}`));
      return (r as unknown as { rows: Array<{ id: string }> }).rows;
    });
    assert.equal(ownRows.length, 1, `${table}: withOrgContext(orgA) should return exactly 1 row`);
    assert.equal(ownRows[0].id, idsA[table]);

    const crossRows = await withOrgContext(db, orgA.orgId, async (tx) => {
      const r = await tx.execute(sql.raw(`select id from ${table} where id = '${idsB[table]}'`));
      return (r as unknown as { rows: Array<{ id: string }> }).rows;
    });
    assert.equal(crossRows.length, 0, `${table}: withOrgContext(orgA) must return ZERO org B rows`);
  }
});

test("[AC-10] withOrgContext rejects a non-UUID orgId before issuing any SQL", async () => {
  for (const bad of ["", "not-a-uuid", "12345", "'; DROP TABLE users; --"]) {
    await assert.rejects(
      withOrgContext(db, bad, async () => {
        throw new Error("fn must NOT run for an invalid orgId");
      }),
      /orgId must be a UUID/,
      `withOrgContext should reject orgId=${JSON.stringify(bad)}`,
    );
  }
});

test("[AC-10] withOrgContext sets app.org_id transaction-locally and resets after commit", async () => {
  const inside = await withOrgContext(db, orgA.orgId, async (tx) => {
    const r = await tx.execute(sql`select current_setting('app.org_id', true) as v`);
    return (r as unknown as { rows: Array<{ v: string }> }).rows[0].v;
  });
  assert.equal(inside, orgA.orgId);

  const afterRes = await db.execute(sql`select nullif(current_setting('app.org_id', true), '') as v`);
  const after = (afterRes as unknown as { rows: Array<{ v: string | null }> }).rows[0].v;
  assert.equal(after, null, "app.org_id must not leak past the transaction");
});

test("[AC-10] back-to-back withOrgContext with different orgs do not bleed context", async () => {
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

test("[AC-10] admin (superuser) connection ignores RLS entirely, even with app.org_id set (the vacuous-pass trap)", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Deliberately NOT `SET LOCAL ROLE sayre_app` -- stays on the superuser role.
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgA.orgId]);
    const res = await client.query("SELECT id FROM organizations");
    assert.equal(
      res.rowCount,
      2,
      "superuser must see both orgs regardless of app.org_id -- documents why the withOrgContext fix is necessary",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Edge: migrate idempotency
// ---------------------------------------------------------------------------

test("[AC-12/edge] running migrate() a second time is a no-op (no duplicate policies/triggers/extension/role)", async () => {
  const p2 = createPool(testDbUrl);
  try {
    await migrate(createDb(p2), { migrationsFolder: "./drizzle" });
  } finally {
    await p2.end();
  }
  const pol = await pool.query(
    `SELECT count(*)::int AS n
       FROM pg_policies
      WHERE schemaname='public'
        AND policyname='org_isolation'
        AND tablename = ANY($1)`,
    [TABLE_NAMES],
  );
  assert.equal(
    pol.rows[0].n,
    TABLE_NAMES.length,
    "expected exactly one org_isolation policy per foundational table",
  );

  const role = await pool.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='sayre_app'");
  assert.equal(role.rows[0].n, 1, "sayre_app role must not be duplicated");

  const ext = await pool.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'");
  assert.equal(ext.rows[0].n, 1, "vector extension must be present exactly once");

  const trig = await pool.query(
    `SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgname = 'same_org_actor' AND tgrelid = 'mcp_client_keys'::regclass AND NOT tgisinternal`,
  );
  assert.equal(trig.rows[0].n, 1, "same_org_actor trigger must not be duplicated");
});

// ---------------------------------------------------------------------------
// Edge: missing resolved database URL
// ---------------------------------------------------------------------------

test("[edge] createPool() fails fast when its resolved database URL is missing", async () => {
  assert.throws(
    () => createPool(undefined),
    /resolved database URL is not set/,
    "createPool() must fail fast, not hang",
  );
  assert.throws(() => createPool(""), /resolved database URL is not set/);
});

// ---------------------------------------------------------------------------
// 0002: updated_at trigger (original tables, still-relevant regression check)
// ---------------------------------------------------------------------------

test("[0002] BEFORE UPDATE trigger overwrites a caller-supplied updated_at on organizations", async () => {
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
  assert.equal(res.rows[0].advanced, true);
  await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
});

// ---------------------------------------------------------------------------
// jsonb round-trip (ticket_cache.payload) -- retained regression check
// ---------------------------------------------------------------------------

test("[regression] ticket_cache.payload jsonb round-trips under a tenant session", async () => {
  await withTenantSession(pool, orgA.orgId, async (c) => {
    const res = await c.query("SELECT payload FROM ticket_cache WHERE id = $1", [orgA.ticketId]);
    assert.equal(res.rowCount, 1);
    assert.deepEqual(res.rows[0].payload, { hello: "A" });
  });
});

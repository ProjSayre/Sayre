// CH-01 red suite (DATABASE-DEPENDENT half) — the assertions that cannot be
// proven with injected fakes because they are statements about PostgreSQL
// itself: the three CHECK constraints added by migration 0020, the org- and
// kind-scoped delete behind `deleteExpired`, the recreated
// `resolve_mcp_client_key(text)`'s privilege/SECURITY DEFINER state, and the
// live `PostgresPermissionStore.getReadScope` intersection for a resolved
// ephemeral credential.
//
// A node:test suite (not vitest), alongside src/db/rls.test.ts and gated the
// same way on `DATABASE_ADMIN_URL`; vitest.config.ts excludes
// `src/db/**/*rls*.test.ts` so the two runners never collide. Run it with:
//
//   node --env-file=../../infra/.env --import tsx --test \
//     src/db/ephemeralMcpCredentials.rls.test.ts
//
// (from services/core; the CI variant drops --env-file, exactly like
// `test:rls:ci`). Like rls.test.ts it creates and migrates its own throwaway
// database (default name `ch01_ephemeral_rls_test`, override via
// CH01_TEST_DB_NAME) rather than assuming ownership of sayre_dev. Both that
// name and DATABASE_ADMIN_URL resolve through the central @sayre/config
// loader -- direct process.env access is barred repo-wide by
// scripts/check-secret-access.mjs.
//
// RED-DEFERRED in the checkout this suite was authored in: that worktree has no
// infra/.env and therefore no DATABASE_ADMIN_URL, so none of these assertions
// could be executed at authoring time. They are recorded, never omitted.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Client, Pool } from "pg";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getConfig, getSecret } from "@sayre/config";
import type { AuthContext } from "../auth/context";
import {
  canReadResource,
  PostgresPermissionStore,
  type ScopedGraphResource,
} from "../graph-query/permissions";
import { createDb, createPool, withOrgContext, type Db } from "./client";
import { PostgresEphemeralMcpCredentialStore } from "./ephemeralMcpCredentialStore";

const TEST_DB_NAME = getConfig("CH01_TEST_DB_NAME");

let pool: Pool;
let db: Db;
let store: PostgresEphemeralMcpCredentialStore;
let permissionStore: PostgresPermissionStore;

interface SeededOrg {
  orgId: string;
  userId: string;
  repoId: string;
  // CH-04 / drizzle/0022_ch04_mcp_key_conversation_fk.sql: mcp_client_keys now carries a
  // composite FK (org_id, conversation_id) -> chat_conversations(org_id, id). A synthetic
  // conversation id with no parent row -- legal when this suite was written under 0019 --
  // is now rejected by that FK before any CHECK constraint is ever reached. Every org
  // therefore seeds one real conversation, and tests that need their own use
  // createConversation() below. No assertion in this file was changed or relaxed.
  conversationId: string;
}

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret("env://DATABASE_ADMIN_URL");
  } catch {
    throw new Error(
      "ephemeralMcpCredentials.rls.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN) -- see infra/.env.example.",
    );
  }
}

function withDatabaseName(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function ensureTestDatabaseExists(adminUrl: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

async function seedOrg(label: string): Promise<SeededOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const repoId = randomUUID();
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [
    orgId,
    `Org ${label}`,
    `org-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  await pool.query(
    "INSERT INTO users (id, org_id, email, name, org_role) VALUES ($1, $2, $3, $4, $5)",
    [userId, orgId, `user-${label}-${userId.slice(0, 8)}@example.com`, `User ${label}`, "member"],
  );
  await pool.query("INSERT INTO repositories (id, org_id, name) VALUES ($1, $2, $3)", [
    repoId,
    orgId,
    `repo-${label}`,
  ]);
  // The issuing user's live scope: allow <repo>/src, deny <repo>/src/secret.
  await pool.query(
    "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, path_prefix, action, effect) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [randomUUID(), orgId, "user", userId, repoId, "src", "read", "allow"],
  );
  await pool.query(
    "INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, path_prefix, action, effect) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [randomUUID(), orgId, "user", userId, repoId, "src/secret", "read", "deny"],
  );
  // CH-04 / 0021: the parent row the composite FK now requires. Seeded per org so
  // baseKeyRow() has a real, org-matched conversation to bind to by default.
  const conversationId = await createConversation(orgId, userId);
  return { orgId, userId, repoId, conversationId };
}

/**
 * CH-04 / 0021: inserts a real `chat_conversations` row and returns its id, so a
 * conversation-bound `mcp_client_keys` row satisfies the composite
 * (org_id, conversation_id) FK. Tests that previously used a bare `randomUUID()` call
 * this instead, preserving their original one-conversation-per-test isolation.
 */
async function createConversation(orgId: string, userId: string): Promise<string> {
  const conversationId = randomUUID();
  await pool.query(
    "INSERT INTO chat_conversations (id, org_id, user_id, title) VALUES ($1, $2, $3, $4)",
    [conversationId, orgId, userId, "Ask Sayre chat session"],
  );
  return conversationId;
}

/** Inserts a `mcp_client_keys` row as the admin (bypasses RLS), returning the DB error message if rejected. */
async function insertKeyRow(values: Record<string, unknown>): Promise<string | null> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_column, index) => `$${index + 1}`);
  try {
    await pool.query(
      `INSERT INTO mcp_client_keys (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
      Object.values(values),
    );
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function baseKeyRow(org: SeededOrg, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  return {
    id,
    org_id: org.orgId,
    name: "Ask Sayre chat session",
    key_prefix: `mcp_chat_${id.replace(/-/g, "").slice(0, 16)}`,
    key_hmac: "a".repeat(64),
    pepper_version: 1,
    created_by: org.userId,
    created_by_label: "User A",
    kind: "chat_ephemeral",
    // CH-04 / 0021: a real, org-matched conversation, so a row that is meant to be
    // rejected is rejected by the CHECK constraint under test rather than by the FK.
    conversation_id: org.conversationId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

const PROBES = (repoId: string): ScopedGraphResource[] => [
  { repoId, refName: "refs/heads/main", path: "src/app/page.tsx" },
  { repoId, refName: "refs/heads/main", path: "src/secret/keys.ts" },
  { repoId, refName: "refs/heads/main", path: "docs/readme.md" },
];

let orgA: SeededOrg;
let orgB: SeededOrg;

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
  store = new PostgresEphemeralMcpCredentialStore({
    getDb: async () => db,
    withOrg: withOrgContext,
  });
  permissionStore = new PostgresPermissionStore(async () => db);
  orgA = await seedOrg("A");
  orgB = await seedOrg("B");
});

after(async () => {
  await pool.query("TRUNCATE organizations CASCADE");
  await pool.end();
});

// @spec EC-20 AC-7
test("0020 CHECK constraints reject every malformed credential shape", async () => {
  const now = new Date();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["chat_ephemeral with NULL conversation_id", { conversation_id: null }],
    ["chat_ephemeral with NULL expires_at", { expires_at: null }],
    [
      "chat_ephemeral with expires_at beyond 600s",
      {
        created_at: now.toISOString(),
        expires_at: new Date(now.valueOf() + 601_000).toISOString(),
      },
    ],
    [
      "chat_ephemeral with expires_at at created_at",
      { created_at: now.toISOString(), expires_at: now.toISOString() },
    ],
    [
      "chat_ephemeral with expires_at before created_at",
      {
        created_at: now.toISOString(),
        expires_at: new Date(now.valueOf() - 1_000).toISOString(),
      },
    ],
    // CH-04 / 0021: a REAL conversation id, so the FK is satisfied and the CHECK that
    // bars kind='agent' from carrying a conversation is what actually rejects this row.
    ["agent row with a conversation_id", { kind: "agent", conversation_id: orgA.conversationId }],
    ["an unknown kind", { kind: "root" }],
  ];

  for (const [label, overrides] of cases) {
    const message = await insertKeyRow(baseKeyRow(orgA, overrides));
    assert.notEqual(message, null, `${label} must be rejected by a CHECK constraint`);
    assert.match(String(message), /violates check constraint/i, label);
  }

  // The two legal shapes are accepted.
  assert.equal(await insertKeyRow(baseKeyRow(orgA)), null, "a 300s ephemeral row is legal");
  assert.equal(
    await insertKeyRow(
      baseKeyRow(orgA, {
        created_at: now.toISOString(),
        expires_at: new Date(now.valueOf() + 600_000).toISOString(),
      }),
    ),
    null,
    "a 600s ephemeral row is legal",
  );
  assert.equal(
    await insertKeyRow(
      baseKeyRow(orgA, { kind: "agent", conversation_id: null, expires_at: null }),
    ),
    null,
    "a non-expiring agent row is still legal",
  );
});

// @spec AC-5 AC-8 EC-24
test("issue writes the key row and its ceiling permissions rows in one org-scoped transaction", async () => {
  // CH-04 / 0021: a real parent conversation, was randomUUID() under 0019.
  const conversationId = await createConversation(orgA.orgId, orgA.userId);
  const issuedAt = new Date();
  const row = await store.issue(orgA.orgId, {
    keyPrefix: `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    keyHmac: "b".repeat(64),
    pepperVersion: 1,
    conversationId,
    issuedAt,
    expiresAt: new Date(issuedAt.valueOf() + 300_000),
    createdBy: orgA.userId,
    createdByLabel: "User A",
    ceiling: {
      allows: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src" }],
      denies: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src/secret" }],
    },
  });

  const keyRows = await pool.query(
    "SELECT kind, conversation_id, org_id FROM mcp_client_keys WHERE key_prefix = $1",
    [row.keyPrefix],
  );
  assert.equal(keyRows.rowCount, 1);
  assert.equal(keyRows.rows[0].kind, "chat_ephemeral");
  assert.equal(keyRows.rows[0].conversation_id, conversationId);
  assert.equal(keyRows.rows[0].org_id, orgA.orgId);

  const ceiling = await pool.query(
    "SELECT effect, path_prefix, action, subject_type FROM permissions WHERE org_id = $1 AND subject_type = 'agent_key' AND subject_id = $2 ORDER BY effect",
    [orgA.orgId, row.keyPrefix],
  );
  assert.equal(ceiling.rowCount, 2);
  assert.deepEqual(
    ceiling.rows.map((entry) => [entry.effect, entry.path_prefix, entry.action]),
    [
      ["allow", "src", "read"],
      ["deny", "src/secret", "read"],
    ],
  );

  // Another tenant's audit read never sees it, even for the same conversation id.
  assert.deepEqual(await store.listByConversation(orgB.orgId, conversationId, null), []);
  const mine = await store.listByConversation(orgA.orgId, conversationId, orgA.userId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.keyPrefix, row.keyPrefix);
  // A different member of the same org sees none of them.
  assert.deepEqual(await store.listByConversation(orgA.orgId, conversationId, randomUUID()), []);
});

// @spec AC-2 EC-14
test("a resolved ephemeral credential reads exactly what its issuer currently reads", async () => {
  // CH-04 / 0021: a real parent conversation, was randomUUID() under 0019.
  const conversationId = await createConversation(orgA.orgId, orgA.userId);
  const issuedAt = new Date();
  const keyPrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await store.issue(orgA.orgId, {
    keyPrefix,
    keyHmac: "c".repeat(64),
    pepperVersion: 1,
    conversationId,
    issuedAt,
    expiresAt: new Date(issuedAt.valueOf() + 300_000),
    createdBy: orgA.userId,
    createdByLabel: "User A",
    ceiling: {
      allows: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src" }],
      denies: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src/secret" }],
    },
  });

  const userCtx: AuthContext = {
    subjectType: "user",
    userId: orgA.userId,
    orgId: orgA.orgId,
    roles: ["member"],
  };
  const keyCtx: AuthContext = {
    subjectType: "agent_key",
    agentKeyId: keyPrefix,
    orgId: orgA.orgId,
    roles: ["member"],
  };

  const issuerScope = await permissionStore.getReadScope(userCtx);
  const keyScope = await permissionStore.getReadScope(keyCtx);
  // Coverage equality, never array equality: intersectReadScopes(S, S) may
  // return more rules than S, each a subset of one already in S.
  assert.deepEqual(
    PROBES(orgA.repoId).map((probe) => canReadResource(keyScope, probe)),
    PROBES(orgA.repoId).map((probe) => canReadResource(issuerScope, probe)),
  );
  assert.deepEqual(
    PROBES(orgA.repoId).map((probe) => canReadResource(issuerScope, probe)),
    [true, false, false],
  );

  // EC-14: narrowing the issuer narrows the credential on the very next read.
  await pool.query(
    "UPDATE permissions SET path_prefix = $1 WHERE org_id = $2 AND subject_type = 'user' AND subject_id = $3 AND effect = 'allow'",
    ["src/app", orgA.orgId, orgA.userId],
  );
  const narrowed = await permissionStore.getReadScope(keyCtx);
  assert.equal(
    canReadResource(narrowed, {
      repoId: orgA.repoId,
      refName: "refs/heads/main",
      path: "src/other/thing.ts",
    }),
    false,
  );
  await pool.query(
    "UPDATE permissions SET path_prefix = $1 WHERE org_id = $2 AND subject_type = 'user' AND subject_id = $3 AND effect = 'allow'",
    ["src", orgA.orgId, orgA.userId],
  );
});

// @spec EC-15
test("a ceiling row widened directly in the database grants nothing extra", async () => {
  // CH-04 / 0021: a real parent conversation, was randomUUID() under 0019.
  const conversationId = await createConversation(orgA.orgId, orgA.userId);
  const issuedAt = new Date();
  const keyPrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await store.issue(orgA.orgId, {
    keyPrefix,
    keyHmac: "d".repeat(64),
    pepperVersion: 1,
    conversationId,
    issuedAt,
    expiresAt: new Date(issuedAt.valueOf() + 300_000),
    createdBy: orgA.userId,
    createdByLabel: "User A",
    ceiling: { allows: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src" }], denies: [] },
  });
  await pool.query(
    "UPDATE permissions SET repo_id = NULL, path_prefix = NULL WHERE org_id = $1 AND subject_type = 'agent_key' AND subject_id = $2",
    [orgA.orgId, keyPrefix],
  );

  const keyScope = await permissionStore.getReadScope({
    subjectType: "agent_key",
    agentKeyId: keyPrefix,
    orgId: orgA.orgId,
    roles: ["member"],
  });
  assert.deepEqual(
    PROBES(orgA.repoId).map((probe) => canReadResource(keyScope, probe)),
    [true, false, false],
  );
  assert.equal(
    canReadResource(keyScope, {
      repoId: orgB.repoId,
      refName: "refs/heads/main",
      path: "src/app/page.tsx",
    }),
    false,
  );
});

// @spec EC-8
test("deleting the issuing user nulls created_by and empties the credential scope", async () => {
  const victim = await seedOrg("C");
  // CH-04 / 0021: this credential must stay conversation-bound (so the composite FK path
  // is exercised), but its conversation is deliberately owned by a DIFFERENT member of the
  // same org. 0020's chat_conversations_org_user_fk is ON DELETE cascade, so a conversation
  // owned by the issuer would be deleted along with them and 0021's FK would then cascade
  // the key row away too -- leaving nothing to assert created_by on. That combined cascade
  // is real and intended (it is exactly the deletion route 0021's delete_ephemeral_ceiling
  // trigger exists to clean up after); it is simply not what EC-8 measures. Separating the
  // conversation's owner from the credential's issuer isolates the one variable this test is
  // about. Every assertion below is unchanged.
  const bystanderId = randomUUID();
  await pool.query(
    "INSERT INTO users (id, org_id, email, name, org_role) VALUES ($1, $2, $3, $4, $5)",
    [bystanderId, victim.orgId, `bystander-${bystanderId.slice(0, 8)}@example.com`, "User C2", "member"],
  );
  const issuedAt = new Date();
  const keyPrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await store.issue(victim.orgId, {
    keyPrefix,
    keyHmac: "e".repeat(64),
    pepperVersion: 1,
    conversationId: await createConversation(victim.orgId, bystanderId),
    issuedAt,
    expiresAt: new Date(issuedAt.valueOf() + 300_000),
    createdBy: victim.userId,
    createdByLabel: "User C",
    ceiling: { allows: [{ repoId: victim.repoId, branch: null, pathPrefix: "src" }], denies: [] },
  });

  // The CHECK deliberately does not require created_by, so this must succeed.
  await pool.query("DELETE FROM users WHERE id = $1", [victim.userId]);
  const row = await pool.query(
    "SELECT created_by, created_by_label FROM mcp_client_keys WHERE key_prefix = $1",
    [keyPrefix],
  );
  assert.equal(row.rows[0].created_by, null);
  assert.equal(row.rows[0].created_by_label, "User C");

  const scope = await permissionStore.getReadScope({
    subjectType: "agent_key",
    agentKeyId: keyPrefix,
    orgId: victim.orgId,
    roles: ["member"],
  });
  assert.deepEqual(scope, { allows: [], denies: [] });
});

// @spec EC-21 AC-12
test("deleteExpired removes only this org's expired ephemeral rows and their ceilings", async () => {
  // CH-04 / 0021: this test used ONE randomUUID() conversation id for both orgA's and
  // orgB's rows. A conversation id is globally unique to exactly one org, so under the
  // composite (org_id, conversation_id) FK a single id cannot be shared across tenants.
  // Each org now gets its own real conversation. What this test measures -- that
  // deleteExpired is scoped by ORG, not by conversation -- is unchanged, and the
  // cross-tenant assertion below is if anything stricter for using distinct parents.
  const conversationId = await createConversation(orgA.orgId, orgA.userId);
  const otherOrgConversationId = await createConversation(orgB.orgId, orgB.userId);
  const past = new Date(Date.now() - 10 * 60_000);
  const expiredPrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const livePrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const otherOrgPrefix = `mcp_chat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const expiredAgentPrefix = `mcp_live_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  await store.issue(orgA.orgId, {
    keyPrefix: expiredPrefix,
    keyHmac: "1".repeat(64),
    pepperVersion: 1,
    conversationId,
    issuedAt: past,
    expiresAt: new Date(past.valueOf() + 300_000),
    createdBy: orgA.userId,
    createdByLabel: "User A",
    ceiling: { allows: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src" }], denies: [] },
  });
  const now = new Date();
  await store.issue(orgA.orgId, {
    keyPrefix: livePrefix,
    keyHmac: "2".repeat(64),
    pepperVersion: 1,
    conversationId,
    issuedAt: now,
    expiresAt: new Date(now.valueOf() + 300_000),
    createdBy: orgA.userId,
    createdByLabel: "User A",
    ceiling: { allows: [{ repoId: orgA.repoId, branch: null, pathPrefix: "src" }], denies: [] },
  });
  await store.issue(orgB.orgId, {
    keyPrefix: otherOrgPrefix,
    keyHmac: "3".repeat(64),
    pepperVersion: 1,
    conversationId: otherOrgConversationId,
    issuedAt: past,
    expiresAt: new Date(past.valueOf() + 300_000),
    createdBy: orgB.userId,
    createdByLabel: "User B",
    ceiling: { allows: [{ repoId: orgB.repoId, branch: null, pathPrefix: "src" }], denies: [] },
  });
  await insertKeyRow(
    baseKeyRow(orgA, {
      kind: "agent",
      conversation_id: null,
      key_prefix: expiredAgentPrefix,
      created_at: past.toISOString(),
      expires_at: new Date(past.valueOf() + 60_000).toISOString(),
    }),
  );

  const deleted = await store.deleteExpired(orgA.orgId, new Date(), 1_000);
  assert.equal(deleted, 1);

  const remaining = await pool.query(
    "SELECT key_prefix FROM mcp_client_keys WHERE key_prefix = ANY($1) ORDER BY key_prefix",
    [[expiredPrefix, livePrefix, otherOrgPrefix, expiredAgentPrefix]],
  );
  assert.deepEqual(
    remaining.rows.map((entry) => entry.key_prefix).sort(),
    [livePrefix, otherOrgPrefix, expiredAgentPrefix].sort(),
  );

  const orphans = await pool.query(
    "SELECT id FROM permissions WHERE subject_type = 'agent_key' AND subject_id = $1",
    [expiredPrefix],
  );
  assert.equal(orphans.rowCount, 0, "the deleted credential's ceiling rows must go with it");
  const keptCeiling = await pool.query(
    "SELECT id FROM permissions WHERE subject_type = 'agent_key' AND subject_id = $1",
    [otherOrgPrefix],
  );
  assert.equal(keptCeiling.rowCount, 1, "another org's ceiling rows are untouched");
});

// @spec EC-23
test("the recreated resolve_mcp_client_key stays SECURITY DEFINER and off PUBLIC", async () => {
  const { rows } = await pool.query(
    `SELECT p.prosecdef, p.proconfig,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute,
            has_function_privilege('sayre_app', p.oid, 'EXECUTE') AS app_can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'resolve_mcp_client_key' AND n.nspname = 'public'`,
  );
  assert.equal(rows.length, 1, "exactly one resolver function must exist after the DROP/CREATE");
  assert.equal(rows[0].prosecdef, true);
  assert.deepEqual(rows[0].proconfig, ["search_path=public, pg_temp"]);
  assert.equal(rows[0].public_can_execute, false);
  assert.equal(rows[0].app_can_execute, true);

  // It now returns the two discriminator columns for both families.
  const row = baseKeyRow(orgA);
  assert.equal(await insertKeyRow(row), null);
  const resolved = await pool.query("SELECT * FROM resolve_mcp_client_key($1)", [
    row.key_prefix,
  ]);
  assert.equal(resolved.rowCount, 1);
  assert.equal(resolved.rows[0].kind, "chat_ephemeral");
  assert.equal(resolved.rows[0].conversation_id, row.conversation_id);
});

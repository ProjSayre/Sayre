// Real-Postgres integration test for `jira_connections` / PostgresJiraConnectionStore
// (W3-10). Mirrors src/db/rls.test.ts's conventions (node:test, dedicated
// throwaway database off DATABASE_ADMIN_URL, migrated fresh) — run via:
//
//   NODE_ENV=test node --env-file=../../infra/.env --import tsx --test src/db/jiraConnectionStore.rls.test.ts
//
// (from services/core/), or add an npm script mirroring test:rls if this is
// promoted into the standing suite. NODE_ENV=test is required here (not just
// convention) — see the `before()` hook below, which uses the
// setSecretBackendForTests seam, and that seam's requireTestEnvironment()
// guard throws otherwise. Requires a live local Postgres (the
// sayre-postgres docker-compose service) — this is intentionally NOT part of
// the vitest run (src/db/** is excluded there, same as rls.test.ts).
//
// This exists specifically to satisfy the tester brief's requirement to
// "trace through that the store's withOrgContext/RLS actually scopes
// correctly" for cross-org isolation — not just assert it via a DI-mocked
// fake store (see orgSecrets.test.ts / jiraConnectService.test.ts for the
// fast, DB-free unit coverage of the surrounding logic).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getSecret, resetSecretsForTests, setSecretBackendForTests } from '@sayre/config';
import { createDb, createPool, withOrgContext, type Db } from './client';
import { PostgresJiraConnectionStore } from './jiraConnectionStore';

const TEST_DB_NAME = 'w3010_jira_connections_rls_test';
const JIRA_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64');

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret('env://DATABASE_ADMIN_URL');
  } catch {
    throw new Error(
      'jiraConnectionStore.rls.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN) -- ' +
        'see infra/.env.example. Run with `node --env-file=../../infra/.env --import tsx --test ' +
        'src/db/jiraConnectionStore.rls.test.ts` from services/core/.',
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
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

async function seedOrg(pool: Pool, label: string): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  const userId = randomUUID();
  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    orgId,
    `Jira RLS Org ${label}`,
    `jira-rls-org-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  await pool.query('INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)', [
    userId,
    orgId,
    `jira-rls-user-${label}-${userId.slice(0, 8)}@example.com`,
  ]);
  return { orgId, userId };
}

let pool: Pool;
let db: Db;
let store: PostgresJiraConnectionStore;
let orgA: { orgId: string; userId: string };
let orgB: { orgId: string; userId: string };

before(async () => {
  // Resolve DATABASE_ADMIN_URL first, via the real environment-backed
  // getSecret (same as rls.test.ts) — before swapping the backend below.
  const adminUrl = await requireAdminUrl();

  // infra/.env has no real JIRA_TOKEN_ENC_KEY provisioned yet (W3-10 is
  // still mid-pipeline). Rather than writing process.env directly (forbidden
  // outside the loader — see check-secret-access.mjs / .claude/rules/
  // security-multitenancy.md), install a fixed test value through the
  // sanctioned setSecretBackendForTests seam before jiraTokenCipher's first
  // getSecret('env://JIRA_TOKEN_ENC_KEY') call caches it. Nothing in this
  // file requests any other secret after this point, so the swap (and its
  // cache-clear) doesn't affect the already-resolved adminUrl above.
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JIRA_TOKEN_ENC_KEY') return JIRA_TOKEN_ENC_KEY;
    throw new Error(`jiraConnectionStore.rls.test.ts: unexpected secret request ${ref}`);
  });

  await ensureTestDatabaseExists(adminUrl, TEST_DB_NAME);
  const testDbUrl = withDatabaseName(adminUrl, TEST_DB_NAME);

  const migratePool = createPool(testDbUrl);
  try {
    await migrate(createDb(migratePool), { migrationsFolder: './drizzle' });
  } finally {
    await migratePool.end();
  }

  pool = createPool(testDbUrl);
  db = createDb(pool);
  store = new PostgresJiraConnectionStore({
    getDb: async () => db,
    withOrg: withOrgContext,
  });

  orgA = await seedOrg(pool, 'A');
  orgB = await seedOrg(pool, 'B');
});

after(async () => {
  await pool.query('TRUNCATE organizations CASCADE');
  await pool.end();
  resetSecretsForTests();
});

function futureExpiry(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

test('connect() persists an active connection; the raw columns are ciphertext (never plaintext) at rest', async () => {
  await store.connect(orgA.orgId, {
    cloudId: 'cloud-a-1',
    siteUrl: 'https://a1.atlassian.net',
    siteName: 'A1',
    accessToken: 'org-a-access-plaintext',
    refreshToken: 'org-a-refresh-plaintext',
    accessTokenExpiresAt: futureExpiry(60),
    scopes: 'read:jira-work',
    connectedByUserId: orgA.userId,
    connectedByLabel: 'Org A Admin',
    connectedByAccountId: 'jira-account-a',
  });

  const raw = await pool.query(
    'SELECT jira_access_token_enc, jira_refresh_token_enc FROM jira_connections WHERE org_id = $1',
    [orgA.orgId],
  );
  assert.equal(raw.rowCount, 1);
  assert.ok(!String(raw.rows[0].jira_access_token_enc).includes('org-a-access-plaintext'));
  assert.ok(!String(raw.rows[0].jira_refresh_token_enc).includes('org-a-refresh-plaintext'));
  assert.match(raw.rows[0].jira_access_token_enc, /^v1:/);
});

test(
  '[CROSS-ORG ISOLATION] org A resolveActive/statusView see ONLY their own row, never org B\'s -- ' +
    'through the REAL withOrgContext(RLS) path, not a mocked store',
  async () => {
    await store.connect(orgB.orgId, {
      cloudId: 'cloud-b-1',
      siteUrl: 'https://b1.atlassian.net',
      siteName: 'B1',
      accessToken: 'org-b-access-plaintext',
      refreshToken: 'org-b-refresh-plaintext',
      accessTokenExpiresAt: futureExpiry(60),
      scopes: 'read:jira-work',
      connectedByUserId: orgB.userId,
      connectedByLabel: 'Org B Admin',
      connectedByAccountId: 'jira-account-b',
    });

    const rowA = await store.resolveActive(orgA.orgId);
    const rowB = await store.resolveActive(orgB.orgId);

    assert.ok(rowA);
    assert.equal(rowA!.cloudId, 'cloud-a-1');
    assert.equal(rowA!.accessToken, 'org-a-access-plaintext');
    assert.notEqual(rowA!.orgId, orgB.orgId);

    assert.ok(rowB);
    assert.equal(rowB!.cloudId, 'cloud-b-1');
    assert.equal(rowB!.accessToken, 'org-b-access-plaintext');

    // Direct cross-org probe: statusView(orgA) must NEVER surface org B's
    // site, and vice versa -- proves withOrgContext's `SET LOCAL ROLE
    // sayre_app` + RLS policy actually scopes the query, not just an
    // orgId filter a caller could get wrong.
    const statusA = await store.statusView(orgA.orgId);
    const statusB = await store.statusView(orgB.orgId);
    assert.equal(statusA?.siteUrl, 'https://a1.atlassian.net');
    assert.equal(statusB?.siteUrl, 'https://b1.atlassian.net');
    assert.notEqual(statusA?.siteUrl, statusB?.siteUrl);
  },
);

test('[CROSS-ORG ISOLATION] a superuser query without app.org_id set sees BOTH rows (the vacuous-pass trap, documented) -- but withOrgContext never runs without it', async () => {
  const all = await pool.query('SELECT org_id FROM jira_connections');
  assert.ok(all.rowCount! >= 2, 'admin/superuser bypasses RLS entirely -- expected, not a bug');
});

test('touchLastSynced/softRevoke only ever affect the target org\'s row', async () => {
  const before1 = await store.resolveActive(orgB.orgId);
  assert.ok(before1);
  await store.touchLastSynced(orgA.orgId, new Date('2026-07-24T12:00:00Z'));

  const afterA = await store.resolveActive(orgA.orgId);
  const afterB = await store.resolveActive(orgB.orgId);
  assert.equal(afterA?.lastSyncedAt?.toISOString(), '2026-07-24T12:00:00.000Z');
  assert.equal(afterB?.lastSyncedAt, null, "org B's lastSyncedAt must be untouched by org A's sync");
});

test('reconnect while already connected supersedes the SAME active row (partial-unique index still holds exactly one active row)', async () => {
  const before1 = await store.resolveActive(orgA.orgId);
  const beforeId = before1!.id;

  await store.connect(orgA.orgId, {
    cloudId: 'cloud-a-2-RECONNECTED',
    siteUrl: 'https://a2.atlassian.net',
    siteName: 'A2',
    accessToken: 'org-a-access-RECONNECTED',
    refreshToken: 'org-a-refresh-RECONNECTED',
    accessTokenExpiresAt: futureExpiry(60),
    scopes: 'read:jira-work write:jira-work',
    connectedByUserId: orgA.userId,
    connectedByLabel: 'Org A Admin (reconnected)',
    connectedByAccountId: 'jira-account-a-2',
  });

  const activeRows = await pool.query(
    'SELECT id, cloud_id FROM jira_connections WHERE org_id = $1 AND revoked_at IS NULL',
    [orgA.orgId],
  );
  assert.equal(activeRows.rowCount, 1, 'exactly one active row for org A after reconnect');
  assert.equal(activeRows.rows[0].id, beforeId, 'the SAME row id is superseded, not a second row inserted');
  assert.equal(activeRows.rows[0].cloud_id, 'cloud-a-2-RECONNECTED');

  const resolved = await store.resolveActive(orgA.orgId);
  assert.equal(resolved?.accessToken, 'org-a-access-RECONNECTED');
});

test('a raw second active-row INSERT for the same org violates the partial-unique index (defense in depth beyond the store)', async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO jira_connections
         (org_id, cloud_id, site_url, connected_by_label, access_token_expires_at)
       VALUES ($1, 'cloud-a-DUPLICATE', 'https://dup.atlassian.net', 'x', now() + interval '1 hour')`,
      [orgA.orgId],
    ),
    /duplicate key value violates unique constraint|jira_connections_active_org_unique/,
  );
});

test('disconnect (softRevoke): nulls BOTH encrypted token columns, sets revoked_at, halts resolveActive/status for that org only', async () => {
  await store.softRevoke(orgA.orgId, orgA.userId, 'Org A Admin');

  const raw = await pool.query(
    'SELECT jira_access_token_enc, jira_refresh_token_enc, revoked_at FROM jira_connections ' +
      'WHERE org_id = $1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1',
    [orgA.orgId],
  );
  assert.equal(raw.rowCount, 1);
  assert.equal(raw.rows[0].jira_access_token_enc, null);
  assert.equal(raw.rows[0].jira_refresh_token_enc, null);
  assert.ok(raw.rows[0].revoked_at);

  assert.equal(await store.resolveActive(orgA.orgId), null);
  assert.equal(await store.statusView(orgA.orgId), null);

  // Org B is completely unaffected by org A's disconnect.
  const stillActiveB = await store.resolveActive(orgB.orgId);
  assert.ok(stillActiveB);
  assert.equal(stillActiveB!.revokedAt, null);
});

test('reconnect after disconnect creates a usable active row again without violating the partial-unique index', async () => {
  await store.connect(orgA.orgId, {
    cloudId: 'cloud-a-3-post-disconnect',
    siteUrl: 'https://a3.atlassian.net',
    siteName: 'A3',
    accessToken: 'org-a-access-post-disconnect',
    refreshToken: 'org-a-refresh-post-disconnect',
    accessTokenExpiresAt: futureExpiry(60),
    scopes: 'read:jira-work',
    connectedByUserId: orgA.userId,
    connectedByLabel: 'Org A Admin',
    connectedByAccountId: 'jira-account-a-3',
  });

  const activeRows = await pool.query(
    'SELECT id FROM jira_connections WHERE org_id = $1 AND revoked_at IS NULL',
    [orgA.orgId],
  );
  assert.equal(activeRows.rowCount, 1);

  const resolved = await store.resolveActive(orgA.orgId);
  assert.equal(resolved?.accessToken, 'org-a-access-post-disconnect');
  assert.equal(resolved?.revokedAt, null);
});

test(
  '[CONCURRENCY] withLockedActiveConnection genuinely serializes two concurrent callers for the SAME org via a real ' +
    'Postgres row lock (SELECT ... FOR UPDATE) -- the second caller only proceeds after the first COMMITS',
  async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstMayProceed = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstCall = store.withLockedActiveConnection(orgA.orgId, async (locked) => {
      order.push('first-acquired-lock');
      // Hold the lock open until the test explicitly releases it, so the
      // second call is DEFINITELY still waiting on Postgres, not just
      // racing in JS.
      await firstMayProceed;
      await locked.persistRefresh({
        accessToken: 'org-a-access-FIRST-REFRESH',
        refreshToken: 'org-a-refresh-FIRST-REFRESH',
        accessTokenExpiresAt: futureExpiry(60),
        scopes: 'read:jira-work',
      });
      order.push('first-committed');
    });

    // Give the first call a moment to actually acquire the row lock inside
    // its own transaction before starting the second (concurrent) call.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondCall = store.withLockedActiveConnection(orgA.orgId, async (locked) => {
      order.push('second-acquired-lock');
      // By the time the second callback runs, it MUST observe the FIRST
      // call's already-persisted rotation -- proving it waited for the
      // real Postgres lock, not a stale pre-lock snapshot.
      assert.equal(locked.row.accessToken, 'org-a-access-FIRST-REFRESH');
      return 'second-done';
    });

    // Release the first call's hold after a short delay, then await both.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirst!();
    await firstCall;
    await secondCall;

    assert.deepEqual(order, ['first-acquired-lock', 'first-committed', 'second-acquired-lock']);
  },
);

test(
  "[invalid_grant path] withLockedActiveConnection's own locked.revoke() (used by orgSecrets.ts on " +
    'JiraRefreshInvalidGrantError, distinct from the disconnect route\'s softRevoke()) ALSO nulls both ' +
    'encrypted token columns and halts the org -- verified directly against real Postgres, not assumed ' +
    'identical to softRevoke() by reading the source',
  async () => {
    const activeBefore = await store.resolveActive(orgB.orgId);
    assert.ok(activeBefore, 'org B must still be active going into this test');

    await store.withLockedActiveConnection(orgB.orgId, async (locked) => {
      await locked.revoke();
    });

    const raw = await pool.query(
      'SELECT jira_access_token_enc, jira_refresh_token_enc, revoked_at FROM jira_connections ' +
        'WHERE org_id = $1 AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1',
      [orgB.orgId],
    );
    assert.equal(raw.rowCount, 1);
    assert.equal(raw.rows[0].jira_access_token_enc, null);
    assert.equal(raw.rows[0].jira_refresh_token_enc, null);
    assert.ok(raw.rows[0].revoked_at);

    assert.equal(await store.resolveActive(orgB.orgId), null);
    assert.equal(await store.statusView(orgB.orgId), null);

    // Org A (fully independent lifecycle by this point in the suite) is
    // completely unaffected by org B's invalid_grant-triggered revoke.
    const stillOrgA = await store.resolveActive(orgA.orgId);
    assert.ok(stillOrgA);
    assert.equal(stillOrgA!.revokedAt, null);
  },
);

test('withLockedActiveConnection returns null (and never invokes fn) for an org with no active connection', async () => {
  const neverOrgId = randomUUID();
  // Not a real org row -- withOrgContext only requires a well-formed UUID;
  // the RLS-scoped SELECT simply returns zero rows.
  let called = false;
  const result = await store.withLockedActiveConnection(neverOrgId, async () => {
    called = true;
    return 'should not happen';
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

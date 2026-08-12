// CH-03 — real-Postgres integration test for `chat_conversations` / `chat_turns`
// and PostgresChatStore. Mirrors src/db/jiraConnectionStore.rls.test.ts's
// conventions (node:test, dedicated throwaway database off DATABASE_ADMIN_URL,
// migrated fresh) — run via:
//
//   NODE_ENV=test node --env-file=../../infra/.env --import tsx --test src/db/chatStore.rls.test.ts
//
// (from services/core/), or through the `test:rls:chat` / `test:rls:chat:ci`
// scripts. Requires a live local Postgres (the sayre-postgres docker-compose
// service). Intentionally NOT part of the vitest run — the existing
// `src/db/**/*rls*.test.ts` exclusion in vitest.config.ts keeps the two runners
// from colliding.
//
// This file owns the half of CH-03's acceptance criteria that only a real
// database can measure: RLS actually filtering another org's conversation, the
// composite FK actually rejecting a cross-org turn, `pg_advisory_xact_lock`
// actually serializing concurrent posts, and the SQL that windows history to
// the newest completed turns. The DI-mocked, fast coverage of the surrounding
// service logic lives in src/services/chatService.test.ts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getSecret, resetSecretsForTests } from '@sayre/config';
import { createDb, createPool, withOrgContext, type Db } from './client';
import { chatConversationLockKey, PostgresChatStore } from './chatStore';

const TEST_DB_NAME = 'ch03_chat_rls_test';
const HISTORY_LIMIT = 12;
const TURNS_LIMIT = 200;

async function requireAdminUrl(): Promise<string> {
  try {
    return await getSecret('env://DATABASE_ADMIN_URL');
  } catch {
    throw new Error(
      'chatStore.rls.test.ts requires DATABASE_ADMIN_URL (admin/superuser DSN) -- ' +
        'see infra/.env.example. Run with `node --env-file=../../infra/.env --import tsx --test ' +
        'src/db/chatStore.rls.test.ts` from services/core/.',
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
    if (rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

async function seedOrg(
  pool: Pool,
  label: string,
): Promise<{ orgId: string; primaryUserId: string; secondUserId: string }> {
  const orgId = randomUUID();
  const primaryUserId = randomUUID();
  const secondUserId = randomUUID();
  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    orgId,
    `Chat RLS Org ${label}`,
    `chat-rls-org-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  for (const [userId, suffix] of [
    [primaryUserId, 'primary'],
    [secondUserId, 'second'],
  ] as const) {
    await pool.query('INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)', [
      userId,
      orgId,
      `chat-rls-${label}-${suffix}-${userId.slice(0, 8)}@example.com`,
    ]);
  }
  return { orgId, primaryUserId, secondUserId };
}

let pool: Pool;
let db: Db;
let store: PostgresChatStore;
let orgA: { orgId: string; primaryUserId: string; secondUserId: string };
let orgB: { orgId: string; primaryUserId: string; secondUserId: string };

before(async () => {
  const adminUrl = await requireAdminUrl();
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
  store = new PostgresChatStore({ getDb: async () => db, withOrg: withOrgContext });

  orgA = await seedOrg(pool, 'A');
  orgB = await seedOrg(pool, 'B');
});

after(async () => {
  await pool.query('TRUNCATE organizations CASCADE');
  await pool.end();
  resetSecretsForTests();
});

function ownerA() {
  return { orgId: orgA.orgId, userId: orgA.primaryUserId };
}

async function newConversation(title: string | null = 'Auth spelunking') {
  return store.createConversation(ownerA(), title);
}

// @spec AC-1
test('appendTurnPair writes exactly two rows — a completed user turn and its pending assistant turn — in one transaction', async () => {
  const conversation = await newConversation();
  const result = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'client-turn-0001',
    question: 'How does login work?',
    scope: { view: 'technical', anchorNodeId: 'file-42' },
    historyLimit: HISTORY_LIMIT,
  });

  assert.ok(result);
  assert.equal(result!.created, true);

  const rows = await pool.query(
    'SELECT id, seq, role, content, status, idempotency_key, request_turn_id, dispatched_at ' +
      'FROM chat_turns WHERE conversation_id = $1 ORDER BY seq',
    [conversation.id],
  );
  assert.equal(rows.rowCount, 2);
  assert.equal(rows.rows[0].role, 'user');
  assert.equal(rows.rows[0].status, 'completed');
  assert.equal(rows.rows[0].content, 'How does login work?');
  assert.equal(rows.rows[0].idempotency_key, 'client-turn-0001');
  assert.equal(rows.rows[0].request_turn_id, null);
  assert.equal(rows.rows[0].dispatched_at, null);

  assert.equal(rows.rows[1].role, 'assistant');
  assert.equal(rows.rows[1].status, 'pending');
  assert.equal(rows.rows[1].content, '');
  assert.equal(rows.rows[1].idempotency_key, null);
  assert.equal(rows.rows[1].request_turn_id, rows.rows[0].id);
  assert.equal(Number(rows.rows[1].seq), Number(rows.rows[0].seq) + 1);
});

// @spec AC-2 AC-3
test('a retry with the same idempotency key returns the same pair, inserts nothing, and reports dispatch state', async () => {
  const conversation = await newConversation();
  const first = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'client-turn-retry',
    question: 'How does login work?',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(first);

  // Publish failed on the first attempt: dispatched_at is still null, so the
  // retry is expected to re-publish (the service's job) against the SAME ids.
  const undispatchedRetry = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'client-turn-retry',
    question: 'How does login work?',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(undispatchedRetry);
  assert.equal(undispatchedRetry!.created, false);
  assert.equal(undispatchedRetry!.userTurn.id, first!.userTurn.id);
  assert.equal(undispatchedRetry!.assistantTurn.id, first!.assistantTurn.id);
  assert.equal(undispatchedRetry!.assistantTurn.dispatchedAt, null);

  await store.markTurnDispatched(ownerA(), first!.assistantTurn.id);

  const dispatchedRetry = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'client-turn-retry',
    question: 'How does login work?',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(dispatchedRetry);
  assert.equal(dispatchedRetry!.created, false);
  assert.notEqual(dispatchedRetry!.assistantTurn.dispatchedAt, null);

  const rows = await pool.query('SELECT id FROM chat_turns WHERE conversation_id = $1', [
    conversation.id,
  ]);
  assert.equal(rows.rowCount, 2, 'a retry never inserts a third row');
});

// @spec AC-4 EC-8
test('[OWNER-ONLY] a second user in the SAME org cannot read, list, or post to another user’s conversation', async () => {
  const conversation = await newConversation();
  const intruder = { orgId: orgA.orgId, userId: orgA.secondUserId };

  assert.equal(await store.getConversation(intruder, conversation.id, TURNS_LIMIT), null);
  assert.equal(
    await store.appendTurnPair({
      owner: intruder,
      conversationId: conversation.id,
      idempotencyKey: 'intruder-turn-0001',
      question: 'Whose conversation is this?',
      scope: { view: null, anchorNodeId: null },
      historyLimit: HISTORY_LIMIT,
    }),
    null,
  );

  const listed = await store.listConversations(intruder, 50);
  assert.ok(!listed.some((item) => item.id === conversation.id));
  assert.ok(
    (await store.listConversations(ownerA(), 50)).some((item) => item.id === conversation.id),
  );
});

// @spec AC-5 EC-7
test('[CROSS-ORG ISOLATION] org B never sees org A’s conversation through the REAL withOrgContext(RLS) path', async () => {
  const conversation = await newConversation();
  const otherOrgOwner = { orgId: orgB.orgId, userId: orgB.primaryUserId };

  assert.equal(await store.getConversation(otherOrgOwner, conversation.id, TURNS_LIMIT), null);
  assert.equal(
    await store.appendTurnPair({
      owner: otherOrgOwner,
      conversationId: conversation.id,
      idempotencyKey: 'cross-org-turn-0001',
      question: 'Can I see this?',
      scope: { view: null, anchorNodeId: null },
      historyLimit: HISTORY_LIMIT,
    }),
    null,
  );
  assert.ok(!(await store.listConversations(otherOrgOwner, 50)).some((i) => i.id === conversation.id));

  // Prove it is RLS doing the filtering, not just a WHERE clause the store owns.
  const visible = await withOrgContext(db, orgB.orgId, async (tx) =>
    tx.execute('select count(*)::int as n from chat_conversations'),
  );
  const rows = (visible as unknown as { rows?: Array<{ n: number }> }).rows ?? [];
  assert.equal(rows[0]?.n ?? 0, 0, 'org B sees zero of org A’s conversations under RLS');
});

// @spec EC-20
test('a raw chat_turns insert naming a conversation from another org is rejected by the composite FK', async () => {
  const conversation = await newConversation();
  await assert.rejects(
    pool.query(
      `INSERT INTO chat_turns (org_id, conversation_id, seq, role, content, status, idempotency_key)
         VALUES ($1, $2, 99, 'user', 'cross-tenant', 'completed', 'cross-tenant-0001')`,
      [orgB.orgId, conversation.id],
    ),
    /violates foreign key constraint|chat_turns_org_conversation_fk/,
  );
});

// @spec EC-9
test('[CONCURRENCY] two racing posts with the SAME idempotency key produce exactly one pair', async () => {
  const conversation = await newConversation();
  assert.equal(
    chatConversationLockKey(orgA.orgId, conversation.id),
    JSON.stringify([orgA.orgId, conversation.id]),
  );

  const input = {
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'race-same-key',
    question: 'Double-clicked question',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  };
  const [first, second] = await Promise.all([
    store.appendTurnPair({ ...input }),
    store.appendTurnPair({ ...input }),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first!.userTurn.id, second!.userTurn.id);
  assert.equal(first!.assistantTurn.id, second!.assistantTurn.id);
  assert.equal([first!.created, second!.created].filter(Boolean).length, 1, 'exactly one winner');

  const rows = await pool.query('SELECT id FROM chat_turns WHERE conversation_id = $1', [
    conversation.id,
  ]);
  assert.equal(rows.rowCount, 2);
});

// @spec EC-10
test('[CONCURRENCY] two racing posts with DIFFERENT idempotency keys produce contiguous seq values and no unique violation', async () => {
  const conversation = await newConversation();
  const base = {
    owner: ownerA(),
    conversationId: conversation.id,
    question: 'Concurrent question',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  };

  const [a, b] = await Promise.all([
    store.appendTurnPair({ ...base, idempotencyKey: 'race-key-a' }),
    store.appendTurnPair({ ...base, idempotencyKey: 'race-key-b' }),
  ]);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a!.created, true);
  assert.equal(b!.created, true);

  const rows = await pool.query(
    'SELECT seq FROM chat_turns WHERE conversation_id = $1 ORDER BY seq',
    [conversation.id],
  );
  assert.deepEqual(
    rows.rows.map((row) => Number(row.seq)),
    [1, 2, 3, 4],
    'four contiguous turns across the two pairs',
  );
});

// @spec EC-11
test('the first turn in a brand-new conversation carries an empty history', async () => {
  const conversation = await newConversation();
  const result = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'first-turn-history',
    question: 'First question',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(result);
  assert.deepEqual(result!.history, []);
});

// @spec AC-7 EC-12
test('history is the newest twelve COMPLETED turns ascending — pending/running/error answers are excluded, their questions are not', async () => {
  const conversation = await newConversation();
  // Ten fully answered exchanges (CH-04 would be the one completing them).
  for (let index = 1; index <= 10; index += 1) {
    const pair = await store.appendTurnPair({
      owner: ownerA(),
      conversationId: conversation.id,
      idempotencyKey: `history-key-${index}`,
      question: `question ${index}`,
      scope: { view: null, anchorNodeId: null },
      historyLimit: HISTORY_LIMIT,
    });
    assert.ok(pair);
    await pool.query(
      "UPDATE chat_turns SET status = 'completed', content = $2 WHERE id = $1",
      [pair!.assistantTurn.id, `answer ${index}`],
    );
  }
  // One exchange that failed: its question stays, its answer must not appear.
  const failed = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'history-key-failed',
    question: 'question failed',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(failed);
  await pool.query(
    "UPDATE chat_turns SET status = 'error', error = '{\"code\":\"boom\"}'::jsonb WHERE id = $1",
    [failed!.assistantTurn.id],
  );

  const next = await store.appendTurnPair({
    owner: ownerA(),
    conversationId: conversation.id,
    idempotencyKey: 'history-key-next',
    question: 'the new question',
    scope: { view: null, anchorNodeId: null },
    historyLimit: HISTORY_LIMIT,
  });
  assert.ok(next);

  const history = next!.history;
  assert.equal(history.length, HISTORY_LIMIT);
  for (const entry of history) {
    assert.deepEqual(Object.keys(entry).sort(), ['content', 'role']);
  }
  assert.ok(!history.some((entry) => entry.content === ''), 'no pending answer leaks into history');
  assert.ok(
    history.some((entry) => entry.content === 'question failed'),
    'a failed exchange still shows its unanswered question',
  );
  assert.equal(history.at(-1)?.content, 'question failed');
  assert.ok(!history.some((entry) => entry.content === 'the new question'));
});

// @spec EC-16
test('getConversation returns at most the newest 200 turns, ascending by seq', async () => {
  const conversation = await newConversation();
  for (let index = 1; index <= 120; index += 1) {
    const pair = await store.appendTurnPair({
      owner: ownerA(),
      conversationId: conversation.id,
      idempotencyKey: `bulk-key-${index}`,
      question: `bulk question ${index}`,
      scope: { view: null, anchorNodeId: null },
      historyLimit: HISTORY_LIMIT,
    });
    assert.ok(pair);
  }

  const detail = await store.getConversation(ownerA(), conversation.id, TURNS_LIMIT);
  assert.ok(detail);
  assert.equal(detail!.turns.length, TURNS_LIMIT);
  const seqs = detail!.turns.map((turn) => turn.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'ascending by seq');
  assert.equal(seqs.at(-1), 240, 'the newest turn is included');
  assert.equal(seqs[0], 41, 'the oldest 40 turns are trimmed');
});

// @spec EC-17
test('a whitespace-only or omitted title is stored as SQL NULL', async () => {
  const blank = await store.createConversation(ownerA(), null);
  assert.equal(blank.title, null);
  const raw = await pool.query('SELECT title FROM chat_conversations WHERE id = $1', [blank.id]);
  assert.equal(raw.rows[0].title, null);

  await assert.rejects(
    pool.query('INSERT INTO chat_conversations (org_id, user_id, title) VALUES ($1, $2, $3)', [
      orgA.orgId,
      orgA.primaryUserId,
      '   ',
    ]),
    /chat_conversations_title_check|violates check constraint/,
  );
});

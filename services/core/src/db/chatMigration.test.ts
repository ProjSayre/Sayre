// CH-03 — CI-safe migration-content assertions for
// drizzle/0021_ch03_chat_conversations_and_turns.sql (the
// src/db/agentSkillMdMigration.test.ts idiom: read the hand-authored SQL and
// assert the structural guarantees it is supposed to carry).
//
// This file measures the *declared* structure only. The runtime enforcement
// half (RLS actually filtering a cross-org row, the composite FK actually
// rejecting a cross-org insert) is asserted against a live Postgres in
// src/db/chatStore.rls.test.ts, which is excluded from the vitest run.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION_URL = new URL(
  '../../drizzle/0021_ch03_chat_conversations_and_turns.sql',
  import.meta.url,
);
const JOURNAL_URL = new URL('../../drizzle/meta/_journal.json', import.meta.url);

/** Empty string when the migration has not been authored yet, so each assertion
 *  below fails on its own (missing) content rather than on a module-load ENOENT. */
function migrationSql(): string {
  return existsSync(MIGRATION_URL) ? readFileSync(MIGRATION_URL, 'utf8') : '';
}

function journal(): { entries?: Array<{ idx: number; tag: string }> } {
  return existsSync(JOURNAL_URL)
    ? (JSON.parse(readFileSync(JOURNAL_URL, 'utf8')) as { entries?: Array<{ idx: number; tag: string }> })
    : {};
}

describe('CH-03 chat persistence migration 0021', () => {
  // @spec AC-1
  it('is registered in the drizzle journal so the tables exist at runtime', () => {
    const entries = journal().entries ?? [];
    expect(entries.some((entry) => entry.tag === '0021_ch03_chat_conversations_and_turns')).toBe(true);
    expect(entries.find((entry) => entry.tag === '0021_ch03_chat_conversations_and_turns')?.idx).toBe(21);
  });

  // @spec AC-1
  it('creates both tables and constrains a turn to the user/assistant shapes CH-04 depends on', () => {
    const migration = migrationSql();
    expect(migration).toMatch(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?chat_conversations"?/u);
    expect(migration).toMatch(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?chat_turns"?/u);
    expect(migration).toMatch(/role\s+IN\s+\('user',\s*'assistant'\)/u);
    expect(migration).toMatch(
      /status\s+IN\s+\('pending',\s*'running',\s*'completed',\s*'error'\)/u,
    );
    expect(migration).toMatch(/seq\s*>=\s*1/u);
    // A user turn always carries its idempotency key, is already completed, has
    // no request_turn_id and has not been dispatched.
    expect(migration).toMatch(
      /chat_turns_user_shape_check[\s\S]*idempotency_key IS NOT NULL[\s\S]*request_turn_id IS NULL[\s\S]*status = 'completed'/u,
    );
    // An assistant turn is always paired back to the user turn it answers.
    expect(migration).toMatch(
      /chat_turns_assistant_shape_check[\s\S]*idempotency_key IS NULL[\s\S]*request_turn_id IS NOT NULL/u,
    );
    expect(migration).toMatch(/"?dispatched_at"?\s+timestamp with time zone/u);
  });

  // @spec AC-2
  it('makes a duplicate idempotency key and a duplicate assistant turn structurally impossible', () => {
    const migration = migrationSql();
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*"?chat_turns_idempotency_unique"?[\s\S]*\(\s*"?org_id"?\s*,\s*"?conversation_id"?\s*,\s*"?idempotency_key"?\s*\)\s*WHERE\s+"?idempotency_key"?\s+IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*"?chat_turns_request_turn_unique"?[\s\S]*\(\s*"?org_id"?\s*,\s*"?request_turn_id"?\s*\)\s*WHERE\s+"?request_turn_id"?\s+IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /UNIQUE\s*\(\s*"?org_id"?\s*,\s*"?conversation_id"?\s*,\s*"?seq"?\s*\)/u,
    );
  });

  // @spec AC-5 EC-20
  it('binds every child row to its tenant through composite foreign keys', () => {
    const migration = migrationSql();
    // chat_turns -> chat_conversations is (org_id, conversation_id), so a turn
    // can never name a conversation belonging to another org.
    expect(migration).toMatch(
      /FOREIGN KEY\s*\(\s*"?org_id"?\s*,\s*"?conversation_id"?\s*\)[\s\S]*REFERENCES[\s\S]*"?chat_conversations"?\s*\(\s*"?org_id"?\s*,\s*"?id"?\s*\)/u,
    );
    // chat_conversations -> users is (org_id, user_id), so an owner can never be
    // a user from another org.
    expect(migration).toMatch(
      /FOREIGN KEY\s*\(\s*"?org_id"?\s*,\s*"?user_id"?\s*\)[\s\S]*REFERENCES[\s\S]*"?users"?\s*\(\s*"?org_id"?\s*,\s*"?id"?\s*\)/u,
    );
    // Both composite FKs need a matching unique key on the referenced side.
    expect(migration).toMatch(
      /ALTER TABLE\s+"?users"?\s+ADD CONSTRAINT\s+"?users_org_id_id_unique"?\s+UNIQUE\s*\(\s*"?org_id"?\s*,\s*"?id"?\s*\)/u,
    );
    expect(migration).toMatch(
      /"?chat_conversations_org_id_id_unique"?\s+UNIQUE\s*\(\s*"?org_id"?\s*,\s*"?id"?\s*\)/u,
    );
  });

  // @spec AC-5
  it('enables and forces org_isolation RLS on both new tables', () => {
    const migration = migrationSql();
    for (const table of ['chat_conversations', 'chat_turns']) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE\\s+"?${table}"?\\s+ENABLE ROW LEVEL SECURITY`, 'u'),
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE\\s+"?${table}"?\\s+FORCE\\s+ROW LEVEL SECURITY`, 'u'),
      );
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY org_isolation ON\\s+"?${table}"?[\\s\\S]*?current_setting\\('app\\.org_id', true\\)`,
          'u',
        ),
      );
    }
  });

  // @spec AC-5
  it('grants the runtime role read/write but never DELETE on either table', () => {
    const migration = migrationSql();
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON\s+"?chat_conversations"?\s+TO sayre_app/u,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON\s+"?chat_turns"?\s+TO sayre_app/u,
    );
    expect(migration).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*ON\s+"?chat_conversations"?/u);
    expect(migration).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*ON\s+"?chat_turns"?/u);
  });

  // @spec EC-17
  it('rejects a blank or over-long conversation title at the database layer', () => {
    const migration = migrationSql();
    expect(migration).toMatch(
      /chat_conversations_title_check[\s\S]*title IS NULL[\s\S]*length\(btrim\(title\)\) > 0[\s\S]*length\(title\) <= 200/u,
    );
  });
});

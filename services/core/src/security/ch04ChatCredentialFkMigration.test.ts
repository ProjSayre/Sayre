// CH-04 red suite — the migration text/security contract for
// drizzle/0022_ch04_mcp_key_conversation_fk.sql: CH-01's owed tenant-consistent
// composite FK plus the AFTER DELETE trigger that stops the new cascade path
// orphaning `permissions` ceiling rows.
//
// Mirrors src/security/ephemeralMcpCredentialMigration.test.ts (including its
// "no credential-material vocabulary in the DDL" assertion). The runtime half —
// that the FK actually rejects a cross-org conversation_id and that the trigger
// actually removes the ceiling rows — is DB-dependent and belongs with the
// other *.rls.test.ts suites, which need a live Postgres.
//
// Authored by `red` from .pipeline/spec.md before any implementation exists.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION_URL = new URL(
  '../../drizzle/0022_ch04_mcp_key_conversation_fk.sql',
  import.meta.url,
);
const CH01_MIGRATION_URL = new URL(
  '../../drizzle/0020_ch01_ephemeral_mcp_credentials.sql',
  import.meta.url,
);
const JOURNAL_URL = new URL('../../drizzle/meta/_journal.json', import.meta.url);

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function migrationSql(): string {
  const path = fileURLToPath(MIGRATION_URL);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function journal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(fileURLToPath(JOURNAL_URL), 'utf8')) as {
    entries: JournalEntry[];
  };
}

describe('CH-04 migration 0022 contract', () => {
  // @spec AC-13
  it('adds the tenant-consistent composite FK with ON DELETE cascade', () => {
    const migration = migrationSql();

    expect(migration).toMatch(/-->\s*statement-breakpoint/);
    expect(migration).toMatch(
      /ALTER TABLE mcp_client_keys\s+ADD CONSTRAINT mcp_client_keys_org_conversation_fk/i,
    );
    expect(migration).toMatch(
      /FOREIGN KEY\s*\(\s*"?org_id"?\s*,\s*"?conversation_id"?\s*\)/i,
    );
    expect(migration).toMatch(
      /REFERENCES\s+"?(?:public"?\.")?chat_conversations"?\s*\(\s*"?org_id"?\s*,\s*"?id"?\s*\)/i,
    );
    expect(migration).toMatch(/ON DELETE\s+cascade/i);
  });

  // @spec AC-13 EC-27
  it('leaves ordinary agent keys exempt by relying on the default MATCH SIMPLE', () => {
    const migration = migrationSql();

    // MATCH FULL would make a (org_id NOT NULL, conversation_id NULL) agent-key
    // row violate the constraint; MATCH SIMPLE (the default) exempts it with no
    // extra predicate, which is exactly why no predicate appears here.
    expect(migration).not.toMatch(/MATCH\s+FULL/i);
    expect(migration).toMatch(/MATCH SIMPLE/);
    expect(migration).toMatch(/conversation_id is null/i);
  });

  // @spec AC-13 EC-28
  it('adds the AFTER DELETE trigger that clears an ephemeral key’s permissions ceiling', () => {
    const migration = migrationSql();

    const functionAt = migration.search(
      /CREATE OR REPLACE FUNCTION mcp_client_keys_delete_ephemeral_ceiling/i,
    );
    const dropTriggerAt = migration.search(
      /DROP TRIGGER IF EXISTS delete_ephemeral_ceiling ON mcp_client_keys/i,
    );
    const createTriggerAt = migration.search(
      /CREATE TRIGGER delete_ephemeral_ceiling\s+AFTER DELETE ON mcp_client_keys/i,
    );

    expect(functionAt).toBeGreaterThanOrEqual(0);
    expect(dropTriggerAt).toBeGreaterThan(functionAt);
    expect(createTriggerAt).toBeGreaterThan(dropTriggerAt);

    expect(migration).toMatch(/FOR EACH ROW\s+EXECUTE FUNCTION mcp_client_keys_delete_ephemeral_ceiling/i);
    expect(migration).toMatch(/LANGUAGE plpgsql/i);
    expect(migration).toMatch(/IF OLD\.kind = 'chat_ephemeral' THEN/i);
    expect(migration).toMatch(/DELETE FROM permissions/i);
    expect(migration).toMatch(/subject_type = 'agent_key'/i);
    expect(migration).toMatch(/subject_id = OLD\.key_prefix/i);
    expect(migration).toMatch(/org_id = OLD\.org_id/i);
    expect(migration).toMatch(/RETURN OLD;/i);
  });

  // @spec AC-13
  it('keeps credential-material vocabulary out of the DDL', () => {
    expect(migrationSql()).not.toMatch(/\b(?:raw_key|plaintext|token|secret)\b/i);
  });

  // @spec AC-13
  it('records a matching journal entry with journal-wide unique indices', () => {
    const entries = journal().entries;
    const entry = entries.find(
      (candidate) => candidate.tag === '0022_ch04_mcp_key_conversation_fk',
    );

    expect(entry).toEqual({
      idx: 22,
      version: '7',
      when: 1785384600000,
      tag: '0022_ch04_mcp_key_conversation_fk',
      breakpoints: true,
    });
    expect(new Set(entries.map((item) => item.idx)).size).toBe(entries.length);
    expect(entries.map((item) => item.idx)).toEqual(
      [...entries].map((item) => item.idx).sort((left, right) => left - right),
    );

    // CH-01's own migration and journal entry are untouched, so
    // ephemeralMcpCredentialMigration.test.ts still passes unchanged.
    expect(existsSync(fileURLToPath(CH01_MIGRATION_URL))).toBe(true);
    expect(
      entries.find((item) => item.tag === '0020_ch01_ephemeral_mcp_credentials'),
    ).toEqual({
      idx: 20,
      version: '7',
      when: 1785384400000,
      tag: '0020_ch01_ephemeral_mcp_credentials',
      breakpoints: true,
    });
  });
});

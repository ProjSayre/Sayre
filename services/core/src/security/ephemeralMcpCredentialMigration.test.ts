// CH-01 red suite — the migration text/security contract for
// drizzle/0020_ch01_ephemeral_mcp_credentials.sql, mirroring the existing
// W4-06 contract in mcpMigration.test.ts (including its
// "no credential-material vocabulary in the DDL" assertion).
//
// The runtime half of these guarantees — that the CHECK constraints actually
// reject the malformed rows, and that PUBLIC actually cannot execute the
// recreated resolver — is DB-dependent and lives in
// src/db/ephemeralMcpCredentials.rls.test.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATION_URL = new URL(
  '../../drizzle/0020_ch01_ephemeral_mcp_credentials.sql',
  import.meta.url,
);
const JOURNAL_URL = new URL('../../drizzle/meta/_journal.json', import.meta.url);

function migrationSql(): string {
  const path = fileURLToPath(MIGRATION_URL);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

describe('CH-01 migration 0020 contract', () => {
  // @spec AC-13
  it('adds both columns, all three CHECK constraints, and both partial indexes', () => {
    const migration = migrationSql();

    expect(migration).toMatch(/-->\s*statement-breakpoint/);
    expect(migration).toMatch(/ALTER TABLE mcp_client_keys ADD COLUMN kind text/i);
    expect(migration).toMatch(/DEFAULT 'agent' NOT NULL/i);
    expect(migration).toMatch(
      /ALTER TABLE mcp_client_keys ADD COLUMN conversation_id uuid/i,
    );

    expect(migration).toMatch(/mcp_client_keys_kind_check/);
    expect(migration).toMatch(/kind IN \('agent','chat_ephemeral'\)/);
    expect(migration).toMatch(/mcp_client_keys_ephemeral_shape_check/);
    expect(migration).toMatch(/conversation_id IS NOT NULL AND expires_at IS NOT NULL/);
    expect(migration).toMatch(/kind = 'agent' AND conversation_id IS NULL/);
    expect(migration).toMatch(/mcp_client_keys_ephemeral_ttl_check/);
    expect(migration).toMatch(/interval '600 seconds'/);
    expect(migration).toMatch(/expires_at > created_at/);

    expect(migration).toMatch(
      /CREATE INDEX mcp_client_keys_ephemeral_conversation_idx[\s\S]*?\(org_id, conversation_id\)[\s\S]*?WHERE kind = 'chat_ephemeral'/,
    );
    expect(migration).toMatch(
      /CREATE INDEX mcp_client_keys_ephemeral_expires_idx[\s\S]*?\(expires_at\)[\s\S]*?WHERE kind = 'chat_ephemeral'/,
    );

    // The shape CHECK deliberately omits `created_by IS NOT NULL`: created_by is
    // ON DELETE SET NULL, and requiring it would make deleting a user fail —
    // the cascade defect documented in drizzle/0007_*.
    expect(migration).not.toMatch(/created_by\s+IS\s+NOT\s+NULL/i);
  });

  // @spec AC-13 EC-23
  it('drops and recreates the resolver, keeping it SECURITY DEFINER and off PUBLIC', () => {
    const migration = migrationSql();

    const dropAt = migration.search(
      /DROP FUNCTION IF EXISTS resolve_mcp_client_key\(text\)/,
    );
    const createAt = migration.search(/CREATE FUNCTION resolve_mcp_client_key/);
    const revokeAt = migration.search(
      /REVOKE ALL ON FUNCTION resolve_mcp_client_key\(text\) FROM PUBLIC/,
    );
    const grantAt = migration.search(
      /GRANT EXECUTE ON FUNCTION resolve_mcp_client_key\(text\) TO sayre_app/,
    );

    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(revokeAt).toBeGreaterThan(createAt);
    expect(grantAt).toBeGreaterThan(createAt);
    // CREATE OR REPLACE cannot change a RETURNS TABLE column list.
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION resolve_mcp_client_key/,
    );

    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/SET search_path = public, pg_temp/);
    expect(migration).toMatch(/STABLE/);
    // The recreated result set carries the two new discriminator columns.
    expect(migration).toMatch(/kind text/);
    expect(migration).toMatch(/conversation_id uuid/);
  });

  // @spec AC-13
  it('keeps credential-material vocabulary out of the DDL', () => {
    expect(migrationSql()).not.toMatch(/\b(?:raw_key|plaintext|token|secret)\b/i);
  });

  // @spec AC-13
  it('records a matching journal entry as the newest migration', () => {
    const journal = JSON.parse(
      readFileSync(fileURLToPath(JOURNAL_URL), 'utf8'),
    ) as { entries: JournalEntry[] };
    const entry = journal.entries.find(
      (candidate) => candidate.tag === '0020_ch01_ephemeral_mcp_credentials',
    );

    // Renumbered 0019 -> 0020: main landed
    // 0019_w0_05_tenant_consistent_repo_fks at idx 19 first, so CH-01's
    // migration moves after it. `when` moves with it (strictly greater than
    // idx 19's 1785384300000) so journal order and drizzle's own apply order
    // agree. This stays a strict tip assertion, not a presence check -- the
    // at(-1) equality below is what proves 0020 is the newest entry.
    expect(entry).toEqual({
      idx: 20,
      version: '7',
      when: 1785384400000,
      tag: '0020_ch01_ephemeral_mcp_credentials',
      breakpoints: true,
    });
    expect(journal.entries.at(-1)).toEqual(entry);
    expect(new Set(journal.entries.map((item) => item.idx)).size).toBe(
      journal.entries.length,
    );
  });
});

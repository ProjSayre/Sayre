import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('W4-06 MCP migration security contract', () => {
  it('uses a narrow security-definer bootstrap and a bounded org rate policy', () => {
    const migration = readFileSync(
      new URL('../../drizzle/0011_w4_06_mcp_gateway.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toMatch(
      /mcp_rate_limit_per_minute BETWEEN 1 AND 10000/,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION resolve_mcp_client_key/,
    );
    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/SET search_path = public, pg_temp/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION resolve_mcp_client_key\(text\) FROM PUBLIC/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION resolve_mcp_client_key\(text\) TO sayre_app/,
    );
    expect(migration).not.toMatch(/\b(?:raw_key|plaintext|token|secret)\b/i);
  });
});

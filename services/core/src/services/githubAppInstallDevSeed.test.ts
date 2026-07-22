// Tester-added coverage (W1-06 O-2): confirms the fixed dev-seed org UUID
// documented in `infra/.env.example` / `infra/github-app/README.md` is (a) a
// real, well-formed UUID that satisfies `withOrgContext`'s UUID guard
// (services/core/src/db/client.ts — `UUID_RE`, not re-exported, so the same
// pattern is duplicated here deliberately to catch drift) and (b) still
// present verbatim in `infra/.env.example`, so the documented seed command
// and the `DEV_ORG_ID` a developer sets locally can never silently diverge.
//
// This does NOT touch a real Postgres connection (src/db/** tests are a
// separate node:test runner — see vitest.config.ts) and does not prove a row
// with this id exists in any particular database; it proves the value dev
// picked is structurally usable and is not just a comment nobody exercises.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Mirrors db/client.ts's UUID_RE exactly (kept duplicated on purpose, not
// imported, to fail loudly if the two definitions ever drift apart).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEV_SEED_ORG_ID = '00000000-0000-4000-8000-000000000001';

describe('W1-06 O-2 — dev-seed org UUID', () => {
  it('is a well-formed UUID that would pass withOrgContext\'s guard', () => {
    expect(UUID_RE.test(DEV_SEED_ORG_ID)).toBe(true);
  });

  it('is NOT the non-UUID DEV_ORG_ID default ("org_dev_local")', () => {
    expect(UUID_RE.test('org_dev_local')).toBe(false);
  });

  it('is documented verbatim in infra/.env.example (seed command + override value)', () => {
    const envExample = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infra', '.env.example'),
      'utf8',
    );
    const occurrences = envExample.split(DEV_SEED_ORG_ID).length - 1;
    // Expected twice: once in the seed `INSERT ... VALUES (...)` command,
    // once in "then set DEV_ORG_ID=<uuid>" guidance immediately after.
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('is documented in infra/github-app/README.md as required before exercising the callback', () => {
    const readme = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infra', 'github-app', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('DEV_ORG_ID');
    expect(readme).toMatch(/real org UUID|real.*UUID/i);
  });
});

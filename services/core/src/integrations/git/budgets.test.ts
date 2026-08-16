// W3-04 gapfill (GAP-2). Leading-red coverage for the pinned budget/pagination constants
// spec.md's Interfaces section requires: GIT_SYNC_TARGET_MS is the literal number an
// end-to-end test and a metric-breach check both reference "by the constant, not a
// literal" (AC-5) instead of the module simply not existing.
//
// Broker-free: imports only, no Redis/Neo4j.

import { describe, expect, it } from 'vitest';

describe('budgets (GAP-2, GAP-3, GAP-5)', () => {
  // @spec AC-5
  it('GIT_SYNC_TARGET_MS is a single named 5_000ms constant citing the PRD line numbers', async () => {
    const budgets = await import('./budgets');
    expect(budgets.GIT_SYNC_TARGET_MS).toBe(5_000);

    // AC-5: "a single named constant with a comment citing PRD-V1.md:16/:258" — a
    // module-level docstring is the only place that citation can live, so read the
    // raw source rather than a runtime value (JSDoc is erased at build time).
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./budgets.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/PRD-V1\.md:16/);
    expect(source).toMatch(/PRD-V1\.md:258|:258/);
    expect(source).toMatch(/GIT_SYNC_TARGET_MS/);
  });

  // @spec AC-6
  it('GIT_PROVIDER_REQUEST_TIMEOUT_MS is a per-request hang guard, deliberately larger than the target', async () => {
    const budgets = await import('./budgets');
    expect(budgets.GIT_PROVIDER_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(budgets.GIT_PROVIDER_REQUEST_TIMEOUT_MS).toBeGreaterThan(budgets.GIT_SYNC_TARGET_MS);
  });

  // @spec AC-6 EC-9
  it('MAX_PULL_REQUEST_FILE_PAGES bounds GitHub PR-files pagination at 30 pages', async () => {
    const budgets = await import('./budgets');
    expect(budgets.MAX_PULL_REQUEST_FILE_PAGES).toBe(30);
  });

  // @spec AC-8 EC-16
  it('GITHUB_PUSH_COMMIT_CAP mirrors GitHub push payload truncation at 20 commits', async () => {
    const budgets = await import('./budgets');
    expect(budgets.GITHUB_PUSH_COMMIT_CAP).toBe(20);
  });
});

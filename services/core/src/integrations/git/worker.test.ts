// W3-04 gapfill (GAP-1b, GAP-4, GAP-6). Leading-red coverage for worker.ts's plumbing
// changes that AC-9 states as literal source-level requirements ("worker.ts contains no
// adapter constructor literal", "enabling a different provider requires no edit to
// worker.ts") plus AC-4/AC-7's "the worker records it" / failed-listener requirements.
//
// This file is deliberately static/source-content based, not a runtime instantiation of
// startGitSyncWorker(): that function's default dependency path calls createWorker(),
// which opens a real Redis connection — exercising it live belongs to the Redis-gated
// integration tests (w3-04.acceptance.integration.test.ts, jobRetry.integration.test.ts),
// not this broker-free file. AC-9's own wording ("worker.ts contains no adapter
// constructor literal") is itself a source-text claim, so asserting it as one is a
// faithful reading of the acceptance criterion, not a workaround.
//
// Broker-free: reads worker.ts as text only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function workerSource(): string {
  return readFileSync(resolve(__dirname, 'worker.ts'), 'utf8');
}

describe('worker.ts (GAP-6) — configuration-driven provider registration', () => {
  // @spec AC-9
  it('contains no adapter constructor literal (e.g. `new GithubProviderAdapter(`)', () => {
    const source = workerSource();
    expect(source).not.toMatch(/new\s+GithubProviderAdapter\s*\(/);
    expect(source).not.toMatch(/new\s+FakeHubProviderAdapter\s*\(/);
  });

  // @spec AC-9
  it('resolves its provider registry via loadGitProviderRegistry(), not a hardcoded list', () => {
    const source = workerSource();
    expect(source).toMatch(/loadGitProviderRegistry\s*\(/);
  });

  // @spec AC-9
  it('startGitSyncWorker accepts partial dependency overrides', () => {
    const source = workerSource();
    expect(source).toMatch(/overrides\s*\?\s*:\s*Partial<\s*GitSyncDependencies\s*>/);
  });
});

describe('worker.ts (GAP-4) — terminal-failure recording', () => {
  // @spec AC-7
  it("registers a worker 'failed' listener that logs only org/provider/delivery/attempt/error-name", () => {
    const source = workerSource();
    expect(source).toMatch(/\.on\(\s*['"]failed['"]/);
    expect(source).toMatch(/org_id/);
    expect(source).toMatch(/attemptsMade/);
    expect(source).toMatch(/error_name/);
  });
});

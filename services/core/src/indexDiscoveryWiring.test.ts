// Leading-red structural test (W7-01, AC-22) for index.ts's startup/shutdown wiring of the
// installation-discovery outbox gate and dispatcher. index.ts runs `main()` at module load time
// (real secrets, real DB, real BullMQ) with no dependency-injection seam, so it cannot be
// exercised as a normal unit test — mirrors the "leading red" architecture-check convention in
// apps/web/app/workspace/workspaceProductArchitecture.red.test.ts: a source-text assertion, which
// is the direct way to state "index.ts must wire these calls" from spec.md alone without
// executing a real startup sequence. None of this text exists in index.ts today, so this fails
// (RED-CORRECT).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function repositoryRoot(): string {
  return existsSync(resolve(process.cwd(), 'services/core/package.json'))
    ? process.cwd()
    : resolve(process.cwd(), '../..');
}

function source(relative: string): string {
  const path = resolve(repositoryRoot(), relative);
  expect(existsSync(path), `Expected file is missing: ${relative}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('index.ts — AC-22 (startup gate + dispatcher lifecycle wiring)', () => {
  // @spec AC-22
  it('calls assertInstallationDiscoveryOutboxReady alongside the existing startup gates', () => {
    const text = source('services/core/src/index.ts');
    expect(text).toMatch(/assertInstallationDiscoveryOutboxReady\(runtimeDsn\)/);
  });

  // @spec AC-22
  it('constructs/starts the discovery dispatcher and installs its wake handler', () => {
    const text = source('services/core/src/index.ts');
    expect(text).toMatch(/getInstallationDiscoveryDispatcher\(\)/);
    expect(text).toMatch(/setInstallationDiscoveryWakeHandler\(/);
  });

  // @spec AC-22
  it('on shutdown clears the wake handler, stop()s the dispatcher, and closes the BullMQ queues (closeQueues)', () => {
    const text = source('services/core/src/index.ts');
    expect(text).toMatch(/setInstallationDiscoveryWakeHandler\(null\)/);
    expect(text).toMatch(/closeQueues\(\)/);
  });
});

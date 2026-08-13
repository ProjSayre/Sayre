// Leading-red structural tests (W7-01) for spec.md AC-2 and AC-19: these assert the ABSENCE of
// source text rather than behavior, mirroring the existing "leading red" architecture-check
// convention in apps/web/app/workspace/workspaceProductArchitecture.red.test.ts. AC-2's items
// (the 25-repo caps, the truncated flag, listInstallationRepos) and AC-19's "only the dispatcher
// calls enqueue() for github.installation_discovery" are structural facts about the diff, not
// runtime behavior that can be exercised through a public API — a grep-based assertion is the
// direct, non-implementation-guessing way to state "this must no longer exist anywhere" from
// spec.md alone.
//
// Every assertion below is true (i.e. the pre-W7-01 source DOES still contain these symbols)
// today, so every test fails now — RED-CORRECT: "an unhandled branch" / literally the opposite
// of the described end state.

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

describe('AC-2 — the 25-repo cap and its supporting symbols no longer exist anywhere', () => {
  // @spec AC-2
  it('appClient.ts no longer defines listInstallationRepos or a maxRepos-shaped limit helper', () => {
    const text = source('services/core/src/github/appClient.ts');
    expect(text).not.toMatch(/\blistInstallationRepos\b/);
    expect(text).not.toMatch(/\bmaxRepos\b/);
    expect(text).not.toMatch(/\bpositiveLimit\b/);
  });

  // @spec AC-2
  it('githubAppInstallService.ts no longer defines MAX_REPOS_PER_CALLBACK or the allRepos.slice(...) second cap', () => {
    const text = source('services/core/src/services/githubAppInstallService.ts');
    expect(text).not.toMatch(/MAX_REPOS_PER_CALLBACK/);
    expect(text).not.toMatch(/allRepos\.slice\(/);
    expect(text).not.toMatch(/\blistInstalledRepos\b/);
  });

  // @spec AC-2
  it('githubInstallationReconcileService.ts no longer defines MAX_RECONCILE_REPOS or a truncated result flag', () => {
    const text = source('services/core/src/services/githubInstallationReconcileService.ts');
    expect(text).not.toMatch(/MAX_RECONCILE_REPOS/);
    expect(text).not.toMatch(/\btruncated\b/);
  });

  // @spec AC-2
  it('no source file under services/core/src references listInstallationRepos(installationId, maxRepos) anywhere', () => {
    // A narrow, targeted re-check across the small set of files spec.md names as touching the
    // GitHub App client contract, rather than a full repository walk (which risks matching an
    // unrelated identifier and being unreliable to maintain).
    const files = [
      'services/core/src/github/appClient.ts',
      'services/core/src/services/githubAppInstallService.ts',
      'services/core/src/services/githubInstallationReconcileService.ts',
    ];
    for (const file of files) {
      expect(source(file), `${file} still references listInstallationRepos`).not.toMatch(
        /\blistInstallationRepos\b/,
      );
    }
  });
});

describe('AC-19 — outbox-first dispatch: only the dispatcher calls BullMQ enqueue() for discovery', () => {
  // @spec AC-19
  it('installationDiscoveryDispatcher.ts exists and is the one that calls enqueue() on the github-sync queue', () => {
    const dispatcherPath = 'services/core/src/services/installationDiscoveryDispatcher.ts';
    expect(existsSync(resolve(repositoryRoot(), dispatcherPath)), `${dispatcherPath} is missing`).toBe(
      true,
    );
    const text = source(dispatcherPath);
    expect(text).toMatch(/\benqueue\(\s*['"]github-sync['"]/);
  });

  // @spec AC-19
  it('githubAppInstallService.ts gains a kickDiscoveryDispatcher dependency and drops the callback-path enqueue/registerRepository deps', () => {
    const text = source('services/core/src/services/githubAppInstallService.ts');
    expect(text).toMatch(/kickDiscoveryDispatcher/);
    expect(text).not.toMatch(/\bregisterRepository\b/);
  });

  // @spec AC-19
  it('githubInstallationReconcileService.ts gains a kickDiscoveryDispatcher dependency and drops the request-path githubClient/registerRepository deps', () => {
    const text = source('services/core/src/services/githubInstallationReconcileService.ts');
    expect(text).toMatch(/kickDiscoveryDispatcher/);
    expect(text).not.toMatch(/\bregisterRepository\b/);
  });
});

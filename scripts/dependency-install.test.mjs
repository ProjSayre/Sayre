// Red-stage behavioral tests for W0-00's AC-1 and its edge cases — the "fresh-clone install, zero
// conflicts" acceptance test that .pipeline/spec.md is explicit "cannot be satisfied by inspection"
// and "must actually be run, not asserted." Authored from spec.md alone, before `dev` runs, per
// .sdd/stages/red.md.
//
// These tests actually shell out to `npm ci` (clean-state by design — it removes node_modules before
// installing, satisfying EC-2) and `poetry install` under a Python 3.12 interpreter (EC-7). They are
// intentionally slow; run with a generous timeout:
//   node --test scripts/dependency-install.test.mjs
//
// Design notes:
//  - EC-3: assert `npm ci` (which refuses to auto-fix a manifest/lockfile mismatch), not `npm
//    install`, so a manifest edit without a regenerated lockfile fails loudly here.
//  - AC-6: after a clean install, the committed lockfiles must be reproduced byte-for-byte — proven
//    by asserting `git status --porcelain <lockfile>` is empty (neither `npm ci` nor `poetry
//    install` rewrote the committed lock), plus that there are no stray per-package lockfiles.
//  - If poetry or a Python 3.12 interpreter is genuinely absent on the host, the poetry test SKIPS
//    (recorded, not silently passed) — the npm half still runs. On a host that has them (the
//    reference environment does), both run for real.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

// EBADENGINE (a dev box on Node != 20) and upstream deprecation notices are explicitly NOT conflicts
// per AC-1; a genuine resolver conflict is an ERESOLVE block or an actual peer-dependency warning.
function findConflictLines(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => /ERESOLVE/i.test(line) || /npm warn\b.*\bpeer\b/i.test(line) || /could not resolve dependency/i.test(line));
}

function gitPorcelain(pathspec) {
  return execFileSync('git', ['status', '--porcelain', '--', pathspec], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

// @spec AC-1 EC-2 EC-3 EC-8
test('[AC-1][EC-2][EC-3][EC-8] a clean-state root `npm ci` resolves all workspace members with zero conflicts', () => {
  // `npm ci` removes node_modules itself before installing, so this is genuinely clean-state (EC-2),
  // and it refuses to reconcile a manifest/lockfile mismatch rather than silently fixing it (EC-3).
  const result = spawnSync('npm', ['ci'], { cwd: repoRoot, encoding: 'utf8', timeout: 8 * 60 * 1000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  assert.equal(result.status, 0, `npm ci must exit 0 (fresh-clone install). Output:\n${output}`);

  const conflicts = findConflictLines(output);
  assert.deepEqual(conflicts, [], `npm ci surfaced version-resolution conflicts (ERESOLVE / peer):\n${conflicts.join('\n')}`);
  // EC-8: @sigma/node-border's range must resolve against sigma without a peer conflict — covered by
  // the zero-conflict assertion above; assert no sigma-specific peer warning slipped through.
  assert.doesNotMatch(output, /npm warn\b.*\bpeer\b.*sigma/i, 'a peer conflict involving sigma surfaced during install');
});

// @spec AC-6
test('[AC-6] one root lockfile, no stray per-package lockfiles, and `npm ci` reproduces it unchanged', () => {
  assert.ok(existsSync(join(repoRoot, 'package-lock.json')), 'a single root package-lock.json must exist');

  const strays = [];
  for (const dir of ['apps/web', 'services/core', 'services/gateway', 'packages/config', 'packages/shared-types']) {
    if (existsSync(join(repoRoot, dir, 'package-lock.json'))) strays.push(`${dir}/package-lock.json`);
  }
  assert.deepEqual(strays, [], `stray per-package lockfile(s) must not exist under the single npm workspace: ${strays.join(', ')}`);

  // Reproducibility: `npm ci` installs strictly from the committed lockfile and never rewrites it —
  // if the committed lock reproduces the resolved graph, the working tree stays clean afterwards.
  assert.equal(gitPorcelain('package-lock.json'), '', 'npm ci rewrote package-lock.json — the committed lockfile is not reproducible/consistent');
});

// @spec AC-1 EC-2 EC-7
test('[AC-1][EC-2][EC-7] a clean-state `poetry install` under Python 3.12 resolves with zero conflicts', (t) => {
  const workersDir = join(repoRoot, 'services', 'workers');
  const poetry = spawnSync('poetry', ['--version'], { encoding: 'utf8' });
  if (poetry.status !== 0) {
    t.skip('poetry is not installed on this host — AC-1 (Python half) requires it. Recorded as an infra gap, not a silent pass.');
    return;
  }
  const python312 = spawnSync('which', ['python3.12'], { encoding: 'utf8' });
  if (python312.status !== 0) {
    t.skip('no python3.12 interpreter on PATH — EC-7 requires the resolve to run under Python 3.12. Recorded as an infra gap.');
    return;
  }
  const interpreter = python312.stdout.trim();

  const useEnv = spawnSync('poetry', ['env', 'use', interpreter], { cwd: workersDir, encoding: 'utf8', timeout: 3 * 60 * 1000 });
  assert.equal(useEnv.status, 0, `poetry env use python3.12 failed:\n${useEnv.stdout}\n${useEnv.stderr}`);

  const install = spawnSync('poetry', ['install'], { cwd: workersDir, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  const output = `${install.stdout ?? ''}\n${install.stderr ?? ''}`;
  assert.equal(install.status, 0, `poetry install must exit 0 from the committed lock. Output:\n${output}`);
  assert.doesNotMatch(output, /SolverProblem|version solving failed|because .* depends on/i, `poetry surfaced a resolver conflict:\n${output}`);

  const version = spawnSync('poetry', ['run', 'python', '--version'], { cwd: workersDir, encoding: 'utf8' });
  assert.match(version.stdout + version.stderr, /Python 3\.12\./, 'the resolved Poetry env must be Python 3.12 (EC-7)');

  // AC-6 (Python half): the committed poetry.lock must be reproduced unchanged by a clean install.
  assert.equal(gitPorcelain('services/workers/poetry.lock'), '', 'poetry install rewrote poetry.lock — the committed lock is not reproducible/consistent');
});

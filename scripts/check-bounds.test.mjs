import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-bounds.mjs');
const REPO = resolve(HERE, '..');

const IN_BOUNDS = 0;
const VIOLATION = 1;
const ERROR = 2;

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function check(lane, files, extra = []) {
  return run(['--lane', lane, ...extra, '--files', ...files]);
}

test('a change entirely inside the lane is in bounds', () => {
  const { code } = check('frontend', ['apps/web/app/page.tsx', 'docs/prd.md']);
  assert.equal(code, IN_BOUNDS);
});

test('a single out-of-lane file makes the whole change a violation', () => {
  const { code, stdout } = check('frontend', ['apps/web/x.tsx', 'services/core/src/index.ts']);
  assert.equal(code, VIOLATION);
  assert.match(stdout, /services\/core\/src\/index\.ts/);
});

test('the directory itself matches its own `dir/**` glob', () => {
  // `apps/web/**` must cover `apps/web`, or a change to the directory entry reads as out-of-lane.
  assert.equal(check('frontend', ['apps/web']).code, IN_BOUNDS);
});

test('`*` does not cross a path separator', () => {
  // Guards against a lane glob accidentally widening: `docs/**` should match nested paths, but a
  // single-star pattern must not.
  const nested = check('frontend', ['docs/deep-audit-2026-07-31/audit-18-infra-cicd.md']);
  assert.equal(nested.code, IN_BOUNDS, 'docs/** should match nested paths');
});

test('a sibling sharing a lane prefix is not inside the lane', () => {
  for (const sibling of ['apps/web-legacy/x.tsx', 'docs-archive/x.md']) {
    assert.equal(check('frontend', [sibling]).code, VIOLATION, sibling);
  }
});

test('a fenced lane cannot touch the files that define the rules', () => {
  // The important property: a fenced contributor must not be able to widen their own fence,
  // disable the checker-stage guard, or rewrite a stage definition as part of a normal ticket.
  for (const governing of [
    '.sdd/bounds.yml',
    '.sdd/stages/review.md',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'scripts/guard-checker-readonly.mjs',
    '.gitignore',
    'CLAUDE.md',
  ]) {
    const { code, stdout } = check('frontend', [governing]);
    assert.equal(code, VIOLATION, governing);
    assert.match(stdout, /governs the rules themselves/, governing);
  }
});

test('the full lane is unrestricted, including the governing files', () => {
  const { code } = check('full', ['services/core/src/index.ts', '.sdd/bounds.yml', 'CLAUDE.md']);
  assert.equal(code, IN_BOUNDS);
});

test('an unknown lane errors rather than defaulting — a typo must not widen a fence', () => {
  const { code, stderr } = check('fronend', ['apps/web/x.tsx']);
  assert.equal(code, ERROR);
  assert.match(stderr, /unknown lane/);
  assert.match(stderr, /Refusing rather than defaulting/);
});

test('a missing --lane errors rather than assuming full', () => {
  const { code } = run(['--files', 'apps/web/x.tsx']);
  assert.equal(code, ERROR);
});

test('error and violation use distinct exit codes', () => {
  // Collapsing these would let a broken check read as a clean diff.
  assert.equal(check('frontend', ['services/core/x.ts']).code, VIOLATION);
  assert.equal(check('nonexistent-lane', ['services/core/x.ts']).code, ERROR);
});

test('--json emits a machine-readable verdict for pr-review to adjudicate', () => {
  const { code, stdout } = check('frontend', ['apps/web/x.tsx', 'services/core/y.ts'], ['--json']);
  assert.equal(code, VIOLATION);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.lane, 'frontend');
  assert.equal(parsed.fenced, true);
  assert.equal(parsed.filesChecked, 2);
  assert.equal(parsed.violations.length, 1);
  assert.equal(parsed.violations[0].path, 'services/core/y.ts');
});

test('an empty change set is in bounds', () => {
  assert.equal(check('frontend', []).code, IN_BOUNDS);
});

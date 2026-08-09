import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { matchesAny, readBounds } from './check-bounds.mjs';

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
    'scripts/check-bounds.mjs',
    '.gitignore',
    'CLAUDE.md',
  ]) {
    const { code, stdout } = check('frontend', [governing]);
    assert.equal(code, VIOLATION, governing);
    assert.match(stdout, /governs the rules themselves/, governing);
  }
});

test('a fenced lane cannot edit the bounds-check script itself — review W3: a lane including scripts/** must not be able to widen its own fence by editing the script that computes it', () => {
  // Not moot today (no lane's globs include scripts/**), but this is exactly the gap review flagged:
  // scripts/guard-checker-readonly.mjs was already denied; scripts/check-bounds.mjs was not.
  const { code, stdout } = check('frontend', ['scripts/check-bounds.mjs']);
  assert.equal(code, VIOLATION);
  assert.match(stdout, /governs the rules themselves/);
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

// --- PL-04 / item 2 (the general defect): an unrecognized flag must fail loudly, naming itself -----

test('an unrecognized flag errors (exit 2, not silently ignored), naming itself', () => {
  const { code, stderr } = run(['--lane', 'frontend', '--jsno', '--files', 'apps/web/x.tsx']);
  assert.equal(code, ERROR);
  assert.match(stderr, /unrecognized argument "--jsno"/);
});

test('a bare positional argument (not a recognized flag) errors the same way, not silently skipped', () => {
  const { code, stderr } = run(['--lane', 'frontend', 'not-a-flag']);
  assert.equal(code, ERROR);
  assert.match(stderr, /unrecognized argument "not-a-flag"/);
});

// --- G1 / A3: fuzzing the hand-rolled glob matcher ------------------------------------------------
//
// The CLI-level tests above cover the shapes check-bounds.mjs's own behavior was designed around.
// These probe the matcher directly (via the exported `matchesAny`, the same function
// scripts/ledger-append.mjs's `--hotfix` path calls) against shapes nobody designed for on purpose:
// the zero-directory `**` case, `**` mid-pattern, a bare `**`, leading `./`, trailing slashes,
// backslash separators, literal regex metacharacters, case, Unicode, empty inputs, prefix
// relationships in both directions, and — the one this pass actually found — pathological
// backtracking. Each failure direction matters for a different reason: a false `true` silently
// widens a lane or a hotfix's barred-path check; a false `false` narrows one (denyForFenced;
// hotfixBarredPaths) or wrongly flags in-lane work; a hang is a third failure mode a pure
// true/false correctness check can't even see.

// PL-04 / C2: table-driven — one row per shape, `name` carrying exactly the documentation the
// original standalone test's name (and any inline rationale comment) did.
const MATCHES_ANY_CASES = [
  { name: '`**` matches the zero-directory case (the directory itself)', candidate: 'apps/web', globs: ['apps/web/**'], expected: true },
  { name: '`**` in the middle of a pattern matches zero directories between a and b', candidate: 'a/b', globs: ['a/**/b'], expected: true },
  { name: '`**` in the middle of a pattern matches one directory between a and b', candidate: 'a/x/b', globs: ['a/**/b'], expected: true },
  { name: '`**` in the middle of a pattern matches two directories between a and b', candidate: 'a/x/y/b', globs: ['a/**/b'], expected: true },
  { name: '`**` in the middle still requires the final segment to match', candidate: 'a/x/y/c', globs: ['a/**/b'], expected: false },
  { name: 'a pattern that is only `**` matches anything', candidate: 'anything/at/all', globs: ['**'], expected: true },
  { name: 'a pattern that is only `**` matches an empty candidate too', candidate: '', globs: ['**'], expected: true },
  {
    // git diff --name-only never emits a leading ./, but scripts/ledger-append.mjs's --hotfix --files
    // takes whatever a human types, and ./-prefixed is a natural thing to type. Missing this silently
    // under-matched a deny list (hotfixBarredPaths) as much as it over-flagged an allow list (a
    // lane's own globs) — both directions are live risks, not just one.
    name: 'a leading `./` on the candidate path is normalized away',
    candidate: './apps/web/x.ts', globs: ['apps/web/**'], expected: true,
  },
  { name: 'a leading `./` on the glob itself is normalized away too', candidate: 'apps/web/x.ts', globs: ['./apps/web/**'], expected: true },
  {
    // review pass 1 / W1: the round G1 fix above only special-cased a single leading "./", which left
    // the general class open — `.//x` and `././x` still evaded a deny-list glob like
    // hotfixBarredPaths after that fix. path.posix.normalize() (not a second special case) closes it.
    name: 'a doubled leading `.//` on the candidate path is normalized away (review pass 1 / W1)',
    candidate: './/apps/web/x.ts', globs: ['apps/web/**'], expected: true,
  },
  {
    name: 'a repeated leading `././` on the candidate path is normalized away (review pass 1 / W1)',
    candidate: '././apps/web/x.ts', globs: ['apps/web/**'], expected: true,
  },
  {
    name: 'a Windows-backslash doubled/repeated leading `.\\` variant is normalized away the same way (review pass 1 / W1)',
    candidate: '.\\.\\apps\\web\\x.ts', globs: ['apps/web/**'], expected: true,
  },
  {
    // git diff --name-only always emits `/`, but a Windows user's hand-typed --hotfix --files argument
    // routinely has `\` (copied from Explorer or PowerShell tab-completion). Every glob in
    // .sdd/bounds.yml is written with `/`, so without this normalization a backslash path silently
    // evaded hotfixBarredPaths — the dangerous direction for a deny list.
    name: 'backslash path separators match a forward-slash glob (Windows-typed --files input)',
    candidate: 'apps\\web\\x.ts', globs: ['apps/web/**'], expected: true,
  },
  { name: 'a trailing slash on a directory candidate does not change the verdict', candidate: 'apps/web/', globs: ['apps/web/**'], expected: true },
  { name: 'a trailing slash after a filename candidate does not change the verdict', candidate: 'apps/web/x.ts/', globs: ['apps/web/**'], expected: true },
  { name: 'a double slash in the candidate is still contained (an empty segment consumed by `**`)', candidate: 'docs//deep.md', globs: ['docs/**'], expected: true },
  { name: '+ in a literal segment is not "one or more" (regex metacharacters matched literally)', candidate: 'apps/web/a+b.ts', globs: ['apps/web/**'], expected: true },
  { name: '() in a literal segment is not a capture group', candidate: 'apps/web/x(1).ts', globs: ['apps/web/**'], expected: true },
  { name: 'an exact literal match with parens still matches, parens and all', candidate: 'apps/web/x(1).ts', globs: ['apps/web/x(1).ts'], expected: true },
  { name: 'a near-miss literal with parens is still an exact literal, not a pattern', candidate: 'apps/web/x(2).ts', globs: ['apps/web/x(1).ts'], expected: false },
  {
    // .sdd/bounds.yml's globs are all written lowercase, matching this repo's actual (lowercase)
    // directory names. Git treats paths as exact byte/code-unit sequences regardless of the underlying
    // filesystem's case sensitivity, so a case-sensitive matcher here agrees with what git itself would
    // consider "the same path" — a case-INsensitive matcher would be the actual gap, not this.
    name: 'matching is case-sensitive, matching git\'s own path identity (deliberate — not a gap)',
    candidate: 'APPS/WEB/X.TS', globs: ['apps/web/**'], expected: false,
  },
  { name: 'Unicode characters in a segment compare literally, with no normalization', candidate: 'apps/web/☺.ts', globs: ['apps/web/**'], expected: true },
  { name: 'an empty glob matches an empty candidate', candidate: '', globs: [''], expected: true },
  { name: 'an empty glob does not match a non-empty candidate', candidate: 'x', globs: [''], expected: false },
  { name: 'a path that is a literal prefix of a glob is not, by itself, inside it', candidate: 'apps/web', globs: ['apps/web/x/**'], expected: false },
  { name: 'a glob with no wildcard does not cover paths nested under it', candidate: 'apps/web/x/y/z', globs: ['apps/web'], expected: false },
  { name: 'a very long candidate path matches without hanging', candidate: 'apps/web/' + 'a/'.repeat(3000) + 'x.ts', globs: ['apps/web/**'], expected: true },
  { name: 'a very long non-matching candidate path fails to match without hanging', candidate: 'a'.repeat(5000) + '/x.ts', globs: ['apps/web/**'], expected: false },
];

test('matchesAny: the full fuzz table for the hand-rolled glob matcher, at a glance', () => {
  for (const { name, candidate, globs, expected } of MATCHES_ANY_CASES) {
    assert.equal(matchesAny(candidate, globs), expected, name);
  }
});

test('pathological "**" chains and single-star chains do not cause catastrophic backtracking', () => {
  // This is the actual defect this fuzz pass found: the predecessor built one RegExp per glob, and a
  // glob with several unanchored '*'/'**' occurrences — even without any '**' at all, plain
  // 'a*a*a*...aZ' within a single segment — took 40+ SECONDS matched against a same-shaped,
  // non-matching candidate under 100 characters long. That is an availability failure a pure
  // true/false correctness suite would never catch: the check itself hangs, rather than returning a
  // wrong verdict. Bounding wall-clock time here turns "the fix must be sub-exponential" into an
  // assertion, not a hope — a regression back to backtracking-based matching would time out this
  // test long before the explicit assert.ok below has a chance to fail on the wrong boolean.
  const start = performance.now();

  const manyGlobstars = 'a' + '**'.repeat(30) + 'ZZZ';
  const nonMatchingCandidate1 = 'a' + 'x'.repeat(40) + 'y'.repeat(10);
  assert.equal(matchesAny(nonMatchingCandidate1, [manyGlobstars]), false);

  const manySingleStars = 'a' + '*a'.repeat(30) + 'Z';
  const nonMatchingCandidate2 = 'a'.repeat(65); // all 'a's: maximizes backtracking ambiguity
  assert.equal(matchesAny(nonMatchingCandidate2, [manySingleStars]), false);

  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 2000, `expected sub-second matching, took ${elapsedMs.toFixed(1)}ms — likely a regression to backtracking-based matching`);
});

// --- [lite] PL-11: readBounds() also reports the lite-lane size bounds ----------------------------
//
// `lanes:` fence WHICH PATHS a ticket may touch; `lite_eligibility:` bounds HOW SMALL a change must
// be before /pipeline-lite may skip `red` and `security` on it. Two different axes, one reader — the
// same "exactly one implementation of the bounds vocabulary" convention scripts/ledger-append.mjs's
// --hotfix path already relies on. The `null`-not-`die()` behavior below is load-bearing in a way a
// merely-defensive default would not be: readBounds() is imported by ledger-append.mjs's --hotfix
// path, and die() calls process.exit(2), so making this reader fatal for a fact --hotfix never uses
// would take a working bypass down over an unrelated missing block. Failing closed is the
// *consumer's* job (see the check-lite-eligible / --lite tests for where that actually happens).

const liteRoots = [];
afterEach(() => {
  while (liteRoots.length) rmSync(liteRoots.pop(), { recursive: true, force: true });
});

/** A throwaway repo carrying a copy of check-bounds.mjs, a caller-supplied .sdd/bounds.yml, and a
 * probe module that prints readBounds()'s return value — readBounds() resolves .sdd/bounds.yml from
 * its own module location, so a synthetic bounds file can only be exercised out-of-process. */
function boundsFixture(boundsYml) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-check-bounds-lite-'));
  liteRoots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'check-bounds.mjs'), readFileSync(join(HERE, 'check-bounds.mjs'), 'utf8'), 'utf8');
  writeFileSync(
    join(root, 'scripts', 'probe.mjs'),
    "import { readBounds } from './check-bounds.mjs';\nprocess.stdout.write(JSON.stringify(readBounds()));\n",
    'utf8',
  );
  mkdirSync(join(root, '.sdd'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'bounds.yml'), boundsYml, 'utf8');
  return root;
}

function probeBounds(root) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'probe.mjs')], { cwd: root, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Minimal bounds.yml in the shape readBounds() parses; `lite` is raw YAML spliced under
 * `lite_eligibility:`, or null for "the block is absent entirely". */
function syntheticBoundsYml(lite) {
  const base = [
    'version: 1',
    '',
    'lanes:',
    '  frontend:',
    '    allow:',
    '      - apps/web/**',
    '  full:',
    '    allow:',
    '      - "**"',
    '',
    'deny_for_fenced_lanes:',
    '  - .sdd/**',
    '  - CLAUDE.md',
    '',
    'hotfix_barred_paths:',
    '  - services/core/src/security/**',
    '',
  ].join('\n');
  return lite === null ? base : `${base}lite_eligibility:\n${lite}\n`;
}

// @spec AC-5
test('[lite] readBounds() reports the real .sdd/bounds.yml\'s lite_eligibility block alongside every key it already returned', () => {
  const bounds = readBounds();

  assert.deepEqual(
    bounds.liteEligibility,
    { maxFiles: 5, maxChangedLines: 150, maxLineLength: 500 },
    'the committed lite-lane bounds are the single place these numbers live — tuning them must be a reviewed diff to .sdd/bounds.yml, never a code change',
  );

  // Every pre-existing key, unchanged: this is an additive field, not a reshaping of the reader.
  assert.ok(bounds.lanes.frontend?.includes('apps/web/**'), 'the lane vocabulary must be untouched');
  assert.ok(bounds.lanes.full?.includes('**'));
  assert.ok(bounds.denyForFenced.includes('.sdd/**'));
  assert.ok(bounds.hotfixBarredPaths.includes('packages/graph-schema/**'));
});

// @spec EC-16
test('[lite] a bounds.yml with no lite_eligibility block yields liteEligibility: null — never an exit, and never a missing key', () => {
  const root = boundsFixture(syntheticBoundsYml(null));
  const { code, stdout, stderr } = probeBounds(root);
  assert.equal(code, 0, `readBounds() must not die over an absent lite block — --hotfix reads this same function and never uses the field: ${stderr}`);
  const bounds = JSON.parse(stdout);
  assert.equal(bounds.liteEligibility, null, 'null, explicitly — an absent key would read as "undefined" and could be mistaken for "not yet checked"');
  assert.ok(bounds.lanes.frontend?.includes('apps/web/**'), 'the rest of the file must still parse normally');
  assert.ok(bounds.hotfixBarredPaths.includes('services/core/src/security/**'), '--hotfix\'s own barred-path list must be unaffected');
});

// @spec EC-16
test('[lite] a malformed lite_eligibility block yields null rather than a guessed bound', () => {
  const malformed = [
    { name: 'a non-numeric max_files', yml: '  max_files: banana\n  max_changed_lines: 150\n  max_line_length: 500' },
    { name: 'max_changed_lines missing entirely', yml: '  max_files: 5\n  max_line_length: 500' },
    { name: 'max_files missing entirely', yml: '  max_changed_lines: 150\n  max_line_length: 500' },
    { name: 'a negative bound (not a non-negative integer)', yml: '  max_files: -1\n  max_changed_lines: 150\n  max_line_length: 500' },
    { name: 'a fractional bound', yml: '  max_files: 2.5\n  max_changed_lines: 150\n  max_line_length: 500' },
    // Security round FND-22ef4b5c746e: max_line_length missing entirely — valid max_files/
    // max_changed_lines alone must be just as unusable as any other half-specified block.
    { name: 'max_line_length missing entirely', yml: '  max_files: 5\n  max_changed_lines: 150' },
  ];
  for (const { name, yml } of malformed) {
    const root = boundsFixture(syntheticBoundsYml(yml));
    const { code, stdout, stderr } = probeBounds(root);
    assert.equal(code, 0, `${name}: readBounds() must stay non-fatal (${stderr})`);
    assert.equal(JSON.parse(stdout).liteEligibility, null, name);
  }
});

// @spec EC-16 AC-5
test('[lite] check-bounds.mjs\'s own CLI verdicts are unchanged by an absent lite_eligibility block', () => {
  const root = boundsFixture(syntheticBoundsYml(null));
  const cli = (args) => spawnSync(process.execPath, [join(root, 'scripts', 'check-bounds.mjs'), ...args], { cwd: root, encoding: 'utf8' });

  assert.equal(cli(['--lane', 'frontend', '--files', 'apps/web/x.tsx']).status, IN_BOUNDS);
  assert.equal(cli(['--lane', 'frontend', '--files', 'services/core/x.ts']).status, VIOLATION);
  assert.equal(cli(['--lane', 'frontend', '--files', '.sdd/bounds.yml']).status, VIOLATION);
});

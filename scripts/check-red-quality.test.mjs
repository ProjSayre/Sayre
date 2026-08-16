// Red-stage behavioral tests for PL-CI-QUAL's new scripts/check-red-quality.mjs — authored from
// .pipeline/spec.md alone, before `dev` implements the script, per .sdd/stages/red.md. Every
// assertion below traces to a spec AC-*/EC-* item, not to a diff (the diff does not exist yet).
//
// scripts/check-red-quality.mjs does not exist on this branch yet, so every test below currently
// fails at the `import` line with a Node MODULE_NOT_FOUND error — that is the correct RED-CORRECT
// failure for a script `dev` has not written yet, not a broken fixture. Once `dev` lands the file,
// each test's own assertions become the thing that must pass.
//
// Fixture strategy: the script's own documented CLI (`--dir <pipelineDir> --cwd <repoRoot>`, per
// spec's Interfaces section — the same shape check-pipeline-slim.mjs/check-lite-eligible.mjs use)
// means a fixture never has to copy scripts/pipeline-contracts.mjs into a temp tree the way
// check-red-integrity.test.mjs must (that script resolves its sibling via a relative import from
// its own real location, not from --cwd). Each test builds a throwaway repo root under mkdtemp,
// writes `.pipeline/red.json` plus whatever `scripts/*.test.mjs` fixture files it references, and
// invokes the real `scripts/check-red-quality.mjs` (once it exists) against that fixture root via
// `--cwd`/`--dir`. `afterEach` removes every root a test registered.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = resolve(scriptsDir, 'check-red-quality.mjs');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), 'check-red-quality-'));
  roots.push(root);
  return root;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** Writes `relPath` under `root`, creating parent directories as needed, and returns its sha256. */
function writeFixture(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return sha256(content);
}

function writeRedJson(root, tests, { impactMapPresent = false } = {}) {
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(join(root, '.pipeline', 'red.json'), JSON.stringify({ impactMapPresent, tests }, null, 2), 'utf8');
}

/** Runs the real (once it exists) scripts/check-red-quality.mjs against a fixture root. */
function runCli(root, extraArgs = []) {
  return spawnSync(process.execPath, [scriptPath, '--dir', join(root, '.pipeline'), '--cwd', root, ...extraArgs], {
    encoding: 'utf8',
  });
}

// A minimal, genuinely-behavioral test file: one @spec segment with one real (non-tautological)
// assertion. Used as filler content for entries whose scenario isn't about R3/R4.
function cleanSegment(specId = 'AC-1') {
  return `// @spec ${specId}\ntest('does something real', () => {\n  assert.equal(compute(), expected());\n});\n`;
}

// PL-CI-QUAL fix-loop (R1): the R3/R4 fixture content below used to embed, inside its own
// template-literal string, the literal marker comment idiom this project uses to tag a real test
// with a spec id, immediately followed by the id "AC" + "-4". This file is itself scanned by
// scripts/check-red-quality.mjs (it is red-listed in .pipeline/red.json), and that scan is plain
// text, not an AST parse (see that script's own header) — so that fixture text, sitting on the very
// next source line after this file's own real marker for a segment above it, was indistinguishable
// from a second, genuine marker. That prematurely closed the real segment above it (the marker line
// plus the one or two lines before the fixture) before reaching this test's actual assertions
// further down, which is exactly what produced a false no-assertion/tautological-only finding
// against this file's own real, behavioral tests. Interpolating the id here (never that literal
// substring), the same way `cleanSegment` above already does, removes the accidental collision
// without changing what any fixture file on disk actually contains.
const FIXTURE_SPEC_ID = 'AC-4';

// =================================================================================================
// AC-1 — CLI shape, exit codes, sourced only from red.json via readRedJson.
// =================================================================================================

// @spec AC-1
test('[red-quality] scripts/check-red-quality.mjs exists as a committed generator, never a markdown scraper', () => {
  assert.ok(existsSync(scriptPath), 'scripts/check-red-quality.mjs must exist (AC-1)');
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /readRedJson/, 'must read red.json through pipeline-contracts.mjs\'s readRedJson (AC-1)');
  assert.ok(!/\bred\.md\b/.test(source), 'must never open/parse red.md (AC-1)');
  assert.ok(!/readSpecJson|\bspec\.md\b/.test(source), 'must never re-read spec.json/spec.md (AC-1)');
});

// @spec AC-1 AC-6 EC-1
test('[red-quality] no .pipeline/red.json present: status "no-red-json", exit 0 — never a fabricated "clean"', () => {
  const root = scratchRoot();
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `expected exit 0 for no-red-json, got ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'no-red-json', 'status must be the literal "no-red-json", not "clean" (AC-6, EC-1)');
});

// @spec AC-1
test('[red-quality] a clean red.json (one file, one real assertion, no duplicates) exits 0 with status "clean"', () => {
  const root = scratchRoot();
  const hash = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-1'));
  writeRedJson(root, [{ path: 'scripts/sample-a.test.mjs', sha256: hash, specIds: ['AC-1'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `expected exit 0 on a clean input, got ${result.status}: ${result.stderr}\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'clean', 'status must be "clean" (AC-1)');
  assert.deepEqual(parsed.violations, [], 'a clean run has no violations (AC-1)');
});

// @spec AC-1 EC-2
test('[red-quality] malformed red.json (invalid JSON) exits 2 with status "error", never "clean"', () => {
  const root = scratchRoot();
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(join(root, '.pipeline', 'red.json'), '{ this is not json', 'utf8');
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 2, `expected exit 2 for malformed red.json, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /check-red-quality: /, 'stderr must be prefixed check-red-quality: (AC-1)');
});

// @spec EC-13
test('[red-quality] an unrecognized CLI flag exits 2 with a usage line, never a silent default run', () => {
  const root = scratchRoot();
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  const result = runCli(root, ['--bogus-flag']);
  assert.equal(result.status, 2, `expected exit 2 for an unknown flag, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /--bogus-flag|unrecognized|unknown/i, 'stderr must name the bad flag, not fail silently (EC-13)');
});

// @spec EC-3
test('[red-quality] a red.json-listed file that does not exist on disk exits 2 with status "error", not a reported violation', () => {
  const root = scratchRoot();
  writeRedJson(root, [{ path: 'scripts/does-not-exist.test.mjs', sha256: sha256('anything'), specIds: ['AC-1'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 2, `expected exit 2 when a listed file cannot be read, got ${result.status}: ${result.stdout}\n${result.stderr}`);
});

// =================================================================================================
// AC-2 / EC-7 / EC-8 — duplicate-spec-id and bad-duplicate-declaration.
// =================================================================================================

// @spec AC-2
test('[red-quality] a spec id cited by two entries with no duplicateOf declaration is a blocking duplicate-spec-id violation', () => {
  const root = scratchRoot();
  const hashA = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-9'));
  const hashB = writeFixture(root, 'scripts/sample-b.test.mjs', cleanSegment('AC-9'));
  writeRedJson(root, [
    { path: 'scripts/sample-a.test.mjs', sha256: hashA, specIds: ['AC-9'], classification: 'RED-CORRECT' },
    { path: 'scripts/sample-b.test.mjs', sha256: hashB, specIds: ['AC-9'], classification: 'RED-CORRECT' },
  ]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1 on an undeclared duplicate, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'violations-found', 'status must be "violations-found" (AC-2)');
  assert.ok(parsed.violations.some((v) => v.kind === 'duplicate-spec-id'), 'must report kind "duplicate-spec-id" (AC-2)');
});

// @spec AC-2
test('[red-quality] the same duplicate, with duplicateOf + justification declared on the later entry, exits 0', () => {
  const root = scratchRoot();
  const hashA = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-9'));
  const hashB = writeFixture(root, 'scripts/sample-b.test.mjs', cleanSegment('AC-9'));
  writeRedJson(root, [
    { path: 'scripts/sample-a.test.mjs', sha256: hashA, specIds: ['AC-9'], classification: 'RED-CORRECT' },
    {
      path: 'scripts/sample-b.test.mjs', sha256: hashB, specIds: ['AC-9'], classification: 'RED-CORRECT',
      duplicateOf: 'scripts/sample-a.test.mjs', justification: 'sample-b extends the AC-9 case for the Python fixture path.',
    },
  ]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `expected exit 0 with a valid duplicateOf declaration, got ${result.status}: ${result.stdout}\n${result.stderr}`);
});

// @spec EC-7
test('[red-quality] one entry listing the same spec id twice in its own specIds is a blocking duplicate-spec-id, distinguishable from the cross-file case', () => {
  const root = scratchRoot();
  const hash = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-9'));
  writeRedJson(root, [{ path: 'scripts/sample-a.test.mjs', sha256: hash, specIds: ['AC-9', 'AC-9'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const dup = parsed.violations.find((v) => v.kind === 'duplicate-spec-id');
  assert.ok(dup, 'must report duplicate-spec-id (EC-7)');
  assert.match(dup.detail, /sample-a\.test\.mjs/, 'the detail must name the offending file (EC-7)');
});

// @spec EC-8
test('[red-quality] duplicateOf naming a path absent from red.json is a blocking bad-duplicate-declaration, and the underlying duplicate is still reported', () => {
  const root = scratchRoot();
  const hashA = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-9'));
  const hashB = writeFixture(root, 'scripts/sample-b.test.mjs', cleanSegment('AC-9'));
  writeRedJson(root, [
    { path: 'scripts/sample-a.test.mjs', sha256: hashA, specIds: ['AC-9'], classification: 'RED-CORRECT' },
    {
      path: 'scripts/sample-b.test.mjs', sha256: hashB, specIds: ['AC-9'], classification: 'RED-CORRECT',
      duplicateOf: 'scripts/nonexistent-entry.test.mjs', justification: 'Bogus — this path is not in red.json at all.',
    },
  ]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.violations.some((v) => v.kind === 'bad-duplicate-declaration'), 'must report bad-duplicate-declaration (EC-8)');
  assert.ok(parsed.violations.some((v) => v.kind === 'duplicate-spec-id'), 'a bad declaration must not suppress the underlying duplicate-spec-id finding (EC-8)');
});

// =================================================================================================
// AC-3 / EC-4 / EC-5 / EC-6 — no-assertion.
// =================================================================================================

// @spec AC-3
test('[red-quality] a @spec segment with zero ASSERTION_PATTERNS matches is a blocking no-assertion violation naming file, ids, and start line', () => {
  const root = scratchRoot();
  const content = `// filler line 1\n// filler line 2\n// @spec ${FIXTURE_SPEC_ID}\n// TODO: come back and actually write this test.\nconsole.log('nothing checked here');\n`;
  const hash = writeFixture(root, 'scripts/sample-empty.test.mjs', content);
  writeRedJson(root, [{ path: 'scripts/sample-empty.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1 on an assertion-free segment, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const violation = parsed.violations.find((v) => v.kind === 'no-assertion');
  assert.ok(violation, 'must report kind "no-assertion" (AC-3)');
  assert.match(violation.detail, /sample-empty\.test\.mjs/, 'detail must name the file (AC-3)');
  assert.match(violation.detail, /AC-4/, 'detail must name the segment\'s @spec id(s) (AC-3)');
  assert.match(violation.detail, /\b3\b/, 'detail must name the segment\'s start line (line 3, the @spec marker) (AC-3)');
});

// @spec EC-4
test('[red-quality] a listed file with zero @spec markers produces no violation, appears in filesChecked, and gets a notes entry', () => {
  const root = scratchRoot();
  const hash = writeFixture(root, 'scripts/no-markers.test.mjs', `// a file that never adopted @spec markers at all\ntest('legacy', () => { assert.ok(true); });\n`);
  writeRedJson(root, [{ path: 'scripts/no-markers.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `a marker-less file is check-red-integrity.mjs's concern, not check-red-quality's (EC-4): ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.filesChecked.includes('scripts/no-markers.test.mjs'), 'the marker-less file must still appear in filesChecked (EC-4)');
  assert.ok(parsed.notes.some((n) => /no-markers\.test\.mjs/.test(n)), 'a notes entry must record the marker-less file (EC-4)');
});

// @spec EC-5
test('[red-quality] one @spec marker followed by several blocks: an assertion anywhere in the segment satisfies R3, even for a later assertion-free block', () => {
  const root = scratchRoot();
  const content = `// @spec ${FIXTURE_SPEC_ID}\ntest('first block has a real assertion', () => {\n  assert.equal(compute(), expected());\n});\n\ntest('second block in the same segment has none', () => {\n  console.log('no assertion here, but the segment already cleared R3');\n});\n`;
  const hash = writeFixture(root, 'scripts/one-marker-two-blocks.test.mjs', content);
  writeRedJson(root, [{ path: 'scripts/one-marker-two-blocks.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `a known limitation, not a violation (EC-5): ${result.status}: ${result.stdout}\n${result.stderr}`);
});

// @spec EC-6
test('[red-quality] an assertion token appearing only inside a comment/string still counts as an assertion — a documented false-negative, not a bug', () => {
  const root = scratchRoot();
  const content = `// @spec ${FIXTURE_SPEC_ID}\ntest('the string below is what is actually being tested, not a real assertion', () => {\n  const rendered = renderHelpText();\n  assertTextContains(rendered, "expect(");\n});\n`;
  const hash = writeFixture(root, 'scripts/spurious-token.test.mjs', content);
  writeRedJson(root, [{ path: 'scripts/spurious-token.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `documented false-negative, not a violation (EC-6): ${result.status}: ${result.stdout}\n${result.stderr}`);
});

// =================================================================================================
// AC-4 / EC-12 — tautological-only.
// =================================================================================================

// @spec AC-4
test('[red-quality] a segment whose only assertion is assert.ok(true) is a blocking tautological-only violation', () => {
  const root = scratchRoot();
  const content = `// @spec ${FIXTURE_SPEC_ID}\ntest('always passes', () => {\n  assert.ok(true);\n});\n`;
  const hash = writeFixture(root, 'scripts/tautology.test.mjs', content);
  writeRedJson(root, [{ path: 'scripts/tautology.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.violations.some((v) => v.kind === 'tautological-only'), 'must report kind "tautological-only" (AC-4)');
});

// @spec AC-4
test('[red-quality] a segment with one tautological assertion AND one real assertion is not flagged', () => {
  const root = scratchRoot();
  const content = `// @spec ${FIXTURE_SPEC_ID}\ntest('mostly real', () => {\n  assert.ok(true);\n  assert.equal(compute(), expected());\n});\n`;
  const hash = writeFixture(root, 'scripts/mixed-assertions.test.mjs', content);
  writeRedJson(root, [{ path: 'scripts/mixed-assertions.test.mjs', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `a segment with at least one non-tautological assertion must clear R4 (AC-4): ${result.status}: ${result.stdout}\n${result.stderr}`);
});

// @spec EC-12
test('[red-quality] Python test files: "# @spec" markers are recognized and a bare "assert True" is caught by R4', () => {
  const root = scratchRoot();
  const content = `# @spec AC-4\ndef test_always_passes():\n    assert True\n`;
  const hash = writeFixture(root, 'services/workers/tests/test_sample.py', content);
  writeRedJson(root, [{ path: 'services/workers/tests/test_sample.py', sha256: hash, specIds: ['AC-4'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, `expected exit 1 for a Python bare "assert True" (EC-12): ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.violations.some((v) => v.kind === 'tautological-only'), 'bare "assert True" must be caught by R4 (EC-12)');
});

// =================================================================================================
// AC-5 / EC-10 / EC-11 / EC-17 / EC-18 — twin-file advisory (never blocking).
// =================================================================================================

// @spec AC-5 EC-18
test('[red-quality] a new file sharing its stem with a sibling test file, no extends declared: twin-file advisory, status stays clean, exit 0', () => {
  const root = scratchRoot();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'red@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'red'], { cwd: root });
  writeFixture(root, 'scripts/widget.test.mjs', cleanSegment('AC-1'));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'baseline: widget.test.mjs'], { cwd: root });
  const hash = writeFixture(root, 'scripts/widget.extra.test.mjs', cleanSegment('AC-2'));
  writeRedJson(root, [{ path: 'scripts/widget.extra.test.mjs', sha256: hash, specIds: ['AC-2'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `an advisory must never block (AC-5, EC-18): ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'clean', 'status stays "clean" with only an advisory present (AC-5, EC-18)');
  assert.ok(parsed.advisories.some((a) => a.kind === 'twin-file'), 'must produce a twin-file advisory (AC-5)');
});

// @spec AC-5
test('[red-quality] the same twin scenario, with extends declared, suppresses the advisory', () => {
  const root = scratchRoot();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'red@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'red'], { cwd: root });
  writeFixture(root, 'scripts/widget.test.mjs', cleanSegment('AC-1'));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'baseline: widget.test.mjs'], { cwd: root });
  const hash = writeFixture(root, 'scripts/widget.extra.test.mjs', cleanSegment('AC-2'));
  writeRedJson(root, [{ path: 'scripts/widget.extra.test.mjs', sha256: hash, specIds: ['AC-2'], classification: 'RED-CORRECT', extends: 'scripts/widget.test.mjs' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.advisories, [], 'a declared extends must suppress the twin-file advisory (AC-5)');
});

// @spec EC-10
test('[red-quality] extends naming a file that does not exist on disk does not suppress the advisory, and a notes line records the dangling extends', () => {
  const root = scratchRoot();
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'red@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'red'], { cwd: root });
  writeFixture(root, 'scripts/widget.test.mjs', cleanSegment('AC-1'));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-q', '-m', 'baseline: widget.test.mjs'], { cwd: root });
  const hash = writeFixture(root, 'scripts/widget.extra.test.mjs', cleanSegment('AC-2'));
  writeRedJson(root, [{ path: 'scripts/widget.extra.test.mjs', sha256: hash, specIds: ['AC-2'], classification: 'RED-CORRECT', extends: 'scripts/does-not-exist.test.mjs' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.advisories.some((a) => a.kind === 'twin-file'), 'a dangling extends must not suppress the advisory (EC-10)');
  assert.ok(parsed.notes.some((n) => /does-not-exist\.test\.mjs/.test(n)), 'a notes line must record the dangling extends (EC-10)');
});

// @spec EC-11 EC-17
test('[red-quality] no .git directory at all (or git unavailable): R5 is skipped, a notes line says so, exit code unaffected', () => {
  const root = scratchRoot(); // deliberately never git-initialized (EC-17's own fixture requirement)
  const hash = writeFixture(root, 'scripts/sample-a.test.mjs', cleanSegment('AC-1'));
  writeRedJson(root, [{ path: 'scripts/sample-a.test.mjs', sha256: hash, specIds: ['AC-1'], classification: 'RED-CORRECT' }]);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, `a missing .git must fail R5 soft, never the whole run (EC-11, EC-17): ${result.status}: ${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.notes.some((n) => /git/i.test(n)), 'a notes line must explicitly disclose that R5 could not run (EC-11)');
});

// =================================================================================================
// EC-13 covered above (unrecognized flag). EC-1/EC-2/EC-3 covered above. EC-9/EC-14/EC-15/EC-20/
// EC-21/EC-22 and AC-7/AC-12/AC-21/AC-22 are pipeline-contracts.mjs-level and live in
// scripts/pipeline-contracts.test.mjs instead (this file's own scope per the Interfaces section is
// the evaluator/CLI, not the sidecar contract) — see that file.
// =================================================================================================

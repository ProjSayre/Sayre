// Tests scripts/build-ledger-index.mjs (PL-03c) — the .sdd/ledger/*/entry.md -> index.json
// generator, and its --check gate (spec.md acceptance criterion 8: "index.json resolves a repo
// file to the spec(s) that produced it; build-ledger-index.mjs --check fails when stale; CI
// enforces it").
//
// Conventions follow scripts/generate-agent-shims.test.mjs: node:test, tmpdir()-based fixtures, no
// new framework. Unlike the shim generator, this script never shells out to git, so fixtures don't
// need to be real git repos — just a scripts/ copy of the script plus a .sdd/ledger/ tree.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { extractSection } from './build-ledger-index.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptSource = readFileSync(resolve(scriptsDir, 'build-ledger-index.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

// --- Direct unit tests of extractSection (review Critical 1) ------------------------------------
//
// extractSection is a pure function (no filesystem/process side effects — guarded by the
// only-run-as-CLI-entry-point check at the bottom of build-ledger-index.mjs), so importing it
// directly here gives the most precise regression coverage of the actual regex, rather than only
// exercising it indirectly through a fixture + subprocess. These fixtures reproduce review's exact
// repro cases, not the well-formed "##-only" shape every other fixture in this suite used — that
// uniformity ("fixture monoculture") is exactly why the original bug went uncaught.

test('extractSection: a "### Verdict" (h3) shadow above the real "## Verdict" does not shadow it', () => {
  const markdown = '# Review\n\n### Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a "#### Verdict" (h4) shadow above the real "## Verdict" does not shadow it', () => {
  const markdown = '# Review\n\n#### Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: inline prose reading "see ## Verdict" then "PASS" on the next line is not treated as a heading', () => {
  // No real "## Verdict" heading exists anywhere in this document — only text that happens to
  // contain the substring "## Verdict" mid-line, immediately followed by a line reading "PASS".
  // Before the anchor fix, String.match's unanchored search found this as the first (and only)
  // match and returned "PASS" as if it were a real section.
  const markdown = '# Review\n\nSome analysis, see ## Verdict\nPASS\n\n## Critical\nNone found.\n';
  assert.equal(extractSection(markdown, 'Verdict'), null);
});

test('extractSection: a heading containing regex metacharacters ("(SHA-256)") is escaped, not interpreted as a group', () => {
  const markdown = '## Content hashes (SHA-256)\n- scripts/foo.mjs: ' + 'a'.repeat(64) + '\n\n## Test paths\n- scripts/foo.mjs\n';
  assert.equal(extractSection(markdown, 'Content hashes (SHA-256)'), '- scripts/foo.mjs: ' + 'a'.repeat(64));
});

test('extractSection: a real "## Verdict" heading with no false shadow still resolves correctly (control case)', () => {
  const markdown = '# Review\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a nested "### Subsection" inside the real section does not prematurely terminate it', () => {
  const markdown = '## Verdict\n\n**PASS**\n\n### Sub-detail\nmore text\n\n## Critical\nNone.\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**PASS**\n\n### Sub-detail\nmore text');
});

// --- Adversarial sweep (tester round 2, post-Critical-1-fix): the `^##[ \t]+` anchor rules out
// ###/#### depth and mid-line-prose shadowing, but it has no awareness of markdown structure beyond
// "is this literally the first thing on its line." These fixtures probe shadow vectors the anchor
// does not rule out. Each is written to assert the SAFE/correct outcome (resolve the real, final
// section) — where the assertion currently fails, that is not a test bug; it is an unresolved defect
// reproducing Critical 1's exact failure class through a vector review's own repro did not exercise.
// See test-results.md for the full writeup and severity.

// PL-03c round 3: the fix landed for these three vectors is a *count check* (extractSection now
// throws whenever a heading appears more than once anywhere in the document, at line-start, however
// it got there) rather than fence/comment-aware markdown parsing that could *resolve* to the correct
// final heading. That closes the underlying failure (a ledger entry recording a false PASS — see the
// full-script regression tests in ledger-append.test.mjs, which now correctly refuse and pass
// unmodified), but it means extractSection called directly, as here, now throws instead of returning
// the real, final section's text — a different (and, for these three inputs, out-of-scope-this-round)
// outcome than the one these three tests assert. Marked skipped rather than deleted or weakened, per
// instruction; full fence/comment-aware resolution is tracked as PL-03h.

test('OPEN GAP: extractSection is not fenced-code-block aware — a "## Verdict" line fabricated inside a ``` block still shadows the real section', { skip: 'extractSection now refuses (throws) on any repeated heading rather than resolving to the real one — resolving instead of refusing is fence-aware parsing, out of scope this round; see PL-03h.' }, () => {
  const markdown = '# Review\n\n```\n## Verdict\n\nPASS\n```\n\nSome analysis of the failed run.\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('OPEN GAP: extractSection is not HTML-comment aware — a "## Verdict" line fabricated inside <!-- --> still shadows the real section', { skip: 'extractSection now refuses (throws) on any repeated heading rather than resolving to the real one — resolving instead of refusing is comment-aware parsing, out of scope this round; see PL-03h.' }, () => {
  const markdown = '# Review\n\n<!--\n## Verdict\n\nPASS\n-->\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('OPEN GAP: two genuine, equally well-formed "## Verdict" headings — the FIRST wins, which can be stale/draft content rather than the final real one', { skip: 'extractSection now refuses (throws) whenever a heading is duplicated, rather than picking the final one — picking "the real, final" heading instead of refusing is out of scope this round; see PL-03h.' }, () => {
  // Both headings here satisfy the anchor exactly as designed (real, level-2, line-start). The
  // anchor only disambiguates by depth/position; it says nothing about which of two same-depth,
  // same-name headings should win when a document legitimately (or accidentally) has both, e.g. a
  // reviewer's draft PASS left in place above the final, corrected NEEDS_FIXES verdict.
  const markdown = '# Review\n\n## Verdict\n\nPASS\n\n(stray leftover draft text from an earlier revision)\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

// PL-03c round 3: what extractSection actually does for the three vectors above — refuses (throws),
// naming the count and the 1-based line number of every match, rather than resolving to either
// heading. This is what the full-script regression tests in ledger-append.test.mjs rely on (a
// terminal-PASS attempt against any of these three review.md shapes must refuse and write no ledger
// entry), verified here at the unit level for the exact count/line-number reporting.

test('extractSection throws, naming both line numbers, when a "## Verdict" line fabricated inside a fenced code block sits above the real one', () => {
  const markdown = '# Review\n\n```\n## Verdict\n\nPASS\n```\n\nSome analysis of the failed run.\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.throws(() => extractSection(markdown, 'Verdict'), /"## Verdict" appears 2 times \(line\(s\) 4, 11\)/);
});

test('extractSection throws, naming both line numbers, when a "## Verdict" line fabricated inside an HTML comment sits above the real one', () => {
  const markdown = '# Review\n\n<!--\n## Verdict\n\nPASS\n-->\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.throws(() => extractSection(markdown, 'Verdict'), /"## Verdict" appears 2 times \(line\(s\) 4, 9\)/);
});

test('extractSection throws, naming both line numbers, when two genuine "## Verdict" headings both appear', () => {
  const markdown = '# Review\n\n## Verdict\n\nPASS\n\n(stray leftover draft text from an earlier revision)\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.throws(() => extractSection(markdown, 'Verdict'), /"## Verdict" appears 2 times \(line\(s\) 3, 9\)/);
});

test('extractSection: "##Verdict" with no space after the hashes is not treated as a heading at all (correct, fails closed — matches CommonMark ATX heading rules)', () => {
  const markdown = '# Review\n\n##Verdict\n\nPASS\n';
  assert.equal(extractSection(markdown, 'Verdict'), null);
});

test('extractSection: trailing whitespace after the heading text on the same line is tolerated', () => {
  const markdown = '# Review\n\n## Verdict   \n\nPASS\n';
  assert.equal(extractSection(markdown, 'Verdict'), 'PASS');
});

test('extractSection: a document using \\r\\n line endings throughout still extracts correctly (Windows checkout)', () => {
  const markdown = '# Review\r\n\r\n## Verdict\r\n\r\n**NEEDS_FIXES**\r\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a heading immediately followed by another heading (no content between them) returns an empty string, not null', () => {
  const markdown = '# Review\n\n## Verdict\n\n## Critical\nSome critical.\n';
  assert.equal(extractSection(markdown, 'Verdict'), '');
});

test('extractSection: a section at the true end of the file with no trailing newline at all is still extracted correctly', () => {
  const markdown = '# Review\n\n## Verdict\n\n**NEEDS_FIXES**';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

// --- Regression (review round 3 Critical 1, fixed round 4): the counter and the extractor used to
// be two independently-configured regexes (no flags + \r?\n split vs. `im` flags), so a shadow that
// differed from the real heading only in case, or that sat on the far side of a lone `\r`/`U+2028`/
// `U+2029` (none of which the counter's `\r?\n` split treats as a line break), was invisible to the
// counter (which still counted exactly one heading — the real one) while fully matchable by the old
// `im`-flagged extractor, producing a false "PASS". Now that extraction slices by the counter's own
// line index, the shadow line fails the *counter's* heading test too — it was never a real second
// occurrence — so these resolve correctly to the real, final section rather than merely refusing.

test('extractSection: a "## verdict" (lowercase) shadow above the real "## Verdict" is not case-insensitively matched — resolves to the real section, never the shadow\'s "PASS"', () => {
  const markdown = '# Review\n\n## verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a "## VERDICT" (all-caps) shadow above the real "## Verdict" is not case-insensitively matched — resolves to the real section, never the shadow\'s "PASS"', () => {
  const markdown = '# Review\n\n## VERDICT\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a lone "\\r" (not "\\r\\n") ahead of a fabricated "## Verdict" line does not create a second line the extractor can see — resolves to the real section, never "PASS"', () => {
  const markdown = '# Review\n\nintro\r## Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a U+2028 (LINE SEPARATOR) ahead of a fabricated "## Verdict" line does not create a second line the extractor can see — resolves to the real section, never "PASS"', () => {
  const markdown = '# Review\n\nintro ## Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: a U+2029 (PARAGRAPH SEPARATOR) ahead of a fabricated "## Verdict" line does not create a second line the extractor can see — resolves to the real section, never "PASS"', () => {
  const markdown = '# Review\n\nintro ## Verdict\n\nPASS\n\n## Verdict\n\n**NEEDS_FIXES**\n';
  assert.equal(extractSection(markdown, 'Verdict'), '**NEEDS_FIXES**');
});

test('extractSection: title-case "## Files Changed" above sentence-case "## Files changed" — a realistic multi-round changes.md, not adversarial input — resolves to the real, final section rather than the stale one', () => {
  const markdown = '# Changes\n\n## Files Changed\n\n- `stale/round1.ts`\n\n## Files changed\n\n- `real/round3.ts`\n';
  assert.equal(extractSection(markdown, 'Files changed'), '- `real/round3.ts`');
});

function sampleEntry(files, { ticket = 'PL-03c', date = '2026-08-03' } = {}) {
  return `# Ledger entry — sample-run

## Date
${date}

## Ticket
${ticket}

\`red\` stage, tester rewire, and the durable spec ledger

## Spec Goal
Make behavioral tests precede implementation, and make every accepted spec durable and queryable.

## Files touched
${files.map((file) => `- ${file}`).join('\n')}

## Verdicts
- review: PASS
- security: PASS

## Red-test paths
- scripts/some.test.mjs

## Security run ID
.pipeline/security-history/sample-run/

## Commit
deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
`;
}

/** Builds a throwaway fixture directory containing a copy of the generator and a caller-supplied
 * .sdd/ledger/ tree. `runs` maps run id -> { entry, spec } (spec defaults to a trivial stub). */
function fixture(runs) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-index-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), scriptSource, 'utf8');
  mkdirSync(join(root, '.sdd', 'ledger'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'README.md'), '# Ledger\n\nFixture placeholder.\n', 'utf8');
  for (const [runId, files] of Object.entries(runs)) {
    const runDir = join(root, '.sdd', 'ledger', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'entry.md'), files.entry, 'utf8');
    writeFileSync(join(runDir, 'spec.md'), files.spec ?? '# Spec\n\nFixture stub.\n', 'utf8');
  }
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'build-ledger-index.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

// --- AC 8: index.json resolves a repo file to the spec(s) that produced it ---------------------

test('builds index.json mapping each touched file to its run, ticket, date, and spec path', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['scripts/foo.mjs', 'scripts/bar.mjs']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index).sort(), ['scripts/bar.mjs', 'scripts/foo.mjs']);
  assert.deepEqual(index['scripts/foo.mjs'], [
    { runId: 'run-a', ticket: 'PL-03c', date: '2026-08-03', spec: '.sdd/ledger/run-a/spec.md' },
  ]);
});

test('a file touched by two runs gets both entries, sorted by run id (chronological by construction)', () => {
  const root = fixture({
    '20260801T000000000Z-later': { entry: sampleEntry(['shared/thing.ts']) },
    '20260701T000000000Z-earlier': { entry: sampleEntry(['shared/thing.ts']) },
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(
    index['shared/thing.ts'].map((entry) => entry.runId),
    ['20260701T000000000Z-earlier', '20260801T000000000Z-later'],
  );
});

test('a file untouched by any run is simply absent from the index', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['scripts/foo.mjs']) } });
  run(root);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.ok(!('scripts/never-touched.mjs' in index));
});

test('README.md alongside run directories is a file, not a run, and is never mistaken for one', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['x.ts']) } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.equal(index['x.ts'][0].runId, 'run-a');
});

// --- AC 8: --check exits 0 on a clean tree, non-zero (and never writes) after drift -------------

test('--check exits 0 once a freshly generated index.json is up to date', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['x.ts']) } });
  run(root);
  const check = run(root, ['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /up to date/);
});

test('--check exits non-zero when a new run has been added but index.json was not regenerated', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['x.ts']) } });
  run(root);

  const runBDir = join(root, '.sdd', 'ledger', 'run-b');
  mkdirSync(runBDir, { recursive: true });
  writeFileSync(join(runBDir, 'entry.md'), sampleEntry(['y.ts']), 'utf8');
  writeFileSync(join(runBDir, 'spec.md'), '# Spec\n', 'utf8');

  const before = readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8');
  const check = run(root, ['--check']);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /stale/);
  assert.equal(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'), before, '--check must never write');
});

// --- Edge case: a run directory missing spec.md fails loudly rather than silently indexing -----

test('fails loudly, and writes nothing, when a run directory has no spec.md', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['x.ts']) } });
  rmSync(join(root, '.sdd', 'ledger', 'run-a', 'spec.md'));
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no spec\.md/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

test('fails loudly when a run directory has no entry.md', () => {
  const root = fixture({});
  mkdirSync(join(root, '.sdd', 'ledger', 'run-a'), { recursive: true });
  writeFileSync(join(root, '.sdd', 'ledger', 'run-a', 'spec.md'), '# Spec\n', 'utf8');
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no entry\.md/);
});

// --- Edge case: no .sdd/ledger/ directory at all produces an empty index, not a crash ----------

test('no .sdd/ledger/ directory at all still produces a valid (empty) index.json', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-ledger-index-empty-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), scriptSource, 'utf8');

  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-ledger-index.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(index, {});
});

// --- Edge case / AC 8: byte-stability across LF/CRLF (the .gitattributes point) -----------------

test('generated index.json is unconditionally LF, never CRLF, regardless of host platform', () => {
  const root = fixture({ 'run-a': { entry: sampleEntry(['x.ts']) } });
  run(root);
  const buffer = readFileSync(join(root, '.sdd', 'ledger', 'index.json'));
  assert.ok(!buffer.includes(0x0d), 'generated index.json must contain no CR bytes');
});

test('.gitattributes pins LF on .sdd/ledger/index.json so --check is byte-stable on Windows', () => {
  const gitattributes = readFileSync(resolve(repoRoot, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /\.sdd\/ledger\/index\.json\s+text\s+eol=lf/);
});

// --- Regression (review Critical 1): extractSection must not be shadowed by ###/#### or inline --
// prose "##" that merely resembles a heading. Every fixture up to this point in the suite is
// well-formed ##-only markdown (the "fixture monoculture" review named as the reason the original
// bug went uncaught) — these fixtures are deliberately malformed/adversarial instead.

/** A raw entry.md string, not run through sampleEntry(), so the heading shape (and any deliberately
 * malformed heading above the real one) is fully explicit in each test. */
function rawEntry({ ticket = 'PL-03c', date = '2026-08-03', filesTouchedBlock, verdictsBlock = '- review: PASS\n- security: PASS' } = {}) {
  return `# Ledger entry — sample-run

## Date
${date}

## Ticket
${ticket}

Sample spec title

## Spec Goal
Sample goal.

${filesTouchedBlock}

## Verdicts
${verdictsBlock}

## Red-test paths
- scripts/some.test.mjs

## Security run ID
.pipeline/security-history/sample-run/

## Commit
deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
`;
}

test('a "### Files touched" (h3) shadow above the real "## Files touched" does not hide the real section', () => {
  const entry = rawEntry({
    filesTouchedBlock: '### Files touched\n- scripts/fake-shadowed-file.mjs\n\n## Files touched\n- scripts/real-file.mjs',
  });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/real-file.mjs']);
  assert.ok(!('scripts/fake-shadowed-file.mjs' in index), 'the h3 shadow section must never be indexed as if it were the real ## Files touched');
});

test('a "#### Files touched" (h4) shadow above the real "## Files touched" does not hide the real section', () => {
  const entry = rawEntry({
    filesTouchedBlock: '#### Files touched\n- scripts/fake-shadowed-file.mjs\n\n## Files touched\n- scripts/real-file.mjs',
  });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/real-file.mjs']);
});

test('inline prose mentioning "## Files touched" (not at line start) is never mistaken for the real heading', () => {
  const entry = rawEntry({
    filesTouchedBlock: 'See the note above about ## Files touched\n- scripts/fake-shadowed-file.mjs\n\n## Files touched\n- scripts/real-file.mjs',
  });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/real-file.mjs']);
});

// --- Regression: extractSection must not choke on a heading containing regex metacharacters ------
// (needed for scripts/check-red-integrity.mjs's "Content hashes (SHA-256)" heading).

test('a heading containing regex metacharacters ("(SHA-256)") is matched literally, not as a broken regex', () => {
  const entry = `# Ledger entry — sample-run

## Date
2026-08-03

## Ticket
PL-03c

## Content hashes (SHA-256)
- scripts/foo.mjs: ${'a'.repeat(64)}

## Files touched
- scripts/foo.mjs

## Verdicts
- review: PASS
- security: PASS

## Red-test paths
- scripts/some.test.mjs

## Security run ID
.pipeline/security-history/sample-run/

## Commit
deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
`;
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(join(root, '.sdd', 'ledger', 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index), ['scripts/foo.mjs']);
});

// --- Regression (review Warning 1): a malformed/fabricated "## Verdicts" section must refuse, ----
// not silently index a run that never really passed both gates.

test('fails loudly when an entry\'s "## Verdicts" section does not read exactly review: PASS / security: PASS', () => {
  const entry = rawEntry({ verdictsBlock: '- review: PASS\n- security: BLOCKED' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
  assert.ok(!existsSync(join(root, '.sdd', 'ledger', 'index.json')));
});

test('fails loudly when an entry has no "## Verdicts" section at all', () => {
  const entry = rawEntry().replace(/## Verdicts\n- review: PASS\n- security: PASS\n\n/, '');
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no "## Verdicts" section at all/);
});

test('a hand-authored entry whose only earlier "Verdicts"-looking text is a "### Verdicts" shadow is still refused unless the real "## Verdicts" section is clean', () => {
  // Reproduces the exact shape of Critical 1's bug for this heading: a shadow section reporting a
  // fabricated pass, with the real (honest) section beneath it reporting the truth.
  const entry = rawEntry({
    filesTouchedBlock: '## Files touched\n- scripts/real-file.mjs',
  }).replace('## Verdicts\n- review: PASS\n- security: PASS', '### Verdicts\n- review: PASS\n- security: PASS\n\n## Verdicts\n- review: NEEDS_FIXES\n- security: PASS');
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0, 'the real (post-fix) ## Verdicts section reports NEEDS_FIXES and must refuse, not be shadowed by the fake ### Verdicts section reporting PASS');
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

// --- Adversarial sweep (tester round 2): assertVerdictsAreClean must not be satisfiable by ------
// anything that merely *looks like* the two clean PASS lines — extra whitespace, a different bullet
// character, a unicode lookalike, or a trailing third line. All of these are refused because the
// check is exact string equality against the full section, not a shape/regex check.

test('assertVerdictsAreClean refuses trailing whitespace on a verdict line', () => {
  const entry = rawEntry({ verdictsBlock: '- review: PASS \n- security: PASS' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

test('assertVerdictsAreClean refuses a different bullet character (*) even though it renders identically as a markdown list', () => {
  const entry = rawEntry({ verdictsBlock: '* review: PASS\n* security: PASS' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

test('assertVerdictsAreClean refuses a visually-identical unicode lookalike (Cyrillic А, U+0410, in place of Latin A)', () => {
  const entry = rawEntry({ verdictsBlock: '- review: PАSS\n- security: PASS' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

test('assertVerdictsAreClean refuses a third line appended after the two clean PASS lines', () => {
  const entry = rawEntry({ verdictsBlock: '- review: PASS\n- security: PASS\n- extra: unexpected' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

test('assertVerdictsAreClean refuses mid-section leading whitespace on the second line (only the whole-section outer trim is tolerated, never a per-line one)', () => {
  const entry = rawEntry({ verdictsBlock: '- review: PASS\n - security: PASS' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"## Verdicts" section must read exactly/);
});

test('assertVerdictsAreClean tolerates a single leading space before the very first line, since extractSection trims the whole section as a block (not a bypass — the trimmed value is identical either way)', () => {
  const entry = rawEntry({ verdictsBlock: ' - review: PASS\n- security: PASS' });
  const root = fixture({ 'run-a': { entry } });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

// --- Integration: the real repository's real ledger index, as it exists on disk right now ------

test('[integration] the real repo\'s .sdd/ledger/index.json is currently up to date', () => {
  const result = spawnSync(process.execPath, [resolve(scriptsDir, 'build-ledger-index.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `real repo ledger index is stale: ${result.stderr}`);
});

test('[integration] the real repo\'s ledger index resolves at least PL-03a\'s migrated entry', () => {
  const index = JSON.parse(readFileSync(resolve(repoRoot, '.sdd', 'ledger', 'index.json'), 'utf8'));
  const anyEntry = Object.values(index)[0];
  assert.ok(Array.isArray(anyEntry) && anyEntry.length > 0, 'expected at least one indexed file');
  assert.ok(anyEntry[0].runId && anyEntry[0].ticket && anyEntry[0].date && anyEntry[0].spec);
});

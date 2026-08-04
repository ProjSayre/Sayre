// Tests scripts/check-red-integrity.mjs (PL-03c review Critical 3) — the mechanical half of
// .sdd/stages/review.md's "Red-test integrity" and "Spec trace" checks: rehashing every file
// red.md lists and resolving every @spec marker against spec.md's AC-*/EC-* items.
//
// The script computes its own repoRoot as resolve(<its own directory>, '..') and imports its
// sibling build-ledger-index.mjs by relative path, so exercising it in isolation means copying
// both files into a throwaway fixture repo and running it there — same approach as
// scripts/ledger-append.test.mjs, whose fixture-repo/afterEach-cleanup conventions this file
// follows. Unlike ledger-append.mjs's fixtures, several tests here also need real test files
// physically present on disk (the script hashes and greps them), not just markdown describing them.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const checkRedIntegritySource = readFileSync(resolve(scriptsDir, 'check-red-integrity.mjs'), 'utf8');
const buildIndexSource = readFileSync(resolve(scriptsDir, 'build-ledger-index.mjs'), 'utf8');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function specMarkdown({ ticket = 'PL-99z', acItems = ['AC-1'], ecItems = [] } = {}) {
  const ac = acItems.map((id, i) => `${i + 1}. **${id}** — sample acceptance criterion ${i + 1}.`).join('\n');
  const ec = ecItems.length ? ecItems.map((id, i) => `- **${id}** — sample edge case ${i + 1}.`).join('\n') : '- none';
  return `# ${ticket} — Sample ticket\n\n## Goal\nSample goal.\n\n## Acceptance criteria\n\n${ac}\n\n## Edge cases\n\n${ec}\n`;
}

/** `contentHashes` may be pre-computed by the caller (to deliberately record a *wrong* hash); when
 * omitted, each listed test's real on-disk content is hashed so the fixture starts consistent. */
function redMarkdown({ tests, impactMap = 'Absent — PL-03b is unbuilt.', includeImpactMap = true, includeContentHashesFor = null } = {}) {
  const lines = [];
  if (includeImpactMap) {
    lines.push('## Impact map', impactMap, '');
  }
  lines.push('## Test paths', ...tests.map((t) => `- ${t.path}`), '');
  lines.push('## @spec mapping', ...tests.map((t) => `- ${t.path}: ${t.specMappingIds ?? t.ids.join(', ')}`), '');
  lines.push('## Observed failure output', ...tests.flatMap((t) => [`### ${t.path}`, 'AssertionError: expected behavior missing', '']));
  lines.push('## Classification', ...tests.map((t) => `- ${t.path}: RED-CORRECT`), '');
  const hashTests = includeContentHashesFor ?? tests;
  lines.push('## Content hashes (SHA-256)', ...hashTests.map((t) => `- ${t.path}: ${t.hash}`), '');
  return lines.join('\n');
}

function changesMarkdown({ redTestChanges = null } = {}) {
  const lines = ['# Changes', '', '## Files changed', '- `app/existing.ts` — sample reason', ''];
  if (redTestChanges !== null) {
    lines.push('## Red-test changes', redTestChanges, '');
  }
  return lines.join('\n');
}

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'check-red-integrity-test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Check Red Integrity Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
}

/** Builds a throwaway fixture repo with the script + its sibling dependency, real test files on
 * disk at each of `tests[].path` (so hashing/grepping has something real to read), and
 * caller-supplied .pipeline/ markdown. `pipeline` maps a path relative to .pipeline/ to contents;
 * omit a key (e.g. `red.md`, `changes.md`) to simulate that file's absence. */
function fixtureRepo({ tests = [], pipeline = {}, commit = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-check-red-integrity-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'check-red-integrity.mjs'), checkRedIntegritySource, 'utf8');
  writeFileSync(join(root, 'scripts', 'build-ledger-index.mjs'), buildIndexSource, 'utf8');

  for (const t of tests) {
    const dest = join(root, t.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, t.content, 'utf8');
  }

  for (const [relPath, contents] of Object.entries(pipeline)) {
    const dest = join(root, '.pipeline', relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents, 'utf8');
  }

  initGit(root);
  if (commit) {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'initial fixture state'], { cwd: root });
  }
  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-red-integrity.mjs')], { cwd: root, encoding: 'utf8' });
}

/** A single well-formed test file's content: a real @spec marker in the file's own native comment
 * idiom, plus a trivial assertion body — enough for the script's own content-hashing/grepping to
 * have something realistic to read. */
function testFileContent(path, ids) {
  const marker = path.endsWith('.py') ? `# @spec ${ids.join(' ')}` : `// @spec ${ids.join(' ')}`;
  return `${marker}\ntest('sample', () => { /* body */ });\n`;
}

function oneTestFixture({ path = 'scripts/sample.test.mjs', ids = ['AC-1'], content } = {}) {
  const body = content ?? testFileContent(path, ids);
  return { path, content: body, hash: sha256(body), ids };
}

// --- Happy path: clean red.md, matching hashes, resolvable @spec IDs ----------------------------

test('exits 0 with no violations on a clean, well-formed red.md', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no violations found/);
});

// --- Absence: no .pipeline/red.md is a legitimate state, not a failure --------------------------

test('exits 0 when .pipeline/red.md does not exist for this run', () => {
  const root = fixtureRepo({ pipeline: { 'spec.md': specMarkdown() } });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to check/);
});

// --- Red-test integrity: undeclared hash mismatch fails; declared hash mismatch does not --------

test('fails when a listed test file\'s content changed and changes.md does not declare it', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  // Mutate the file on disk after the fixture (and its hash) were committed — the real-world
  // scenario this check exists to catch.
  writeFileSync(join(root, t.path), t.content + '// a quiet, undeclared edit\n', 'utf8');

  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1 violation/);
  assert.match(result.stdout, /does not declare this change/);
});

test('does not fail (but does report) when a hash mismatch is declared in changes.md\'s "## Red-test changes" section', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
      'changes.md': changesMarkdown({ redTestChanges: `- \`${t.path}\` — the spec's signature was wrong; amended and the test updated to match.` }),
    },
  });
  writeFileSync(join(root, t.path), t.content + '// a declared, legitimate edit\n', 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /declared in changes.md/);
});

test('fails when a listed test file no longer exists on disk at all', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
    commit: false,
  });
  rmSync(join(root, t.path));
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /no longer exists on disk/);
});

test('fails when a test path is listed under "## Test paths" but has no recorded hash', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t], includeContentHashesFor: [] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /has no recorded hash/);
});

test('fails when a test path is listed in red.md but the file was never created on disk at all (not merely deleted after being recorded)', () => {
  const phantomPath = 'scripts/phantom-never-existed.test.mjs';
  const root = fixtureRepo({
    tests: [], // nothing is ever written to disk at phantomPath
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': `## Impact map\nAbsent.\n\n## Test paths\n- ${phantomPath}\n\n## @spec mapping\n- ${phantomPath}: AC-1\n\n## Content hashes (SHA-256)\n- ${phantomPath}: ${'b'.repeat(64)}\n`,
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /no longer exists on disk/);
});

// --- OPEN GAP: a hash recorded for a path that later becomes a directory ------------------------
// PL-03c round 3: explicitly out of scope this round (the EISDIR crash, finding 5) — it already
// fails closed on exit code, and fixing the crash itself is unrelated to Fix 1's heading-count
// check. Tracked as PL-03h. Marked skipped rather than deleted or weakened.
test('OPEN GAP: a hash recorded for a path that has since become a directory should report a controlled violation, not crash with an uncaught EISDIR exception', { skip: 'Out of scope this round (finding 5) — already fails closed on exit code; a controlled, non-crashing message is tracked as PL-03h.' }, () => {
  const path = 'scripts/became-a-dir.test.mjs';
  const root = fixtureRepo({
    tests: [],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': `## Impact map\nAbsent.\n\n## Test paths\n- ${path}\n\n## @spec mapping\n- ${path}: AC-1\n\n## Content hashes (SHA-256)\n- ${path}: ${'a'.repeat(64)}\n`,
    },
    commit: false,
  });
  mkdirSync(join(root, path), { recursive: true }); // the recorded path is now a directory, not a file
  const result = runCheck(root);
  // Safe minimum: must not exit 0 (it doesn't — see below). But the *correct* behavior is a
  // controlled violation message identifying the path as a directory, printed through this script's
  // own JSON-report contract, not an unhandled EISDIR crash before any report is printed at all. As
  // of this test run the script crashes with a raw Node stack trace (readFileSync on a directory) —
  // it fails closed on exit code alone, but breaks the "review adjudicates the printed report"
  // contract, since there is no report. See test-results.md.
  assert.notEqual(result.status, 0, 'must not exit 0 when a recorded path is actually a directory');
  assert.match(result.stderr, /is a directory, not a file/i);
});

// --- Spec trace: missing or unresolvable @spec markers -------------------------------------------

test('fails when a listed test cites no "@spec" marker at all (neither mapping nor file content)', () => {
  const t = oneTestFixture({ content: 'test(\'sample\', () => {});\n' }); // no @spec marker in the file
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      // @spec mapping section still needs a line for this path, but with no IDs, to isolate "marker
      // absent" from "line absent" — pass ids: [] and don't fall back to a truthy join.
      'red.md': redMarkdown({ tests: [{ ...t, specMappingIds: '' }] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites no "@spec" marker at all/);
});

test('fails when a cited @spec ID does not resolve to a real AC-*/EC-* item in spec.md', () => {
  const t = oneTestFixture({ ids: ['AC-99'] });
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }), // AC-99 is not a real item
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites "@spec AC-99", which does not resolve/);
});

test('resolves an @spec marker against an Edge case ID, not only Acceptance criteria', () => {
  const t = oneTestFixture({ ids: ['EC-3'] });
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'], ecItems: ['EC-1', 'EC-2', 'EC-3'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

// PL-03c round 3: explicitly out of scope this round (the @spec code-block laundering, finding 4)
// — fixing extractKnownSpecIds to be fence-aware is the same class of structural-markdown-parsing
// work as Fix 1's fence/comment vectors, and is deliberately not attempted narrowly here. Tracked as
// PL-03h. Marked skipped rather than deleted or weakened.
test('OPEN GAP: an @spec ID that appears in spec.md\'s Acceptance criteria section only inside a fenced code example (not as an actual criterion) is wrongly treated as resolvable', { skip: 'Out of scope this round (finding 4) — fence-aware spec.md parsing is the complete fix, tracked as PL-03h.' }, () => {
  const t = oneTestFixture({ path: 'scripts/laundered.test.mjs', ids: ['AC-77'] });
  // Only AC-1 is a real acceptance criterion. AC-77 appears in the same section, but purely as an
  // illustrative code example of the marker format — never as an actual numbered/bulleted item.
  const specWithCodeExample = '# PL-99z — Sample ticket\n\n## Goal\nSample goal.\n\n## Acceptance criteria\n\n' +
    '1. **AC-1** — sample acceptance criterion 1.\n\nExample marker format:\n```\n// @spec AC-77\n```\n\n' +
    '## Edge cases\n\n- none\n';
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specWithCodeExample,
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  // Correct/safe behavior: AC-77 is not a real acceptance criterion and must not resolve.
  // extractKnownSpecIds greps raw section text with no fenced-code-block awareness, so a token that
  // only ever appears inside a code *example* in the same section is currently laundered as if it
  // were a real, resolvable ID — a hallucinated or stale @spec reference that happens to match
  // example text in the spec would pass this check today. See test-results.md.
  assert.notEqual(result.status, 0, 'AC-77 only appears in a code example, not as a real acceptance criterion, and must not resolve');
});

test('fails closed on case variance in an @spec ID (lowercase "ac-1" does not resolve against the real, uppercase "AC-1")', () => {
  const path = 'scripts/case-variance.test.mjs';
  const content = '// @spec ac-1\ntest(\'sample\', () => {});\n';
  const t = { path, content, hash: sha256(content), ids: ['ac-1'] };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites "@spec ac-1", which does not resolve/);
});

test('a test citing two @spec IDs where only one is valid is flagged precisely for the invalid one, and the valid one is never also flagged', () => {
  const path = 'scripts/mixed-ids.test.mjs';
  const content = '// @spec AC-1 AC-99\ntest(\'sample\', () => {});\n';
  const t = { path, content, hash: sha256(content), ids: ['AC-1', 'AC-99'] };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cites "@spec AC-99", which does not resolve/);
  assert.ok(!result.stderr.includes('"@spec AC-1"'), 'the valid AC-1 citation must never also be flagged as a violation');
});

test('a test citing two @spec IDs (one per source) resolves both — from red.md\'s mapping and from the file\'s own marker', () => {
  // The file itself only carries "@spec AC-1"; red.md's own mapping additionally claims "EC-2" for
  // this path — the union of both sources must be checked, not either one alone.
  const path = 'scripts/two-ids.test.mjs';
  const content = testFileContent(path, ['AC-1']);
  const t = { path, content, hash: sha256(content), ids: ['AC-1'], specMappingIds: 'AC-1, EC-2' };
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'], ecItems: ['EC-2'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

// --- red.md's own internal integrity: Impact map and RED-BROKEN ----------------------------------

test('fails when red.md has no "## Impact map" section at all', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t], includeImpactMap: false }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no "## Impact map" section/);
});

test('fails when red.md\'s "## Impact map" section is present but empty', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t], impactMap: '' }),
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no "## Impact map" section/);
});

test('fails when red.md contains a "RED-BROKEN" entry anywhere in the document', () => {
  const t = oneTestFixture();
  const base = redMarkdown({ tests: [t] });
  const withBroken = base.replace('## Classification\n', '## Classification\n- scripts/other.test.mjs: RED-BROKEN — bad fixture\n');
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': withBroken,
    },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains a "RED-BROKEN" entry/);
});

// --- Adversarial: a ###/#### shadow above the real "## Content hashes (SHA-256)" section must -----
// not fool the check into reading the shadow's (fabricated) hash instead of the real one.

test('a "### Content hashes (SHA-256)" shadow above the real section does not shadow the real hash table', () => {
  const t = oneTestFixture();
  const shadowed = redMarkdown({ tests: [t] }).replace(
    '## Content hashes (SHA-256)',
    `### Content hashes (SHA-256)\n- ${t.path}: ${'f'.repeat(64)}\n\n## Content hashes (SHA-256)`,
  );
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': shadowed,
    },
  });
  const result = runCheck(root);
  // The real (post-Critical-1-fix) section still records the correct, matching hash — a shadow
  // reporting a fabricated ("f".repeat(64)) hash above it must not be read instead.
  assert.equal(result.status, 0, result.stderr);
});

// --- Report-only: new test files in the diff not covered by red.md's Test paths ------------------

test('reports (but does not fail on) a new, marker-less test file in the diff that red.md does not list', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
    commit: true,
  });
  // A second test file, added to the working tree *after* the commit (so `git ls-files --others`
  // picks it up as untracked/new), with no @spec marker and not listed in red.md at all — the
  // tester-authored-non-behavioral-coverage case this check must only report, never fail on.
  writeFileSync(join(root, 'scripts', 'harness.test.mjs'), 'test(\'harness setup\', () => {});\n', 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"scripts\/harness.test.mjs" is a new test file in the diff/);
});

test('does not report a new test file that already carries its own "@spec" marker', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: {
      'spec.md': specMarkdown({ acItems: ['AC-1'] }),
      'red.md': redMarkdown({ tests: [t] }),
    },
    commit: true,
  });
  writeFileSync(join(root, 'scripts', 'another.test.mjs'), '// @spec AC-1\ntest(\'covered\', () => {});\n', 'utf8');

  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    !result.stdout.includes('scripts/another.test.mjs" is a new test file in the diff'),
    'a new test file that already carries its own @spec marker must not be reported as a marker-less candidate',
  );
});

// --- Required input: spec.md must exist ----------------------------------------------------------

test('fails loudly when .pipeline/spec.md is missing', () => {
  const t = oneTestFixture();
  const root = fixtureRepo({
    tests: [t],
    pipeline: { 'red.md': redMarkdown({ tests: [t] }) },
  });
  const result = runCheck(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec\.md does not exist/);
});

// Tests scripts/generate-agent-shims.mjs (PL-03a) — the .sdd/runtimes.yml -> .claude/agents/*.md
// shim generator, and its --check gate (spec.md acceptance criterion 3 and the "hand-edited shim"
// / "dirty tree" / "missing neutral file" edge cases).
//
// The generator computes its own repoRoot as `resolve(<its own directory>, '..')` — it does not
// accept a root override — so exercising "clean tree" / "dirty tree" / "missing neutral file"
// scenarios in isolation (without touching this repository's real .sdd/ or .claude/agents/) means
// copying the script into a throwaway fixture repo and running it there. Each fixture gets its own
// git repo (dirty-tree detection shells out to `git status --porcelain`) and its own node_modules
// junction/symlink to the real js-yaml install (the generator imports it by bare specifier), so no
// package installation is needed per fixture.
//
// Conventions follow scripts/check-secret-access.test.mjs: node:test, tmpdir()-based fixtures,
// cleanup in afterEach.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const realGeneratorSource = readFileSync(resolve(scriptsDir, 'generate-agent-shims.mjs'), 'utf8');
const realJsYamlPath = resolve(repoRoot, 'node_modules', 'js-yaml');

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'gen-shims-test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Gen Shims Test'], { cwd: dir });
  // The fixture's node_modules is a junction/symlink to the real js-yaml install, only present so
  // the copied generator script can resolve its bare `import yaml from 'js-yaml'`. It's irrelevant
  // to what these tests assert and just adds noisy autocrlf warnings if git tracks it — ignore it.
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
}

function commitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: dir });
}

/** Builds a throwaway fixture repo containing: the generator script, a caller-supplied
 * `.sdd/runtimes.yml` + `.sdd/stages/*.md`, and a node_modules/js-yaml link so the generator's
 * `import yaml from 'js-yaml'` resolves without installing anything per fixture. */
function fixtureRepo(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-gen-shims-'));
  roots.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'generate-agent-shims.mjs'), realGeneratorSource, 'utf8');

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(realJsYamlPath, join(root, 'node_modules', 'js-yaml'), 'junction');

  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, 'utf8');
  }

  initGit(root);
  commitAll(root, 'initial fixture state');
  return root;
}

function runGenerator(root, args = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'generate-agent-shims.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

const DEMO_RUNTIMES_YML = `version: 1
stages:
  demo:
    neutral: stages/demo.md
    claude:
      name: demo
      description: Demo stage used only by generate-agent-shims.test.mjs fixtures.
      tools: [Read, Write]
      model: opus
`;

const DEMO_STAGE_MD = '# Demo\n\nFixture body text for the generator test.\n';

// --- AC 3: --check exits 0 on a clean tree, non-zero after a hand-edit --------------------------

test('--check exits 0 once a freshly generated shim is committed', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });

  const write = runGenerator(root);
  assert.equal(write.status, 0, write.stderr);
  assert.ok(existsSync(join(root, '.claude', 'agents', 'demo.md')), 'shim should have been written');
  commitAll(root, 'generate demo shim');

  const check = runGenerator(root, ['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /up to date/);
});

test('--check exits non-zero after a hand-edit to a generated shim', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });
  runGenerator(root);
  commitAll(root, 'generate demo shim');

  const shimPath = join(root, '.claude', 'agents', 'demo.md');
  const original = readFileSync(shimPath, 'utf8');
  writeFileSync(shimPath, original + '\nHand-edited, should never be silently regenerated.\n', 'utf8');

  const check = runGenerator(root, ['--check']);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /stale shim/);
  assert.match(check.stderr, /demo\.md/);
});

// --- PL-04 / item 2 (the general defect): an unrecognized flag must fail loudly, naming itself -----

test('an unrecognized flag fails loudly, naming itself, and writes no shim at all (e.g. a typo\'d "--froce")', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });
  const result = runGenerator(root, ['--froce']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unrecognized argument "--froce"/);
  assert.ok(!existsSync(join(root, '.claude', 'agents', 'demo.md')), 'a typo must never look like it worked');
});

// --- Edge case: generator run on a dirty tree must warn and refuse to overwrite -----------------

test('refuses to overwrite a hand-edited shim that has uncommitted changes, and warns', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });
  runGenerator(root);
  commitAll(root, 'generate demo shim');

  const shimPath = join(root, '.claude', 'agents', 'demo.md');
  const handEdited = readFileSync(shimPath, 'utf8') + '\nUncommitted hand edit.\n';
  writeFileSync(shimPath, handEdited, 'utf8');

  const write = runGenerator(root); // write mode, not --check
  assert.equal(write.status, 1, write.stderr);
  assert.match(write.stderr, /uncommitted changes/);
  assert.equal(readFileSync(shimPath, 'utf8'), handEdited, 'hand-edited content must not be clobbered');
});

// --- Fix (review W5): --force overrides the dirty-tree refusal ---------------------------------
//
// Without an override, the dirty-tree refusal also blocks the ordinary iteration loop: edit
// runtimes.yml -> regenerate (shim is now dirty, uncommitted) -> edit runtimes.yml again ->
// regeneration refuses to overwrite its own prior (uncommitted) output. --force is the documented
// escape hatch for that case.

test('--force overwrites a shim with uncommitted changes instead of skipping it', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });
  runGenerator(root);
  commitAll(root, 'generate demo shim');

  const shimPath = join(root, '.claude', 'agents', 'demo.md');
  writeFileSync(shimPath, readFileSync(shimPath, 'utf8') + '\nUncommitted hand edit.\n', 'utf8');

  const forced = runGenerator(root, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.doesNotMatch(forced.stderr, /uncommitted changes/);

  const check = runGenerator(root, ['--check']);
  assert.equal(check.status, 0, check.stderr);
});

test('--force does not override the missing-neutral-file failure', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': `version: 1
stages:
  ghost:
    neutral: stages/ghost.md
    claude:
      name: ghost
      description: Fixture stage whose neutral file is deliberately absent.
      tools: [Read, Write]
      model: opus
`,
  });

  const forced = runGenerator(root, ['--force']);
  assert.equal(forced.status, 1, forced.stdout);
  assert.match(forced.stderr, /missing neutral stage file/);
});

// --- Edge case: a stage pointing at a missing neutral file must fail loudly and write nothing ---

test('fails loudly and writes no shim at all when one stage\'s neutral file is missing (all-or-nothing)', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': `version: 1
stages:
  alpha:
    neutral: stages/alpha.md
    claude:
      name: alpha
      description: Valid fixture stage.
      tools: [Read, Write]
      model: opus
  beta:
    neutral: stages/beta.md
    claude:
      name: beta
      description: Fixture stage whose neutral file is deliberately absent.
      tools: [Read, Write]
      model: opus
`,
    '.sdd/stages/alpha.md': '# Alpha\n\nPresent on disk.\n',
    // stages/beta.md intentionally not created.
  });

  const write = runGenerator(root);
  assert.equal(write.status, 1, write.stdout);
  assert.match(write.stderr, /missing neutral stage file/);
  assert.match(write.stderr, /beta/);
  assert.ok(
    !existsSync(join(root, '.claude', 'agents', 'alpha.md')),
    'alpha (whose neutral file is fine) must not be written either — refusal is all-or-nothing'
  );
});

// --- Edge case / AC 3: byte-stability across LF/CRLF (the .gitattributes point) -----------------

test('generated shim content is unconditionally LF, never CRLF, regardless of host platform', () => {
  const root = fixtureRepo({
    '.sdd/runtimes.yml': DEMO_RUNTIMES_YML,
    '.sdd/stages/demo.md': DEMO_STAGE_MD,
  });
  runGenerator(root);
  const buffer = readFileSync(join(root, '.claude', 'agents', 'demo.md'));
  assert.ok(!buffer.includes(0x0d), 'generated shim must contain no CR bytes');
});

test('.gitattributes pins LF on .claude/agents/*.md so --check is byte-stable on Windows', () => {
  const gitattributes = readFileSync(resolve(repoRoot, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /\.claude\/agents\/\*\.md\s+text\s+eol=lf/);
});

// --- Integration: the real repository's real shims, as they exist on disk right now ------------

test('[integration] the real repo\'s .claude/agents/*.md shims are currently up to date and CR-free', () => {
  const result = spawnSync(process.execPath, [resolve(scriptsDir, 'generate-agent-shims.mjs'), '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `real repo shims are stale: ${result.stderr}`);

  for (const name of ['planner', 'red', 'dev', 'review', 'security-checker', 'pr-review']) {
    const buffer = readFileSync(resolve(repoRoot, '.claude', 'agents', `${name}.md`));
    assert.ok(!buffer.includes(0x0d), `${name}.md contains a CR byte`);
  }
});

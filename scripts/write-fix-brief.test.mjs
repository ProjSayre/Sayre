// Tests scripts/write-fix-brief.mjs — PL-FIXBRIEF's committed generator: intersection of finding
// paths with spec.json affectedFiles, fail-closed refusals, no markdown scrape.
//
// These tests are authored before the script exists. A missing script is RED-CORRECT (the behavior
// under test is absent), not RED-BROKEN: assertions match generator-specific stderr / written
// files, which a MODULE_NOT_FOUND cannot satisfy.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = resolve(scriptsDir, 'write-fix-brief.mjs');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function scratchDir() {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-write-fix-brief-'));
  roots.push(root);
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  return root;
}

function validFinding(overrides = {}) {
  return {
    id: 'R1',
    summary: 'Export readFixBriefJson.',
    paths: ['scripts/pipeline-contracts.mjs'],
    relatedAc: ['AC-1'],
    requiredOutcome: 'readFixBriefJson validates fix-brief.json.',
    ...overrides,
  };
}

function validSpec(overrides = {}) {
  return {
    ticket: 'PL-FIXBRIEF — scoped dev on reroute',
    goal: 'Scoped fix-loop dev; gates stay full.',
    acceptanceCriteria: [{ id: 'AC-1', text: 'Coordinator writes a fix-brief before re-invoking dev.' }],
    edgeCases: [{ id: 'EC-1', text: 'Empty intersection refuses.' }],
    lane: 'full',
    affectedFiles: ['scripts/pipeline-contracts.mjs', 'scripts/write-fix-brief.mjs'],
    ...overrides,
  };
}

function writePipeline(root, files) {
  const dir = join(root, '.pipeline');
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  }
  return dir;
}

/** @param {string[]} args @param {{ cwd?: string }} [opts] */
function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', cwd: cwd ?? repoRoot });
}

function pipelineArtifacts(dir) {
  return readdirSync(dir).filter((name) => name.startsWith('fix-brief') || name === 'spec-slice.md');
}

// @spec AC-2
test('scripts/write-fix-brief.mjs exists as a committed generator', () => {
  assert.equal(existsSync(scriptPath), true,
    'scripts/write-fix-brief.mjs must exist — the coordinator cannot compute allowedPaths/stamps by hand (AC-2)');
});

// @spec AC-2 EC-9
test('write-fix-brief.mjs source does not read review.md, security-report.md, or spec.md', () => {
  assert.equal(existsSync(scriptPath), true, 'generator must exist before we can inspect its source (EC-9)');
  const source = readFileSync(scriptPath, 'utf8');
  assert.doesNotMatch(source, /readFile(?:Sync)?\([^)]*review\.md/,
    'must not fs.readFile review.md — findings come from review.json (EC-9)');
  assert.doesNotMatch(source, /readFile(?:Sync)?\([^)]*security-report\.md/,
    'must not fs.readFile security-report.md (EC-9)');
  assert.doesNotMatch(source, /readFile(?:Sync)?\([^)]*spec\.md/,
    'must not fs.readFile spec.md — affectedFiles come from spec.json (EC-9)');
});

// @spec AC-2 EC-1
test('empty intersection of finding paths and affectedFiles exits 1 and writes nothing', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec({ affectedFiles: ['scripts/unrelated.mjs'] }),
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1, `expected exit 1 on empty intersection, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /allowedPaths|intersection|empty/i,
    'stderr must name the empty-intersection refusal, not a MODULE_NOT_FOUND (EC-1)');
  assert.deepEqual(pipelineArtifacts(dir), [], 'must write no fix-brief/spec-slice files on refusal (EC-1)');
});

// @spec AC-2 EC-2
test('NEEDS_FIXES review.json with missing findings exits 1 and does not scrape markdown', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'NEEDS_FIXES' },
    'review.md': '# Review\n\n## Fix list for dev\n\n1. Secretly scrape this.\n',
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1, `expected exit 1 on missing findings, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /findings/i, 'stderr must name missing/empty findings (EC-2)');
  assert.deepEqual(pipelineArtifacts(dir), [], 'must not write a brief scraped from review.md (EC-2)');
});

// @spec AC-2 EC-2
test('NEEDS_FIXES review.json with empty findings array exits 1', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'NEEDS_FIXES', findings: [] },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /findings/i);
  assert.deepEqual(pipelineArtifacts(dir), [], 'empty findings is the same refusal as missing findings (EC-2)');
});

// @spec AC-2 EC-13
test('--source review against a PASS review.json exits 1', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'PASS', findings: [validFinding()] },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1, `expected exit 1 on wrong verdict, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /NEEDS_FIXES|verdict/i);
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec AC-2 EC-13
test('--source security against a PASS security.json exits 1', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'security.json': { verdict: 'PASS', runId: 'run-1', findings: [validFinding({ id: 'S1' })] },
  });
  const result = runCli(['--source', 'security', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED|verdict/i);
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec AC-20
test('a relatedAc id not in spec.json knownSpecIds exits 1 and writes nothing', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': {
      verdict: 'NEEDS_FIXES',
      findings: [validFinding({ relatedAc: ['AC-99'] })],
    },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1, `expected exit 1 on unknown relatedAc, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /AC-99|relatedAc|knownSpecIds/i);
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec EC-8
test('--attempt 1 exits 2 (invocation error) and writes nothing', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
  });
  const result = runCli(['--source', 'review', '--attempt', '1', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 2, `expected exit 2 for attempt < 2, got ${result.status}: ${result.stderr}`);
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec EC-8
test('a non-integer --attempt exits 2 and writes nothing', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
  });
  const result = runCli(['--source', 'review', '--attempt', 'two', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 2, `expected exit 2 for non-integer attempt, got ${result.status}: ${result.stderr}`);
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec AC-2 EC-5 AC-16
test('success writes fix-brief.json/md and spec-slice.md with the intersection as allowedPaths and fullSpecStillGoverns true', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec({
      affectedFiles: ['scripts/pipeline-contracts.mjs', 'scripts/write-fix-brief.mjs'],
    }),
    'review.json': {
      verdict: 'NEEDS_FIXES',
      findings: [validFinding({
        paths: ['scripts/pipeline-contracts.mjs', 'apps/web/secret.ts'],
      })],
    },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 0, `expected exit 0 on success, got ${result.status}: ${result.stderr}\n${result.stdout}`);
  const brief = JSON.parse(readFileSync(join(dir, 'fix-brief.json'), 'utf8'));
  assert.equal(brief.source, 'review');
  assert.equal(brief.attempt, 2);
  assert.equal(brief.fullSpecStillGoverns, true, 'generator always writes literal true (AC-16)');
  assert.deepEqual(brief.allowedPaths, ['scripts/pipeline-contracts.mjs'],
    'allowedPaths is the sorted unique intersection; out-of-spec paths are dropped (EC-5)');
  assert.equal(brief.findings[0].id, 'R1');
  assert.ok(brief.stamp && typeof brief.stamp.treeHash === 'string',
    'write-stamp.mjs must attach stamp as the last successful step (AC-2)');
  assert.equal(existsSync(join(dir, 'fix-brief.md')), true, 'human fix-brief.md must be written');
  const slice = readFileSync(join(dir, 'spec-slice.md'), 'utf8');
  assert.match(slice, /fullSpecStillGoverns/, 'spec-slice.md must notice that gates still certify every AC/EC');
  assert.match(slice, /AC-1/, 'spec-slice.md must include cited relatedAc text');
});

// @spec EC-1
test('affectedFiles absent on spec.json is treated as empty and refuses (fail closed)', () => {
  const root = scratchDir();
  const spec = validSpec();
  delete spec.affectedFiles;
  const dir = writePipeline(root, {
    'spec.json': spec,
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allowedPaths|intersection|empty|affectedFiles/i,
    'stderr must name the empty-intersection refusal when affectedFiles is absent (EC-1)');
  assert.deepEqual(pipelineArtifacts(dir), []);
});

// @spec EC-7
test('--source review does not merge leftover BLOCKED security.json findings into the brief', () => {
  const root = scratchDir();
  const dir = writePipeline(root, {
    'spec.json': validSpec(),
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
    'security.json': {
      verdict: 'BLOCKED',
      runId: 'leftover-run',
      findings: [validFinding({
        id: 'S1',
        summary: 'Leftover security finding',
        paths: ['scripts/pipeline-contracts.mjs'],
      })],
    },
  });
  const result = runCli(['--source', 'review', '--attempt', '2', '--dir', dir, '--cwd', repoRoot]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const brief = JSON.parse(readFileSync(join(dir, 'fix-brief.json'), 'utf8'));
  assert.equal(brief.source, 'review');
  assert.deepEqual(brief.findings.map((f) => f.id), ['R1'],
    'leftover security findings must not be merged when --source is review (EC-7)');
});

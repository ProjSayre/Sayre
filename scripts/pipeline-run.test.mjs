import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { extractTicketId, pathRiskProfile, securityPlan } from './pipeline-run.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'scripts', 'pipeline-run.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function json(path, value) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}

function run(cwd, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--cwd', cwd], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    assert.fail('pipeline-run failed:\n' + result.stderr + '\n' + result.stdout);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'sayre-pipeline-run-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'pipeline-test@example.test');
  git(cwd, 'config', 'user.name', 'Pipeline Test');
  write(join(cwd, '.gitignore'), '.pipeline/**\n!.pipeline/README.md\n');
  json(join(cwd, 'package.json'), {
    private: true,
    type: 'module',
    scripts: { 'test:focused': 'node --test tests/focused.test.mjs' },
  });
  write(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--quiet', '-m', 'fixture');
  return cwd;
}

test('risk helpers classify direct tickets and security-sensitive paths', () => {
  assert.equal(extractTicketId('PL-99 — optimize pipeline'), 'PL-99');
  assert.match(extractTicketId('Direct maintenance'), /^DIRECT-[A-F0-9]{10}$/);
  assert.equal(pathRiskProfile(['docs/readme.md']), 'fast');
  assert.equal(pathRiskProfile(['services/core/src/auth/session.ts']), 'sensitive');
  assert.equal(securityPlan(['docs/readme.md'], 'standard').mode, 'FAST');
  assert.equal(securityPlan(['services/core/src/auth/session.ts'], 'sensitive').mode, 'FULL');
});

test('run-scoped happy path generates markdown, verifies once, and finalizes a ledger entry', (t) => {
  const cwd = fixture(t);
  const initialized = run(cwd, 'init', '--ticket', 'OPT-1 — lean pipeline', '--run-id', 'run-1');
  assert.equal(initialized.runId, 'run-1');

  const drafts = join(cwd, '.pipeline', 'runs', 'run-1', 'drafts');
  json(join(drafts, 'planner.json'), {
    goal: 'Make the value observable.',
    ticketCheck: {
      build: 'Change the exported value.',
      notDoing: 'No API expansion.',
      worked: 'The focused test passes.',
      guesses: 'None.',
    },
    scopeIn: ['src/value.mjs'],
    scopeOut: [],
    affectedFiles: ['src/value.mjs'],
    interfaces: ['value: number'],
    approach: ['Add a focused regression test, then change the value.'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'value is 2', verification: 'test' }],
    edgeCases: [{ id: 'EC-1', text: 'export remains numeric', verification: 'review' }],
    openQuestions: [],
    changeKind: 'behavioral',
    risk: 'standard',
  });
  assert.equal(run(cwd, 'emit', 'planner', '--input', '.pipeline/runs/run-1/drafts/planner.json').next, 'red');

  const testBody = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 2));\n";
  write(join(cwd, 'tests', 'focused.test.mjs'), testBody);
  const hash = createHash('sha256').update(testBody).digest('hex');
  json(join(drafts, 'red.json'), {
    coverage: [{ specIds: ['AC-1'], mode: 'new', testPath: 'tests/focused.test.mjs', reason: 'Regression proof.' }],
    tests: [{
      path: 'tests/focused.test.mjs',
      specIds: ['AC-1'],
      source: 'new',
      sha256: hash,
      classification: 'RED-CORRECT',
    }],
    commands: [{
      id: 'focused',
      command: 'npm',
      args: ['run', 'test:focused'],
      cwd: '.',
      reason: 'Focused behavior check.',
      specIds: ['AC-1'],
    }],
    impactMap: { status: 'not-needed', summary: 'The fixture has one isolated behavior.' },
  });
  assert.equal(run(cwd, 'emit', 'red', '--input', '.pipeline/runs/run-1/drafts/red.json').next, 'dev');

  write(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
  json(join(drafts, 'dev.json'), {
    summary: 'Changed value to 2.',
    decisions: [],
    deviations: [],
    redTestChanges: [],
    fixesApplied: [],
    notDone: [],
    verificationCommands: [],
  });
  assert.equal(run(cwd, 'emit', 'dev', '--input', '.pipeline/runs/run-1/drafts/dev.json').next, 'verify');
  assert.equal(run(cwd, 'verify').result, 'PASS');

  json(join(drafts, 'review.json'), { verdict: 'PASS', summary: 'Spec and diff agree.', findings: [] });
  write(join(cwd, 'src', 'value.mjs'), 'export const value = 3;\n');
  const staleReview = spawnSync(process.execPath, [cli, 'emit', 'review', '--input', '.pipeline/runs/run-1/drafts/review.json', '--cwd', cwd], { cwd, encoding: 'utf8' });
  assert.notEqual(staleReview.status, 0);
  assert.match(staleReview.stderr, /stale deterministic verification/);
  write(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
  assert.equal(run(cwd, 'emit', 'review', '--input', '.pipeline/runs/run-1/drafts/review.json').next, 'security');
  json(join(drafts, 'security.json'), {
    verdict: 'PASS',
    summary: 'No sensitive surface changed.',
    checks: [
      { id: 'FAST-SECRET-DIFF', result: 'PASS', evidence: 'No secret material or access path changed.' },
      { id: 'FAST-INJECTION-DIFF', result: 'PASS', evidence: 'No input or command boundary changed.' },
    ],
    findings: [],
    limitations: [],
  });
  assert.equal(run(cwd, 'emit', 'security', '--input', '.pipeline/runs/run-1/drafts/security.json').next, 'finalize');
  assert.equal(run(cwd, 'finalize').status, 'complete');
  assert.equal(run(cwd, 'check-red', '--dir', '.sdd/ledger/run-1').result, 'PASS');

  const state = JSON.parse(readFileSync(join(cwd, '.pipeline', 'runs', 'run-1', 'state.json'), 'utf8'));
  const entry = JSON.parse(readFileSync(join(cwd, '.sdd', 'ledger', 'run-1', 'entry.json'), 'utf8'));
  assert.equal(state.status, 'complete');
  assert.equal(entry.date.length, 10);
  assert.equal(entry.verification.commandCount, 1);
  assert.match(readFileSync(join(cwd, '.pipeline', 'runs', 'run-1', 'artifacts', 'spec.md'), 'utf8'), /Generated from canonical spec\.json/);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.sdd', 'ledger', 'index.json'), 'utf8')), {
    'src/value.mjs': [{ runId: 'run-1', ticket: 'OPT-1', date: entry.date, spec: '.sdd/ledger/run-1/spec.md' }],
    'tests/focused.test.mjs': [{ runId: 'run-1', ticket: 'OPT-1', date: entry.date, spec: '.sdd/ledger/run-1/spec.md' }],
  });
});

test('actual sensitive paths raise an optimistic planner profile before security selection', (t) => {
  const cwd = fixture(t);
  run(cwd, 'init', '--ticket', 'OPT-3 — escalation', '--run-id', 'run-sensitive');
  const draftDir = join(cwd, '.pipeline', 'runs', 'run-sensitive', 'drafts');
  json(join(draftDir, 'planner.json'), {
    goal: 'Document a maintenance change.',
    ticketCheck: { build: 'Update docs.', notDoing: 'No sensitive change expected.', worked: 'Review confirms it.', guesses: 'None.' },
    scopeIn: ['docs/note.md'], scopeOut: [], affectedFiles: ['docs/note.md'], interfaces: [], approach: ['Write the note.'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'The note exists.', verification: 'review' }], edgeCases: [], openQuestions: [],
    changeKind: 'docs', risk: 'low',
  });
  assert.equal(run(cwd, 'emit', 'planner', '--input', '.pipeline/runs/run-sensitive/drafts/planner.json').profile, 'fast');
  write(join(cwd, 'services', 'core', 'src', 'auth', 'unexpected.mjs'), 'export const sensitive = true;\n');
  json(join(draftDir, 'dev.json'), {
    summary: 'The actual change reached auth.', decisions: [], deviations: ['Planner scope was inaccurate.'],
    redTestChanges: [], fixesApplied: [], notDone: [], verificationCommands: [],
  });
  const emitted = run(cwd, 'emit', 'dev', '--input', '.pipeline/runs/run-sensitive/drafts/dev.json');
  assert.equal(emitted.profile, 'sensitive');
  const state = JSON.parse(readFileSync(join(cwd, '.pipeline', 'runs', 'run-sensitive', 'state.json'), 'utf8'));
  assert.equal(state.securityPlan.mode, 'FULL');
});

test('an active verified run can reopen after a manual edit and consumes the shared retry budget', (t) => {
  const cwd = fixture(t);
  run(cwd, 'init', '--ticket', 'OPT-5 — reopen edits', '--run-id', 'run-reopen');
  const draftDir = join(cwd, '.pipeline', 'runs', 'run-reopen', 'drafts');
  json(join(draftDir, 'planner.json'), {
    goal: 'Document the reopen path.',
    ticketCheck: { build: 'Add a note.', notDoing: 'No runtime behavior.', worked: 'Review confirms the note.', guesses: 'None.' },
    scopeIn: ['docs/note.md'], scopeOut: [], affectedFiles: ['docs/note.md'], interfaces: [], approach: ['Write the note.'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'The note exists.', verification: 'review' }], edgeCases: [], openQuestions: [],
    changeKind: 'docs', risk: 'low',
  });
  assert.equal(run(cwd, 'emit', 'planner', '--input', '.pipeline/runs/run-reopen/drafts/planner.json').next, 'dev');
  write(join(cwd, 'docs', 'note.md'), '# Note\n');
  json(join(draftDir, 'dev.json'), {
    summary: 'Added the note.', decisions: [], deviations: [], redTestChanges: [], fixesApplied: [], notDone: [], verificationCommands: [],
  });
  run(cwd, 'emit', 'dev', '--input', '.pipeline/runs/run-reopen/drafts/dev.json');
  assert.equal(run(cwd, 'verify').next, 'review');

  const reopened = run(cwd, 'reopen', '--reason', 'A manual edit invalidated verification.');
  assert.equal(reopened.next, 'dev');
  assert.equal(reopened.attempt, 2);
  const state = JSON.parse(readFileSync(join(cwd, '.pipeline', 'runs', 'run-reopen', 'state.json'), 'utf8'));
  assert.equal(state.verification, undefined);
  assert.equal(state.status, 'active');
});

test('failed deterministic verification uses one shared three-attempt cap', (t) => {
  const cwd = fixture(t);
  run(cwd, 'init', '--ticket', 'OPT-4 — retry cap', '--run-id', 'run-retry');
  const draftDir = join(cwd, '.pipeline', 'runs', 'run-retry', 'drafts');
  json(join(draftDir, 'planner.json'), {
    goal: 'Exercise retry routing.',
    ticketCheck: { build: 'A failing fixture.', notDoing: 'No successful behavior.', worked: 'The runner blocks.', guesses: 'None.' },
    scopeIn: ['tests/fail.test.mjs'], scopeOut: [], affectedFiles: ['tests/fail.test.mjs'], interfaces: [], approach: ['Keep the test failing.'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'Verification fails.', verification: 'test' }], edgeCases: [], openQuestions: [],
    changeKind: 'internal', risk: 'standard',
  });
  run(cwd, 'emit', 'planner', '--input', '.pipeline/runs/run-retry/drafts/planner.json');
  const failingBody = "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('fails', () => assert.fail('expected'));\n";
  write(join(cwd, 'tests', 'fail.test.mjs'), failingBody);
  json(join(draftDir, 'red.json'), {
    coverage: [{ specIds: ['AC-1'], mode: 'new', testPath: 'tests/fail.test.mjs', reason: 'Retry fixture.' }],
    tests: [{ path: 'tests/fail.test.mjs', specIds: ['AC-1'], source: 'new', sha256: createHash('sha256').update(failingBody).digest('hex'), classification: 'RED-CORRECT' }],
    commands: [{ id: 'always-fails', command: 'node', args: ['--test', 'tests/fail.test.mjs'], cwd: '.', reason: 'Exercise failure routing.', specIds: ['AC-1'] }],
    impactMap: { status: 'not-needed', summary: 'Synthetic retry fixture.' },
  });
  run(cwd, 'emit', 'red', '--input', '.pipeline/runs/run-retry/drafts/red.json');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    json(join(draftDir, 'dev.json'), {
      summary: 'Attempt ' + attempt + ' intentionally leaves the failure.', decisions: [], deviations: [], redTestChanges: [],
      fixesApplied: [], notDone: ['Synthetic failure remains.'], verificationCommands: [],
    });
    run(cwd, 'emit', 'dev', '--input', '.pipeline/runs/run-retry/drafts/dev.json');
    const failed = spawnSync(process.execPath, [cli, 'verify', '--cwd', cwd], { cwd, encoding: 'utf8' });
    const log = readFileSync(join(cwd, '.pipeline', 'runs', 'run-retry', 'logs', 'verify-01-always-fails.log'), 'utf8');
    assert.notEqual(failed.status, 0, 'attempt ' + attempt + '\nstdout:\n' + failed.stdout + '\nstderr:\n' + failed.stderr + '\nlog:\n' + log);
  }
  const state = JSON.parse(readFileSync(join(cwd, '.pipeline', 'runs', 'run-retry', 'state.json'), 'utf8'));
  assert.equal(state.status, 'blocked');
  assert.equal(state.attempt, 3);
  assert.match(state.blockedReason, /maximum of 3 development attempts/);
});

test('red emission rejects a stale or fabricated test digest', (t) => {
  const cwd = fixture(t);
  run(cwd, 'init', '--ticket', 'OPT-2 — hash guard', '--run-id', 'run-hash');
  const drafts = join(cwd, '.pipeline', 'runs', 'run-hash', 'drafts');
  json(join(drafts, 'planner.json'), {
    goal: 'Guard red tests.',
    ticketCheck: { build: 'Hash red tests.', notDoing: 'No product change.', worked: 'Bad hashes refuse.', guesses: 'None.' },
    scopeIn: ['tests/focused.test.mjs'], scopeOut: [], affectedFiles: ['tests/focused.test.mjs'], interfaces: [],
    approach: ['Validate the digest.'], acceptanceCriteria: [{ id: 'AC-1', text: 'Hash matches.', verification: 'test' }],
    edgeCases: [], openQuestions: [], changeKind: 'internal', risk: 'standard',
  });
  run(cwd, 'emit', 'planner', '--input', '.pipeline/runs/run-hash/drafts/planner.json');
  write(join(cwd, 'tests', 'focused.test.mjs'), "import test from 'node:test';\ntest('x', () => {});\n");
  json(join(drafts, 'red.json'), {
    coverage: [{ specIds: ['AC-1'], mode: 'new', testPath: 'tests/focused.test.mjs', reason: 'Proof.' }],
    tests: [{ path: 'tests/focused.test.mjs', specIds: ['AC-1'], source: 'new', sha256: '0'.repeat(64), classification: 'RED-CORRECT' }],
    commands: [], impactMap: { status: 'not-needed', summary: 'Isolated.' },
  });
  const result = spawnSync(process.execPath, [cli, 'emit', 'red', '--input', '.pipeline/runs/run-hash/drafts/red.json', '--cwd', cwd], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha256 does not match/);
});

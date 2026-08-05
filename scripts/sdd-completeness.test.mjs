import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..');
const liveStages = ['planner', 'red', 'dev', 'tester', 'review', 'security', 'security-full'];
const agentStages = ['planner', 'red', 'dev', 'review', 'security', 'pr-review'];

function read(path) {
  return readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
}

test('the v2 pipeline has one run-scoped control plane and canonical artifacts', () => {
  const pipeline = read('.sdd/pipeline.md');
  const scratch = read('.pipeline/README.md');
  for (const phrase of [
    'scripts/pipeline-run.mjs',
    '.pipeline/current.json',
    'deterministic',
    'third',
    'FAST security',
  ]) assert.match(pipeline, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(scratch, /\.pipeline\/runs\/<run-id>/);
  assert.match(scratch, /canonical JSON/);
  assert.match(scratch, /Do not create shared .*spec/i);
  assert.ok(existsSync(join(root, 'scripts', 'pipeline-run.mjs')));
});

test('live stage prompts stay concise and move history out of the execution path', () => {
  let totalCharacters = 0;
  for (const stage of liveStages) {
    const path = `.sdd/stages/${stage}.md`;
    assert.ok(existsSync(join(root, path)), `missing ${path}`);
    const body = read(path);
    totalCharacters += body.length;
    assert.ok(body.length < 6_000, `${path} is too large for a live stage prompt (${body.length} chars)`);
    assert.doesNotMatch(body, /CORRECTED \(|review pass \d|loop \d/i, `${path} contains historical patch notes`);
  }
  assert.ok(totalCharacters < 24_000, `live stage prompt total regressed to ${totalCharacters} characters`);
  assert.ok(read('.sdd/stages/CHANGELOG.md').length > 0, 'historical rationale should remain available in CHANGELOG.md');
});

test('runtime wiring has no tester agent and uses pinned economical defaults', () => {
  const runtimes = yaml.load(read('.sdd/runtimes.yml'));
  assert.equal(runtimes.version, 2);
  assert.deepEqual(Object.keys(runtimes.stages), agentStages);
  assert.equal(runtimes.stages.tester, undefined);
  for (const stage of agentStages) {
    const entry = runtimes.stages[stage];
    assert.ok(existsSync(join(root, '.sdd', entry.neutral)), `${stage} neutral procedure is missing`);
    assert.equal(entry.claude.model, 'sonnet', `${stage} should use the pinned default tier`);
  }
  assert.equal(existsSync(join(root, '.claude', 'agents', 'tester.md')), false);
});

test('verification and requirement mapping preserve the load-bearing controls', () => {
  const planner = read('.sdd/stages/planner.md');
  const red = read('.sdd/stages/red.md');
  const dev = read('.sdd/stages/dev.md');
  const verify = read('.sdd/stages/tester.md');
  const review = read('.sdd/stages/review.md');
  assert.match(planner, /`test`:[\s\S]*`review`:[\s\S]*`manual`:/);
  assert.match(red, /`new`:[\s\S]*`existing`:/);
  assert.match(red, /SHA-256/);
  assert.match(dev, /redTestChanges/);
  assert.match(verify, /without a shell/);
  assert.match(verify, /never edits source or tests/i);
  assert.match(review, /read-only with respect to source code/i);
});

test('security is tiered without weakening sensitive-boundary blockers', () => {
  const security = read('.sdd/stages/security.md');
  const full = read('.sdd/stages/security-full.md');
  for (const mode of ['FAST', 'FULL', 'MILESTONE']) assert.match(security, new RegExp(mode));
  assert.match(security, /tenant isolation/i);
  assert.match(security, /RBAC boundary/i);
  assert.match(security, /webhook trust/i);
  assert.match(security, /ingestion ephemerality/i);
  assert.match(full, /agent-registry\.json/);
  assert.match(full, /validate-security-audit-run\.mjs/);
  assert.match(full, /\.pipeline\/runs\/<pipeline-run-id>\/security-history/);
});

test('Claude command skills route through v2 state instead of shared filenames', () => {
  const skills = ['pipeline', 'planner', 'spec-only', 'red', 'dev', 'tester', 'review', 'security', 'pipeline-status', 'security-recheck', 're-gate'];
  for (const skill of skills) {
    const body = read(`.claude/skills/${skill}/SKILL.md`);
    assert.ok(body.startsWith('---\n'), `${skill} has no frontmatter`);
    assert.match(body, /\.sdd\/pipeline\.md|pipeline-run\.mjs/);
  }
  assert.match(read('.claude/skills/tester/SKILL.md'), /no tester agent/i);
  assert.match(read('.claude/skills/pipeline/SKILL.md'), /deterministic `verify`/);
});

test('package scripts expose one aggregate control-plane gate and a valid root test', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.pipeline, 'node scripts/pipeline-run.mjs');
  assert.match(pkg.scripts['test:control-plane'], /pipeline-run\.test\.mjs/);
  assert.match(pkg.scripts['check:control-plane'], /typecheck:scripts/);
  assert.match(pkg.scripts.test, /test:control-plane/);
  assert.match(pkg.scripts.test, /test:workspaces/);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run check:control-plane && npm run test:control-plane/);
  assert.equal((ci.match(/test:sdd-completeness/g) || []).length, 0, 'CI should not duplicate aggregate suites');
});

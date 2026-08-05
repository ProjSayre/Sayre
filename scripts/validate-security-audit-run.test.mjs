import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const historyRoot = resolve(root, '.pipeline', 'security-history');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function createFixture() {
  const registry = JSON.parse(read('security-attacker-agents/agent-registry.json'));
  const shortSha = randomBytes(4).toString('hex');
  const runId = `20990101T000000000Z-${shortSha}-PR_DELTA-${randomBytes(3).toString('hex')}`;
  const runDir = resolve(historyRoot, runId);
  mkdirSync(runDir, { recursive: false });

  const coreSurfaces = registry.mandatory_core_checks.map((core) => ({
    surface_id: core.surface_id,
    brief_path: '.claude/agents/security-checker.md',
    readiness: 'PARTIAL',
    previous_readiness: null,
    readiness_transition: 'FIRST_OBSERVATION',
    changed: false,
    selected: true,
    selection_reason: 'Mandatory core boundary',
    rationale: 'Synthetic validator fixture',
    code_references: ['fixture:core']
  }));
  const agentSurfaces = registry.agents.map((agent) => ({
    surface_id: agent.surface_id,
    brief_path: agent.path,
    readiness: 'PLANNED',
    previous_readiness: null,
    readiness_transition: 'FIRST_OBSERVATION',
    changed: false,
    selected: false,
    selection_reason: 'Not selected by synthetic PR delta',
    rationale: 'Synthetic validator fixture',
    code_references: []
  }));
  const observations = registry.mandatory_core_checks.map((core) => ({
    observation_key: `projSayre/Sayre|${core.check_id}|${core.surface_id}|synthetic-boundary|v1`,
    check_id: core.check_id,
    surface_id: core.surface_id,
    surface_readiness: 'PARTIAL',
    target_asset: 'synthetic-boundary',
    attack_path_version: 'v1',
    attempt: 'Synthetic schema-validation attempt',
    evidence: [],
    evidence_type: 'STATIC',
    result: 'UNVERIFIED',
    previous_result: null,
    result_transition: 'FIRST_OBSERVATION',
    coverage_transition: 'NOT_COMPARABLE',
    severity: 'NONE',
    confidence: 'LOW',
    single_point_of_failure: false,
    finding: null,
    reproduction_and_cleanup: 'No runtime action performed',
    code_references: ['fixture:observation']
  }));

  const manifest = {
    schema_version: '1.0.0',
    run_id: runId,
    mode: 'PR_DELTA',
    status: 'COMPLETE',
    started_at: '2099-01-01T00:00:00Z',
    completed_at: '2099-01-01T00:01:00Z',
    repository: {
      canonical_id: 'projsayre/sayre',
      remote: 'https://github.com/ProjSayre/Sayre.git',
      working_path: root
    },
    target: {
      commit_sha: 'a'.repeat(40),
      branch: 'fixture',
      dirty: false,
      environment: 'synthetic-local',
      base_urls: [],
      changed_paths: []
    },
    baseline: {
      run_id: null,
      commit_sha: null,
      comparable: false,
      selection_reason: 'No prior synthetic run',
      incompatible_dimensions: []
    },
    product_progress: {
      milestone: null,
      phase: null,
      source_references: [],
      documentation_code_drift: []
    },
    authorization: {
      runtime_tests_authorized: false,
      authorized_by: null,
      resource_ceiling: null,
      credential_references: [],
      tenant_fixtures: []
    },
    surface_inventory: [...coreSurfaces, ...agentSurfaces],
    agent_versions: [
      ['audit-contract', registry.contract],
      ['progress-orchestrator', registry.orchestrator],
      ['agent-registry', 'security-attacker-agents/agent-registry.json'],
      // PL-03a review fix 3: the manifest now hashes both the neutral procedure the security
      // stage actually follows (.sdd/stages/security.md) and the generated shim that still
      // carries the tool grants/hook wiring (.claude/agents/security-checker.md) — see
      // scripts/validate-security-audit-run.mjs's requiredSources.
      ['security-stage', '.sdd/stages/security.md'],
      ['security-checker', '.claude/agents/security-checker.md']
    ].map(([agent_id, source]) => ({ agent_id, source, sha256: sha256(read(source)) })),
    limitations: ['Synthetic fixture; no security claim']
  };

  const results = {
    schema_version: '1.0.0',
    run_id: runId,
    baseline_run_id: null,
    generated_at: '2099-01-01T00:01:00Z',
    verdict: 'BLOCKED',
    summary: {
      results: countBy(observations.map((item) => item.result)),
      result_transitions: countBy(observations.map((item) => item.result_transition)),
      coverage_transitions: countBy(observations.map((item) => item.coverage_transition)),
      finding_statuses: {},
      surface_readiness: countBy(manifest.surface_inventory.map((item) => item.readiness)),
      readiness_transitions: countBy(manifest.surface_inventory.map((item) => item.readiness_transition))
    },
    observations
  };

  writeJson(resolve(runDir, 'manifest.json'), manifest);
  writeJson(resolve(runDir, 'results.json'), results);
  writeFileSync(resolve(runDir, 'report.md'), `# Synthetic audit\n\nRun: ${runId}\n\nVerdict: BLOCKED\n`, 'utf8');
  return { runDir, runId, results };
}

function runValidator(runId) {
  return spawnSync(process.execPath, ['scripts/validate-security-audit-run.mjs', `.pipeline/security-history/${runId}`], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('accepts a complete first-observation audit run', () => {
  mkdirSync(historyRoot, { recursive: true });
  const fixture = createFixture();
  try {
    const validation = runValidator(fixture.runId);
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /internally consistent/);
  } finally {
    rmSync(fixture.runDir, { recursive: true, force: true });
  }
});

test('accepts the v2 run-scoped security-history layout', () => {
  mkdirSync(historyRoot, { recursive: true });
  const fixture = createFixture();
  const scopedDir = resolve(root, '.pipeline', 'runs', 'pipeline-fixture', 'security-history', fixture.runId);
  mkdirSync(resolve(scopedDir, '..'), { recursive: true });
  renameSync(fixture.runDir, scopedDir);
  try {
    const validation = spawnSync(
      process.execPath,
      ['scripts/validate-security-audit-run.mjs', `.pipeline/runs/pipeline-fixture/security-history/${fixture.runId}`],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /internally consistent/);
  } finally {
    rmSync(resolve(root, '.pipeline', 'runs', 'pipeline-fixture'), { recursive: true, force: true });
  }
});

test('rejects a non-deterministic finding ID', () => {
  mkdirSync(historyRoot, { recursive: true });
  const fixture = createFixture();
  try {
    const observation = fixture.results.observations[0];
    observation.result = 'FAIL';
    observation.severity = 'HIGH';
    observation.evidence = ['synthetic evidence'];
    observation.finding = {
      finding_id: 'FND-000000000000',
      status: 'OPEN',
      first_seen_run_id: fixture.runId,
      first_seen_commit: 'a'.repeat(40),
      last_seen_run_id: fixture.runId,
      last_seen_commit: 'a'.repeat(40),
      owner: null,
      due_at: null,
      remediation_reference: null,
      risk_acceptance: null
    };
    fixture.results.summary.results = countBy(fixture.results.observations.map((item) => item.result));
    fixture.results.summary.finding_statuses = { OPEN: 1 };
    writeJson(resolve(fixture.runDir, 'results.json'), fixture.results);

    const validation = runValidator(fixture.runId);
    assert.notEqual(validation.status, 0);
    assert.match(validation.stderr, /unstable finding ID/);
  } finally {
    rmSync(fixture.runDir, { recursive: true, force: true });
  }
});

test('accepts a regression classified against an immutable baseline', () => {
  mkdirSync(historyRoot, { recursive: true });
  const baseline = createFixture();
  const current = createFixture();
  try {
    const baselineObservation = baseline.results.observations[0];
    baselineObservation.result = 'PASS';
    baselineObservation.evidence = ['synthetic baseline evidence'];
    baseline.results.summary.results = countBy(baseline.results.observations.map((item) => item.result));
    writeJson(resolve(baseline.runDir, 'results.json'), baseline.results);

    const currentManifestPath = resolve(current.runDir, 'manifest.json');
    const currentManifest = JSON.parse(readFileSync(currentManifestPath, 'utf8'));
    currentManifest.baseline = {
      run_id: baseline.runId,
      commit_sha: 'a'.repeat(40),
      comparable: true,
      selection_reason: 'Synthetic comparable baseline',
      incompatible_dimensions: []
    };
    const baselineManifest = JSON.parse(readFileSync(resolve(baseline.runDir, 'manifest.json'), 'utf8'));
    for (const surface of currentManifest.surface_inventory) {
      const previous = baselineManifest.surface_inventory.find((candidate) => candidate.surface_id === surface.surface_id);
      surface.previous_readiness = previous.readiness;
      surface.readiness_transition = 'UNCHANGED';
    }
    writeJson(currentManifestPath, currentManifest);

    for (let index = 0; index < current.results.observations.length; index += 1) {
      const observation = current.results.observations[index];
      const previous = baseline.results.observations[index];
      observation.previous_result = previous.result;
      observation.result_transition = 'UNCHANGED';
      observation.coverage_transition = 'UNCHANGED';
    }
    const regressed = current.results.observations[0];
    regressed.result = 'FAIL';
    regressed.evidence = ['synthetic regression evidence'];
    regressed.severity = 'HIGH';
    regressed.result_transition = 'REGRESSED';
    regressed.finding = {
      finding_id: `FND-${sha256(regressed.observation_key).slice(0, 12)}`,
      status: 'OPEN',
      first_seen_run_id: current.runId,
      first_seen_commit: 'a'.repeat(40),
      last_seen_run_id: current.runId,
      last_seen_commit: 'a'.repeat(40),
      owner: null,
      due_at: null,
      remediation_reference: null,
      risk_acceptance: null
    };
    current.results.baseline_run_id = baseline.runId;
    current.results.summary.results = countBy(current.results.observations.map((item) => item.result));
    current.results.summary.result_transitions = countBy(current.results.observations.map((item) => item.result_transition));
    current.results.summary.coverage_transitions = countBy(current.results.observations.map((item) => item.coverage_transition));
    current.results.summary.finding_statuses = { OPEN: 1 };
    current.results.summary.readiness_transitions = countBy(currentManifest.surface_inventory.map((item) => item.readiness_transition));
    writeJson(resolve(current.runDir, 'results.json'), current.results);

    const validation = runValidator(current.runId);
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /internally consistent/);
  } finally {
    rmSync(current.runDir, { recursive: true, force: true });
    rmSync(baseline.runDir, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const root = process.cwd();
const requestedPath = process.argv[2];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function assertCounts(actual, expected, label) {
  assert(actual && typeof actual === 'object' && !Array.isArray(actual), `${label} summary is missing`);
  for (const [key, value] of Object.entries(expected)) {
    assert(actual[key] === value, `${label}.${key} must be ${value}; found ${actual[key] ?? 'missing'}`);
  }
  for (const [key, value] of Object.entries(actual)) {
    assert(Number.isInteger(value) && value >= 0, `${label}.${key} is not a non-negative integer`);
    assert((expected[key] ?? 0) === value, `${label}.${key} does not match observations`);
  }
}

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function resolveLocalRef(rootSchema, ref) {
  assert(ref.startsWith('#/'), `Only local JSON Schema references are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
}

function schemaErrors(value, schema, rootSchema = schema, path = '$') {
  const errors = [];
  const visit = (candidate, rule, candidatePath) => {
    if (rule.$ref) {
      const referenced = resolveLocalRef(rootSchema, rule.$ref);
      if (!referenced) errors.push(`${candidatePath}: unresolved schema reference ${rule.$ref}`);
      else visit(candidate, referenced, candidatePath);
      return;
    }

    if (rule.anyOf) {
      const valid = rule.anyOf.some((branch) => schemaErrors(candidate, branch, rootSchema, candidatePath).length === 0);
      if (!valid) errors.push(`${candidatePath}: no anyOf schema matched`);
    }
    if (rule.allOf) for (const branch of rule.allOf) visit(candidate, branch, candidatePath);
    if (rule.if && schemaErrors(candidate, rule.if, rootSchema, candidatePath).length === 0 && rule.then) visit(candidate, rule.then, candidatePath);

    if (rule.const !== undefined && candidate !== rule.const) errors.push(`${candidatePath}: expected constant ${JSON.stringify(rule.const)}`);
    if (rule.enum && !rule.enum.some((item) => Object.is(item, candidate))) errors.push(`${candidatePath}: value is outside enum`);

    if (rule.type) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some((type) => schemaTypeMatches(candidate, type))) {
        errors.push(`${candidatePath}: expected type ${types.join('|')}`);
        return;
      }
    }

    if (typeof candidate === 'string') {
      if (rule.minLength !== undefined && candidate.length < rule.minLength) errors.push(`${candidatePath}: shorter than minLength`);
      if (rule.pattern && !new RegExp(rule.pattern).test(candidate)) errors.push(`${candidatePath}: does not match pattern ${rule.pattern}`);
      if (rule.format === 'date-time' && Number.isNaN(Date.parse(candidate))) errors.push(`${candidatePath}: invalid date-time`);
    }
    if (typeof candidate === 'number' && rule.minimum !== undefined && candidate < rule.minimum) errors.push(`${candidatePath}: below minimum`);

    if (Array.isArray(candidate)) {
      if (rule.minItems !== undefined && candidate.length < rule.minItems) errors.push(`${candidatePath}: fewer than minItems`);
      if (rule.uniqueItems) {
        const serialized = candidate.map((item) => JSON.stringify(item));
        if (new Set(serialized).size !== serialized.length) errors.push(`${candidatePath}: items are not unique`);
      }
      if (rule.items) candidate.forEach((item, index) => visit(item, rule.items, `${candidatePath}[${index}]`));
    }

    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const required of rule.required ?? []) {
        if (!Object.hasOwn(candidate, required)) errors.push(`${candidatePath}: missing required property ${required}`);
      }
      for (const [key, item] of Object.entries(candidate)) {
        if (rule.properties?.[key]) visit(item, rule.properties[key], `${candidatePath}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${candidatePath}: unexpected property ${key}`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') visit(item, rule.additionalProperties, `${candidatePath}.${key}`);
      }
    }
  };

  visit(value, schema, path);
  return errors;
}

function expectedResultTransition(previous, current, comparable) {
  if (!comparable) return 'NOT_COMPARABLE';
  if (previous === undefined) return 'FIRST_OBSERVATION';
  if (previous === current) return 'UNCHANGED';
  if (previous === 'PASS' && current === 'FAIL') return 'REGRESSED';
  if (previous !== 'FAIL' && current === 'FAIL') return 'NEW';
  if (previous === 'FAIL' && current === 'PASS') return 'RESOLVED';
  return 'CHANGED';
}

function expectedReadinessTransition(previous, current, hasBaseline, comparable) {
  if (!hasBaseline) return 'FIRST_OBSERVATION';
  if (!comparable) return 'NOT_COMPARABLE';
  if (previous === undefined) return 'FIRST_OBSERVATION';
  if (previous === current) return 'UNCHANGED';
  if (previous === 'DEPRECATED' || current === 'DEPRECATED') return 'CHANGED';
  const order = ['ABSENT', 'PLANNED', 'PARTIAL', 'IMPLEMENTED'];
  return order.indexOf(current) > order.indexOf(previous) ? 'ADVANCED' : 'REGRESSED';
}

function hasAffirmativeEvidence(observation) {
  return ['PASS', 'FAIL'].includes(observation.result) && Array.isArray(observation.evidence) && observation.evidence.length > 0;
}

function expectedCoverageTransition(previous, current, comparable) {
  if (!comparable || previous === undefined) return 'NOT_COMPARABLE';
  const previousCovered = hasAffirmativeEvidence(previous);
  const currentCovered = hasAffirmativeEvidence(current);
  if (!previousCovered && currentCovered) return 'GAINED';
  if (previousCovered && !currentCovered) return 'LOST';
  return 'UNCHANGED';
}

assert(requestedPath, 'Usage: node scripts/validate-security-audit-run.mjs .pipeline/security-history/<run-id>');
const historyRoot = resolve(root, '.pipeline', 'security-history');
const runDir = resolve(root, requestedPath);
const relativeRunDir = relative(historyRoot, runDir);
assert(relativeRunDir && relativeRunDir !== '..' && !relativeRunDir.startsWith(`..${sep}`) && !relativeRunDir.includes(sep), 'Run path must be one direct child of .pipeline/security-history/');

const manifestPath = resolve(runDir, 'manifest.json');
const resultsPath = resolve(runDir, 'results.json');
const reportPath = resolve(runDir, 'report.md');
for (const path of [manifestPath, resultsPath, reportPath]) assert(existsSync(path), `Missing run artifact: ${path}`);

const registry = JSON.parse(readRepo('security-attacker-agents/agent-registry.json'));
const manifest = parseJson(manifestPath);
const results = parseJson(resultsPath);
const report = readFileSync(reportPath, 'utf8');
const manifestSchema = JSON.parse(readRepo(registry.manifest_schema));
const resultsSchema = JSON.parse(readRepo(registry.results_schema));

const manifestSchemaErrors = schemaErrors(manifest, manifestSchema);
const resultsSchemaErrors = schemaErrors(results, resultsSchema);
assert(manifestSchemaErrors.length === 0, `Manifest schema errors:\n${manifestSchemaErrors.join('\n')}`);
assert(resultsSchemaErrors.length === 0, `Results schema errors:\n${resultsSchemaErrors.join('\n')}`);

assert(manifest.schema_version === '1.0.0', 'Unsupported manifest schema version');
assert(results.schema_version === '1.0.0', 'Unsupported results schema version');
assert(manifest.status === 'COMPLETE', 'Manifest status must be COMPLETE');
assert(manifest.run_id === relativeRunDir, 'Manifest run_id must match its immutable directory name');
assert(results.run_id === manifest.run_id, 'Manifest and results run IDs differ');
assert(results.baseline_run_id === manifest.baseline.run_id, 'Manifest and results baseline IDs differ');
assert(['PASS', 'BLOCKED'].includes(results.verdict), 'Invalid pipeline verdict');
assert(report.includes(manifest.run_id) && report.includes(results.verdict), 'Report does not identify the run and verdict');
assert(/^[0-9a-f]{40}$/.test(manifest.target.commit_sha), 'Target commit must be a full lowercase SHA');
assert(Array.isArray(manifest.surface_inventory), 'Surface inventory is missing');
assert(Array.isArray(manifest.agent_versions), 'Agent versions are missing');
assert(Array.isArray(results.observations), 'Observations are missing');

const expectedSurfaces = new Map();
for (const core of registry.mandatory_core_checks) expectedSurfaces.set(core.surface_id, '.claude/agents/security-checker.md');
for (const agent of registry.agents) expectedSurfaces.set(agent.surface_id, agent.path);
const inventory = new Map(manifest.surface_inventory.map((surface) => [surface.surface_id, surface]));
for (const [surfaceId, briefPath] of expectedSurfaces) {
  const surface = inventory.get(surfaceId);
  assert(surface, `Surface inventory is missing ${surfaceId}`);
  assert(surface.brief_path === briefPath, `${surfaceId} has the wrong brief path`);
  assert(['ABSENT', 'PLANNED', 'PARTIAL', 'IMPLEMENTED', 'DEPRECATED'].includes(surface.readiness), `${surfaceId} has invalid readiness`);
  assert(typeof surface.selected === 'boolean' && surface.selection_reason, `${surfaceId} has no selection decision`);
}
for (const core of registry.mandatory_core_checks) assert(inventory.get(core.surface_id).selected, `${core.check_id} surface must always be selected`);

const expectedCheckSurface = new Map(registry.mandatory_core_checks.map((core) => [core.check_id, core.surface_id]));
for (const agent of registry.agents) {
  if (!inventory.get(agent.surface_id).selected) continue;
  for (const match of readRepo(agent.path).matchAll(/\b([A-Z][A-Z0-9]*)-[0-9]{2}\b/g)) expectedCheckSurface.set(match[0], agent.surface_id);
}
const expectedCheckIds = new Set(expectedCheckSurface.keys());

const allowedResults = new Set(['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE']);
const allowedEvidence = new Set(['STATIC', 'DYNAMIC', 'BOTH']);
const allowedSeverity = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']);
const allowedConfidence = new Set(['HIGH', 'MEDIUM', 'LOW']);
const observationKeys = new Set();
const observedCheckIds = new Set();

let baselineObservations = new Map();
let baselineInventory = new Map();
if (manifest.baseline.run_id) {
  const baselinePath = resolve(historyRoot, manifest.baseline.run_id, 'results.json');
  const baselineManifestPath = resolve(historyRoot, manifest.baseline.run_id, 'manifest.json');
  if (manifest.baseline.comparable) {
    assert(existsSync(baselinePath), 'Comparable baseline results are unavailable');
    assert(existsSync(baselineManifestPath), 'Comparable baseline manifest is unavailable');
    const baselineResults = parseJson(baselinePath);
    const baselineManifest = parseJson(baselineManifestPath);
    const baselineManifestErrors = schemaErrors(baselineManifest, manifestSchema);
    const baselineResultsErrors = schemaErrors(baselineResults, resultsSchema);
    assert(baselineManifestErrors.length === 0, `Baseline manifest schema errors:\n${baselineManifestErrors.join('\n')}`);
    assert(baselineResultsErrors.length === 0, `Baseline results schema errors:\n${baselineResultsErrors.join('\n')}`);
    assert(baselineManifest.status === 'COMPLETE', 'Baseline run is not complete');
    assert(baselineManifest.run_id === manifest.baseline.run_id && baselineResults.run_id === manifest.baseline.run_id, 'Baseline run IDs are inconsistent');
    assert(baselineManifest.target.commit_sha === manifest.baseline.commit_sha, 'Baseline commit does not match the selected run');
    assert(baselineManifest.repository.canonical_id === manifest.repository.canonical_id, 'Baseline repository identity differs');
    assert(baselineManifest.target.environment === manifest.target.environment, 'Comparable baseline environment differs');
    assert(JSON.stringify(baselineManifest.authorization.tenant_fixtures) === JSON.stringify(manifest.authorization.tenant_fixtures), 'Comparable baseline tenant fixtures differ');
    assert(manifest.baseline.incompatible_dimensions.length === 0, 'Comparable baseline lists incompatible dimensions');
    baselineObservations = new Map(baselineResults.observations.map((observation) => [observation.observation_key, observation]));
    baselineInventory = new Map(baselineManifest.surface_inventory.map((surface) => [surface.surface_id, surface]));
  }
}

for (const surface of manifest.surface_inventory) {
  const previous = baselineInventory.get(surface.surface_id);
  const expectedTransition = expectedReadinessTransition(previous?.readiness, surface.readiness, manifest.baseline.run_id !== null, manifest.baseline.comparable);
  assert(surface.previous_readiness === (previous?.readiness ?? null), `${surface.surface_id} previous_readiness is incorrect`);
  assert(surface.readiness_transition === expectedTransition, `${surface.surface_id} must use readiness transition ${expectedTransition}`);
}

for (const observation of results.observations) {
  assert(observation.observation_key && !observationKeys.has(observation.observation_key), `Missing or duplicate observation key: ${observation.observation_key}`);
  observationKeys.add(observation.observation_key);
  observedCheckIds.add(observation.check_id);
  assert(expectedCheckIds.has(observation.check_id), `Observation uses an unselected or unknown check: ${observation.check_id}`);
  assert(allowedResults.has(observation.result), `${observation.check_id} has invalid result`);
  assert(allowedEvidence.has(observation.evidence_type), `${observation.check_id} has invalid evidence type`);
  assert(allowedSeverity.has(observation.severity), `${observation.check_id} has invalid severity`);
  assert(allowedConfidence.has(observation.confidence), `${observation.check_id} has invalid confidence`);
  assert(inventory.get(observation.surface_id)?.selected, `${observation.check_id} refers to an unselected surface`);
  assert(observation.surface_id === expectedCheckSurface.get(observation.check_id), `${observation.check_id} is assigned to the wrong surface`);

  const previous = baselineObservations.get(observation.observation_key);
  const resultComparable = manifest.baseline.run_id === null || manifest.baseline.comparable;
  const coverageComparable = manifest.baseline.run_id !== null && manifest.baseline.comparable;
  const expectedTransition = expectedResultTransition(previous?.result, observation.result, resultComparable);
  const expectedCoverage = expectedCoverageTransition(previous, observation, coverageComparable);
  assert(observation.previous_result === (previous?.result ?? null), `${observation.check_id} previous_result is incorrect`);
  assert(observation.result_transition === expectedTransition, `${observation.check_id} must use result transition ${expectedTransition}`);
  assert(observation.coverage_transition === expectedCoverage, `${observation.check_id} must use coverage transition ${expectedCoverage}`);

  if (observation.result === 'FAIL') {
    assert(observation.finding, `${observation.check_id} FAIL has no finding lifecycle`);
    const expectedFindingId = `FND-${sha256(observation.observation_key).slice(0, 12)}`;
    assert(observation.finding.finding_id === expectedFindingId, `${observation.check_id} has unstable finding ID`);
    if (observation.finding.status === 'RISK_ACCEPTED') {
      const acceptance = observation.finding.risk_acceptance;
      assert(acceptance?.approver && acceptance.reason && acceptance.ticket && acceptance.expires_at, `${observation.check_id} has incomplete risk acceptance`);
    }
  }
}

for (const checkId of expectedCheckIds) assert(observedCheckIds.has(checkId), `Selected check has no observation: ${checkId}`);

assertCounts(results.summary.results, countBy(results.observations.map((item) => item.result)), 'results');
assertCounts(results.summary.result_transitions, countBy(results.observations.map((item) => item.result_transition)), 'result_transitions');
assertCounts(results.summary.coverage_transitions, countBy(results.observations.map((item) => item.coverage_transition)), 'coverage_transitions');
assertCounts(results.summary.finding_statuses, countBy(results.observations.filter((item) => item.finding).map((item) => item.finding.status)), 'finding_statuses');
assertCounts(results.summary.surface_readiness, countBy(manifest.surface_inventory.map((item) => item.readiness)), 'surface_readiness');
assertCounts(results.summary.readiness_transitions, countBy(manifest.surface_inventory.map((item) => item.readiness_transition)), 'readiness_transitions');

const blocking = results.observations.some((observation) =>
  (observation.check_id.startsWith('CORE-') && observation.result === 'FAIL') ||
  (observation.result === 'FAIL' && ['CRITICAL', 'HIGH'].includes(observation.severity)) ||
  (observation.coverage_transition === 'LOST' && ['CRITICAL', 'HIGH'].includes(observation.severity))
);
assert(!blocking || results.verdict === 'BLOCKED', 'Blocking observations require a BLOCKED verdict');

const requiredSources = new Set([
  registry.contract,
  registry.orchestrator,
  'security-attacker-agents/agent-registry.json',
  '.claude/agents/security-checker.md'
]);
for (const agent of registry.agents) if (inventory.get(agent.surface_id).selected) requiredSources.add(agent.path);
const versions = new Map(manifest.agent_versions.map((version) => [version.source, version.sha256]));
for (const source of requiredSources) {
  assert(versions.get(source) === sha256(readRepo(source)), `Missing or incorrect agent content hash: ${source}`);
}

console.log(`Security audit run ${manifest.run_id} is internally consistent: ${results.observations.length} observations, verdict ${results.verdict}.`);

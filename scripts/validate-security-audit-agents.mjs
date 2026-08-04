import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const registryPath = 'security-attacker-agents/agent-registry.json';

function fail(message) {
  throw new Error(message);
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

// SEC-10 follow-up (security round 6, "audit every remaining JSON.parse call site, or state why it
// is not a control input"): this file only ever parses `security-attacker-agents/agent-registry.json`
// and the two JSON Schema files it points at (`registry.manifest_schema`/`registry.results_schema`)
// — static, git-tracked repository configuration, reviewed the normal way through a diff, exactly
// like `.sdd/bounds.yml` or `package.json`. None of it is per-run output an agent process writes
// (unlike `security-history/<run-id>/{manifest,results}.json`, which SEC-10 was about, and which
// `scripts/validate-security-audit-run.mjs` reads through `pipeline-contracts.mjs`'s
// `readJsonFile` instead, for exactly that reason). Left on plain `JSON.parse` deliberately.
function parseJson(path) {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const registry = parseJson(registryPath);
const manifestSchema = parseJson(registry.manifest_schema);
const resultsSchema = parseJson(registry.results_schema);

assert(registry.schema_version === '1.0.0', 'Unexpected registry schema version');
assert(registry.contract === 'security-attacker-agents/audit-contract.md', 'Registry contract path is not canonical');
assert(registry.orchestrator === 'security-attacker-agents/progress-audit-orchestrator.md', 'Registry orchestrator path is not canonical');
assert(Array.isArray(registry.agents) && registry.agents.length > 0, 'Registry has no surface agents');
assert(Array.isArray(registry.mandatory_core_checks) && registry.mandatory_core_checks.length > 0, 'Registry has no mandatory core checks');
assert(manifestSchema.$schema?.includes('2020-12'), 'Manifest is not a draft 2020-12 JSON Schema');
assert(resultsSchema.$schema?.includes('2020-12'), 'Results are not a draft 2020-12 JSON Schema');

const markdownPaths = [registry.contract, registry.orchestrator, ...registry.agents.map((agent) => agent.path)];
for (const path of markdownPaths) {
  const content = read(path);
  assert(/^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(content), `${path} is missing YAML frontmatter`);
  if (path !== registry.contract) {
    assert(content.includes('audit-contract.md'), `${path} does not apply the shared audit contract`);
  }
}

const registeredFiles = new Set(registry.agents.map((agent) => agent.path.split('/').at(-1)));
const attackerFiles = readdirSync(resolve(root, 'security-attacker-agents'))
  .filter((name) => name.endsWith('-attacker.md'));
for (const file of attackerFiles) {
  assert(registeredFiles.has(file), `Unregistered attacker brief: ${file}`);
}
assert(attackerFiles.length === registeredFiles.size, 'Registry and attacker brief counts differ');

const allCheckIds = [];
for (const core of registry.mandatory_core_checks) {
  assert(/^CORE-[0-9]{2}$/.test(core.check_id), `Invalid core check ID: ${core.check_id}`);
  assert(core.surface_id && core.description, `Incomplete core registry entry: ${core.check_id}`);
  allCheckIds.push(core.check_id);
}

for (const agent of registry.agents) {
  assert(agent.agent_id && agent.surface_id && agent.path && agent.check_prefix, 'Incomplete agent registry entry');
  assert(Array.isArray(agent.trigger_paths) && agent.trigger_paths.length > 0, `${agent.agent_id} has no trigger paths`);
  const matches = [...read(agent.path).matchAll(/\b([A-Z][A-Z0-9]*)-[0-9]{2}\b/g)].map((match) => match[0]);
  assert(matches.length > 0, `${agent.path} has no checklist IDs`);
  for (const id of matches) {
    assert(id.startsWith(`${agent.check_prefix}-`), `${id} does not match ${agent.agent_id}'s registered prefix`);
    allCheckIds.push(id);
  }
}

const duplicates = [...new Set(allCheckIds.filter((id, index) => allCheckIds.indexOf(id) !== index))];
assert(duplicates.length === 0, `Duplicate checklist IDs: ${duplicates.join(', ')}`);

const checkPattern = new RegExp(resultsSchema.$defs.observation.properties.check_id.pattern);
for (const id of allCheckIds) {
  assert(checkPattern.test(id), `Results schema rejects registered check ID: ${id}`);
}

const contract = read(registry.contract);
for (const term of [
  'FIRST_OBSERVATION',
  'REGRESSED',
  'RESOLVED',
  'coverage transition',
  'finding_id',
  '.pipeline/security-history/<run-id>/',
  'schemas/audit-run-manifest.schema.json',
  'schemas/audit-results.schema.json'
]) {
  assert(contract.includes(term), `Audit contract is missing progress requirement: ${term}`);
}

// PL-03a moved the security stage's authoritative procedure to .sdd/stages/security.md;
// .claude/agents/security-checker.md is now a generated pointer (see
// scripts/generate-agent-shims.mjs) with no procedural content of its own, so the integration
// check below has to read the neutral file instead.
const checker = read('.sdd/stages/security.md');
for (const reference of [
  registry.contract,
  registry.orchestrator,
  registryPath,
  registry.manifest_schema,
  registry.results_schema,
  '.pipeline/security-history/'
]) {
  assert(checker.includes(reference), `Security stage definition (.sdd/stages/security.md) is not integrated with ${reference}`);
}

console.log(`Security audit agent validation passed: ${registry.agents.length} surface briefs, ${allCheckIds.length} unique checks, 2 schemas.`);

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonOrThrow } from './pipeline-contracts.mjs';

const root = process.cwd();
const registryPath = 'security-attacker-agents/agent-registry.json';

function fail(message) {
  throw new Error(message);
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

// CORRECTED (round G1 / A4 — "the one remaining raw JSON.parse"): this file previously reasoned that
// plain `JSON.parse` was fine here because `security-attacker-agents/agent-registry.json` and the two
// JSON Schema files it points at (`registry.manifest_schema`/`registry.results_schema`) are static,
// git-tracked repository configuration, reviewed the normal way through a diff — unlike
// `security-history/<run-id>/{manifest,results}.json`, which is per-run agent output and which
// `scripts/validate-security-audit-run.mjs` already reads through `pipeline-contracts.mjs`'s
// `readJsonFile` for that reason (SEC-10). That distinction (static config vs. per-run output) is
// real and still holds — it is why `.sdd/bounds.yml` and `package.json` don't get this treatment
// either. But it answers the wrong question for THIS file specifically. "Reviewed the normal way
// through a diff" assumes a human reviewer would notice a duplicate key; a duplicate top-level
// `"agents"` array (or a duplicate entry inside it) resolves silently to "last one wins" under plain
// `JSON.parse`, and this registry's `agents` array is exactly what decides which security-attacker
// briefs run — a change here does not fail loud, it fails by silently narrowing what gets checked at
// all, which is the same "accepted by comment" shape SEC-10 and the markdown-parsing rounds before it
// each turned out to hide a real gap. `parseJsonOrThrow` (scripts/pipeline-contracts.mjs) rejects a
// duplicate key outright rather than resolving it, at the cost of one import and no behavior change
// for any registry that was already well-formed. If a future change reintroduces plain `JSON.parse`
// here, that is only safe if a duplicate key in this specific file can no longer change which checks
// run — e.g. if `mandatory_core_checks`/`agents` moved to a format where a repeated key is a syntax
// error on its own, not merely a redundant-looking write. Absent that, this stays on the strict
// parser deliberately.
function parseJson(path) {
  // parseJsonOrThrow already fails with a message prefixed by `path` (passed as its `label`) — no
  // need to wrap it a second time the way a plain `JSON.parse` catch block would have to.
  return parseJsonOrThrow(read(path), path);
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
const checker = read('.sdd/stages/security.md') + '\n' + read('.sdd/stages/security-full.md');
for (const reference of [
  registry.contract,
  registry.orchestrator,
  registryPath,
  registry.manifest_schema,
  registry.results_schema,
  '.pipeline/runs/'
]) {
  assert(checker.includes(reference), `Security stage definitions are not integrated with ${reference}`);
}

console.log(`Security audit agent validation passed: ${registry.agents.length} surface briefs, ${allCheckIds.length} unique checks, 2 schemas.`);

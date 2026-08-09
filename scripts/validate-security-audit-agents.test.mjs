// Tests scripts/validate-security-audit-agents.mjs — the static, git-tracked-config validator over
// security-attacker-agents/agent-registry.json (+ its two JSON schemas, the contract/orchestrator/
// attacker-brief markdown files, and .sdd/stages/security.md's own integration with all of the above).
//
// PL-04 review pass 2 / Critical 2: this script had zero test coverage and no CI step at all, despite
// G1's A4 changing it this same round — converting the registry/schema reads from plain `JSON.parse` to
// `parseJsonOrThrow` specifically because a duplicate top-level key in agent-registry.json resolves
// silently to "last one wins" under `JSON.parse`, and this registry's `agents` array is exactly what
// decides which security-attacker briefs run: a corrupted registry does not fail loudly, it fails by
// silently narrowing what gets checked at all. This is that coverage — at minimum, A4's own change.
//
// The script resolves every path relative to `process.cwd()` (`const root = process.cwd()`), not to
// its own module location, so exercising it against anything other than the real repo means spawning it
// with `cwd` pointed at a throwaway fixture that mirrors the exact relative layout it reads:
// security-attacker-agents/** (the registry, both schemas, the contract/orchestrator/attacker-brief
// files) and .sdd/stages/security.md. Built by copying the real repo's own security-attacker-agents/
// tree and .sdd/stages/security.md verbatim (fs.cpSync) rather than hand-constructing a minimal
// fixture — the validator cross-checks a lot of internal consistency (attacker-file/registry parity,
// checklist-ID prefixes matching each agent's registered check_prefix, contract-term presence,
// registry<->stage-file integration) that a hand-built fixture would have to painstakingly reproduce for
// no benefit; copying the real, already-valid tree once and then corrupting exactly the one field a
// test cares about is both simpler and a stronger guarantee that a genuinely passing baseline exists
// before any corruption is applied.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const scriptPath = resolve(scriptsDir, 'validate-security-audit-agents.mjs');

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A throwaway fixture root carrying an exact copy of the real repo's security-attacker-agents/ tree
 * and .sdd/stages/security.md — the two path families scripts/validate-security-audit-agents.mjs reads,
 * all resolved relative to `process.cwd()` (see that script's own `root = process.cwd()`). */
function fixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-security-audit-agents-'));
  roots.push(root);
  cpSync(resolve(repoRoot, 'security-attacker-agents'), join(root, 'security-attacker-agents'), { recursive: true });
  mkdirSync(join(root, '.sdd', 'stages'), { recursive: true });
  cpSync(resolve(repoRoot, '.sdd', 'stages', 'security.md'), join(root, '.sdd', 'stages', 'security.md'));
  return root;
}

function runValidator(root) {
  return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
}

test('accepts the real, unmodified security-attacker-agents/ registry — baseline sanity, so a later corruption test proves something rather than merely proving the fixture is already broken', () => {
  const root = fixtureRoot();
  const result = runValidator(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Security audit agent validation passed/);
});

test('[A4] rejects a duplicate top-level key in agent-registry.json rather than silently narrowing the brief set to "last one wins"', () => {
  const root = fixtureRoot();
  const registryPath = join(root, 'security-attacker-agents', 'agent-registry.json');
  const original = readFileSync(registryPath, 'utf8');

  // Raw text surgery, not JSON.parse + re-stringify — a JS object can never itself hold a duplicate
  // key, so the only way to construct this adversarial shape at all is to inject it into the raw text
  // directly, exactly as parseStrictJson's own header describes (pipeline-contracts.mjs). Tolerant of
  // line-ending/whitespace variation rather than pinning literal leading bytes.
  const duplicateKeyPattern = /^(\{\s*)("schema_version"\s*:\s*"1\.0\.0",)/;
  assert.ok(duplicateKeyPattern.test(original), 'fixture assumption about agent-registry.json\'s leading "schema_version" field no longer holds — update this injection point');
  const corrupted = original.replace(duplicateKeyPattern, '$1$2\n  "schema_version": "9.9.9",');
  assert.notEqual(corrupted, original);
  writeFileSync(registryPath, corrupted, 'utf8');

  const result = runValidator(root);
  assert.notEqual(result.status, 0, 'a duplicate top-level key must fail the validator, not silently resolve to whichever value JSON.parse would pick');
  assert.match(result.stderr, /duplicate key/i);
});

test('[A4] rejects a duplicate key inside a nested object (a repeated "check_id" within one mandatory_core_checks entry), not only at the document\'s top level', () => {
  const root = fixtureRoot();
  const registryPath = join(root, 'security-attacker-agents', 'agent-registry.json');
  const original = readFileSync(registryPath, 'utf8');

  const nestedDuplicatePattern = /("check_id"\s*:\s*"CORE-01",)/;
  assert.ok(nestedDuplicatePattern.test(original), 'fixture assumption about a "CORE-01" check_id field no longer holds — update this injection point');
  const corrupted = original.replace(nestedDuplicatePattern, '$1\n      "check_id": "CORE-99",');
  assert.notEqual(corrupted, original);
  writeFileSync(registryPath, corrupted, 'utf8');

  const result = runValidator(root);
  assert.notEqual(result.status, 0, 'a duplicate key inside a nested object must fail the same as one at the top level — duplicate-key rejection is scoped per object literal, not per document');
  assert.match(result.stderr, /duplicate key/i);
});

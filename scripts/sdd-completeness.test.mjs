// Tests for PL-03a acceptance criterion 4 ("every .sdd/ file is complete and readable without
// reference to any runtime-specific file") and for the Deviation (3) finding flagged in
// .pipeline/changes.md: scripts/validate-security-audit-run.mjs still content-hashes
// .claude/agents/security-checker.md, which this same ticket turned into a five-line generated
// pointer. This file checks the .sdd/ tree's static content directly (no subprocess needed) —
// conventions otherwise follow scripts/check-secret-access.test.mjs (node:test, no new framework).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

// --- AC 4: every .sdd/ file exists and is non-trivially readable -------------------------------

test('every .sdd/ top-level and stage file exists and is non-empty', () => {
  const paths = [
    '.sdd/README.md',
    '.sdd/runtimes.yml',
    '.sdd/pipeline.md',
    '.sdd/bounds.md',
    '.sdd/ledger/README.md',
    '.sdd/stages/planner.md',
    '.sdd/stages/dev.md',
    '.sdd/stages/tester.md',
    '.sdd/stages/review.md',
    '.sdd/stages/security.md',
  ];
  for (const path of paths) {
    assert.ok(existsSync(resolve(repoRoot, path)), `${path} does not exist`);
    const contents = read(path);
    assert.ok(contents.trim().length > 0, `${path} is empty`);
  }
});

test('every .sdd/stages/*.md file is readable standalone (no unresolved reference to a runtime-specific file as its only content)', () => {
  // Each stage file may *mention* .sdd/runtimes.yml (for tool grants/model tier, which are
  // legitimately runtime-specific per the spec's Interfaces table) but must contain its own
  // procedure, not just a pointer — i.e. it must be substantially longer than a generated shim
  // pointer body (the .claude/agents/*.md shims are ~5 lines; the neutral stage files should not be).
  for (const stage of ['planner', 'dev', 'tester', 'review', 'security']) {
    const contents = read(`.sdd/stages/${stage}.md`);
    const lineCount = contents.split('\n').length;
    assert.ok(lineCount > 15, `${stage}.md looks too short (${lineCount} lines) to be a standalone procedure, not just a pointer`);
  }
});

// --- AC 4 (D-005's highest-value file): security.md must retain the substantive markers the ----
// security methodology depends on, verbatim, after extraction from .claude/agents/security-checker.md

test('.sdd/stages/security.md retains the substantive markers the security methodology depends on', () => {
  const security = read('.sdd/stages/security.md');
  const requiredMarkers = [
    'security-attacker-agents/audit-contract.md',
    'security-attacker-agents/agent-registry.json',
    'security-attacker-agents/schemas/audit-run-manifest.schema.json',
    'security-attacker-agents/schemas/audit-results.schema.json',
    'UNVERIFIED',
    '.pipeline/security-history/',
  ];
  for (const marker of requiredMarkers) {
    assert.ok(security.includes(marker), `.sdd/stages/security.md is missing required marker: ${marker}`);
  }

  // The exact BLOCKED conditions (progress-classification gate) — a silent truncation of any one
  // of these during extraction is the highest-cost failure mode this ticket could introduce.
  const blockedConditions = [
    'tenant-isolation or RBAC-boundary failure',
    'CRITICAL or HIGH failure or regression',
    'lost coverage on a CRITICAL or HIGH boundary',
    'missing selected-check rows, invalid normalized data, or overwritten run history',
    'without authorized dynamic evidence',
  ];
  for (const condition of blockedConditions) {
    assert.ok(security.includes(condition), `.sdd/stages/security.md is missing BLOCKED condition: "${condition}"`);
  }

  assert.ok(
    security.includes('Risk acceptance never converts a result to') && security.includes('PASS'),
    '.sdd/stages/security.md must state that risk acceptance cannot override the tenant/RBAC gate'
  );
});

// --- AC 8: git ls-files AGENTS.md .sdd returns results; git ls-files .codex .agents is empty ----

test('AGENTS.md and .sdd/ are tracked; .codex/ and .agents/ are not', () => {
  const tracked = execFileSync('git', ['ls-files', 'AGENTS.md', '.sdd'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  assert.ok(tracked.length > 0, 'expected git ls-files AGENTS.md .sdd to return results');

  const deleted = execFileSync('git', ['ls-files', '.codex', '.agents'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  assert.equal(deleted, '', 'expected git ls-files .codex .agents to return nothing');
});

// --- Fix (review C3): the audit manifest's content hash must cover the procedure actually --------
// followed at runtime, not only the generated pointer to it.
//
// scripts/validate-security-audit-run.mjs originally (and still) treats
// .claude/agents/security-checker.md as a content-hashed source of the security stage's policy
// (both as every core check's expected `brief_path`, and in the manifest's `agent_versions`
// content-hash set). PL-03a turned that file into a five-line generated pointer (see
// scripts/generate-agent-shims.mjs) whose body no longer contains the security procedure at all —
// that now lives in .sdd/stages/security.md. Originally only the pointer was hashed, which made
// the manifest's tamper-evidence vacuous (rewriting the real procedure left the pointer's hash
// unchanged). Fixed: the validator's requiredSources now hashes both files — see
// scripts/validate-security-audit-run.mjs.

test('validate-security-audit-run.mjs requires a content hash for both the generated pointer and the neutral procedure it points to', () => {
  const validator = read('scripts/validate-security-audit-run.mjs');
  assert.match(
    validator,
    /'\.sdd\/stages\/security\.md'/,
    'expected the manifest validator to require a content hash for the neutral security procedure (review finding C3)'
  );
  assert.match(
    validator,
    /'\.claude\/agents\/security-checker\.md'/,
    'expected the manifest validator to still require a content hash for the generated shim too (S2) — it still carries tool grants/hook wiring worth pinning'
  );
});

test('the now-hashed neutral file actually contains the security procedure the generated pointer no longer does', () => {
  const hashedPointer = read('.claude/agents/security-checker.md');
  const hashedNeutralFile = read('.sdd/stages/security.md');

  // The generated shim is just a pointer...
  assert.match(hashedPointer, /GENERATED by scripts\/generate-agent-shims\.mjs/);
  assert.ok(
    !hashedPointer.includes('security-attacker-agents/audit-contract.md'),
    'the generated shim has no procedural content of its own — that is expected and fine now that the neutral file is also hashed'
  );

  // ...while the actual procedure, now also covered by the manifest's content hash, lives here.
  assert.ok(hashedNeutralFile.includes('security-attacker-agents/audit-contract.md'));
  assert.ok(hashedNeutralFile.includes('UNVERIFIED'));

  // Net effect (post-fix): rewriting .sdd/stages/security.md — the file actually followed at
  // runtime — now changes a content hash the manifest validator checks, so the "this policy was
  // not tampered with" guarantee covers the policy that actually governs the audit again.
});

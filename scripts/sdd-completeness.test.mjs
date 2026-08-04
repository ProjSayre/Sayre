// Tests for PL-03a acceptance criterion 4 ("every .sdd/ file is complete and readable without
// reference to any runtime-specific file") and for the Deviation (3) finding flagged in
// .pipeline/changes.md: scripts/validate-security-audit-run.mjs still content-hashes
// .claude/agents/security-checker.md, which this same ticket turned into a five-line generated
// pointer. This file checks the .sdd/ tree's static content directly (no subprocess needed) —
// conventions otherwise follow scripts/check-secret-access.test.mjs (node:test, no new framework).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    '.sdd/ledger/index.json',
    '.sdd/stages/planner.md',
    '.sdd/stages/red.md',
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
  for (const stage of ['planner', 'red', 'dev', 'tester', 'review', 'security']) {
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

// --- PL-03c: the `red` stage exists, is registered, and retains its substantive guarantees -------

test('.sdd/runtimes.yml declares a red stage pointing at stages/red.md, on the opus tier', () => {
  const runtimes = read('.sdd/runtimes.yml');
  const redIndex = runtimes.indexOf('\n  red:');
  assert.ok(redIndex !== -1, 'expected a top-level "  red:" stage entry in runtimes.yml');
  // Isolate the red: block up to the next top-level (two-space-indented) stage key, so "model:
  // opus" is checked against red's own block, not some other stage's.
  const nextStageIndex = runtimes.indexOf('\n  dev:', redIndex);
  assert.ok(nextStageIndex > redIndex, 'expected "  dev:" to follow "  red:" in runtimes.yml');
  const redBlock = runtimes.slice(redIndex, nextStageIndex);
  assert.match(redBlock, /neutral: stages\/red\.md/, 'red stage must point at stages/red.md');
  assert.match(redBlock, /model: opus/, 'red stage must run on the opus tier per spec.md');
});

test('.claude/agents/red.md is a generated shim pointing at .sdd/stages/red.md', () => {
  const shim = read('.claude/agents/red.md');
  assert.match(shim, /GENERATED by scripts\/generate-agent-shims\.mjs/);
  assert.match(shim, /Follow `\.sdd\/stages\/red\.md` exactly/);
});

test('.sdd/stages/red.md retains the substantive guarantees this stage exists to provide', () => {
  const red = read('.sdd/stages/red.md');
  const requiredMarkers = [
    'RED-CORRECT',
    'RED-BROKEN',
    'RED-DEFERRED',
    '@spec',
    'SHA-256',
    'Content hashes',
    'Test paths',
  ];
  for (const marker of requiredMarkers) {
    assert.ok(red.includes(marker), `.sdd/stages/red.md is missing required marker: ${marker}`);
  }
  // AC 2: red must refuse to finish with a RED-BROKEN test left in it. Two independent sentences —
  // the procedural refusal (step 5) and the output-contract restatement — are both pinned, so a
  // partial edit that softens one while leaving the other untouched still fails this test.
  assert.match(red, /may not finish this stage while any test is `RED-BROKEN`/);
  assert.match(red, /No `RED-BROKEN` entry may appear anywhere in a finished `red\.md`/, 'red.md\'s Output contract must restate the refusal, not just the Procedure section');
  // AC 6 / D-006: the impact map's (un)availability must be disclosed, never implied away.
  // Migrated: PL-03b's resolver has since been wired into this stage, so the disclosure is no longer
  // "the tool does not exist" (a permanent, repo-wide fact) but "the workers' Poetry environment is
  // not available in this checkout" (a conditional, per-checkout fact) — the same D-006 discipline,
  // pointed at the honest reason that actually applies now. (Whitespace-tolerant: the source wraps
  // this phrase across a line break at ~100 columns.)
  assert.match(red, /Poetry environment is not\s+available in this checkout/, 'red.md must state the resolver\'s unavailability explicitly when the Poetry environment is missing, not silently proceed');
});

test('.sdd/stages/tester.md is rewritten off changes.md per D-018, and does not author behavioral tests', () => {
  const tester = read('.sdd/stages/tester.md');
  assert.ok(tester.includes('You do not author behavioral tests'), 'tester.md must state the D-018 inversion explicitly');
  assert.ok(tester.includes('it is not an input for deriving assertions'), 'tester.md must state changes.md is not used to derive assertions');
  assert.ok(tester.includes('you do not write it'), 'tester.md must state a spotted behavioral gap is reported, not filled');
  // AC 5, restated: the Output contract must also require the report, not just the Procedure prose —
  // same "pin both halves" defense as red.md's RED-BROKEN check above.
  assert.ok(tester.includes('Reported behavioral gaps'), 'tester.md\'s Output contract must have a dedicated section for reported (not authored) behavioral gaps');
  // Migrated (same reasoning as red.md's equivalent test above): the resolver now exists and is
  // wired into this stage, so the disclosure is conditional on the Poetry environment, not permanent.
  assert.match(tester, /Poetry environment is not\s+available in this checkout/, 'tester.md must state the resolver\'s unavailability explicitly when the Poetry environment is missing, not silently proceed');
  assert.ok(tester.includes('Affected-test regression results'), 'tester.md\'s Output contract must have a dedicated section for the impact resolver\'s regression run (the half of TDAD tester now performs)');
});

test('.sdd/stages/review.md checks red-test integrity and spec trace', () => {
  const review = read('.sdd/stages/review.md');
  assert.ok(review.includes('Red-test integrity'), 'review.md must check red-test integrity');
  assert.ok(review.includes('Spec trace'), 'review.md must check the @spec trace');
  // PL-03h moved the content-hash table out of red.md's prose and into red.json, because reading
  // a control input out of a markdown document is the defect that ticket exists to remove. The
  // assertion's intent is unchanged — review must still recompute hashes over the full set red
  // recorded — so it is retargeted at the JSON contract rather than dropped.
  assert.match(
    review,
    /recomputes the SHA-256 content hash of every file `red\.json`'s `tests` array lists/,
    'review.md must rehash every file red.json records, not a subset and not a prose table',
  );
  assert.ok(review.includes('@spec'), 'review.md must reference the @spec marker convention');
  // AC 3 / AC 4: both checks must be wired to the fail-closed verdict, not left as an observation
  // with no consequence — an undeclared hash mismatch or an unresolvable @spec ID must produce
  // NEEDS_FIXES, and the passing exception (declared in changes.md) must be named explicitly.
  // PL-03h: the declaration moved from changes.md's prose to changes.json's structured
  // redTestChanges array. The property asserted is unchanged — an undeclared hash mismatch must
  // force NEEDS_FIXES, and the one passing exception must be named rather than left implicit.
  assert.match(review, /mismatch is `NEEDS_FIXES`\s*\*\*unless\*\*\s*`changes\.json`\s*declares the change/, 'review.md must make an undeclared red-test hash mismatch NEEDS_FIXES, with the declared-in-changes.json exception named');
  assert.match(review, /citing no `@spec` marker at all, is `NEEDS_FIXES`/, 'review.md must make an uncited new behavioral test NEEDS_FIXES');
  assert.match(review, /uncited\/unresolvable `@spec` reference/, 'review.md\'s Critical list must name the uncited/unresolvable @spec case explicitly');
});

test('.sdd/stages/planner.md requires stable AC-*/EC-* IDs', () => {
  const planner = read('.sdd/stages/planner.md');
  assert.match(planner, /`AC-1`, `AC-2`/);
  assert.match(planner, /`EC-1`, `EC-2`/);
  assert.ok(planner.includes('preserve every existing'), 'planner.md must require preserving IDs across a spec amendment, not renumbering');
});

// --- PL-03e (wiring pass): spec.md's first section is a plain-English Ticket Check ----------------

test('.sdd/stages/planner.md requires "Ticket Check" as spec.md\'s first section, with exactly its four required items', () => {
  const planner = read('.sdd/stages/planner.md');
  assert.match(planner, /"Ticket Check" is always first/, 'Ticket Check must be documented as spec.md\'s first section, not merely present somewhere');
  const requiredItems = [
    "What I'm about to build",
    "What I'm explicitly not doing",
    "How you'll know it worked",
    'What I had to guess',
  ];
  for (const item of requiredItems) {
    assert.ok(planner.includes(item), `planner.md's Ticket Check must require the item: "${item}"`);
  }
  // The section's whole point is being readable by a non-engineer — pin that constraint explicitly,
  // not just the four item names, since a planner could satisfy the names while writing them in
  // full engineering jargon.
  assert.ok(planner.includes('no signatures, no file paths, no jargon') || planner.includes('no jargon'), 'planner.md must state Ticket Check is written for a non-engineer, with no jargon/paths/signatures');
});

test('.sdd/stages/planner.md reads the ticket\'s declared lane and records it in spec.json, defaulting to null when absent', () => {
  const planner = read('.sdd/stages/planner.md');
  assert.ok(planner.includes('.github/ISSUE_TEMPLATE/pipeline-ticket.yml'), 'planner.md must name the issue template lane is read from');
  assert.match(planner, /"lane"/, 'planner.md\'s spec.json shape must document a "lane" field');
  assert.ok(planner.toLowerCase().includes('null'), 'planner.md must state lane defaults to/records null when the ticket declares none');
});

test('.sdd/pipeline.md documents the six-stage sequence and the ledger step', () => {
  const pipeline = read('.sdd/pipeline.md');
  assert.match(pipeline, /planner.*red.*dev.*tester.*review.*security/s);
  assert.ok(pipeline.includes('ledger-append.mjs'));
  assert.ok(pipeline.includes('terminal `PASS`') || pipeline.includes('terminal PASS'));
});

// --- D-005 #3 / `/hotfix`: wired into .sdd/pipeline.md's entry-point section ---------------------

test('.sdd/pipeline.md documents /hotfix as an entry point, pointing at .sdd/hotfix.md and the --hotfix ledger flag', () => {
  const pipeline = read('.sdd/pipeline.md');
  assert.match(pipeline, /### `\/hotfix/, 'expected a dedicated /hotfix entry-point section');
  assert.ok(pipeline.includes('.sdd/hotfix.md'), 'the /hotfix section must point at .sdd/hotfix.md as the authoritative definition');
  assert.ok(pipeline.includes('ledger-append.mjs --hotfix'), 'the /hotfix section must name the ledger flag that writes its bypass entry');
  assert.ok(pipeline.includes('follow-up ticket'), 'the /hotfix section must restate the non-negotiable follow-up ticket requirement');
});

// --- PL-03d/PL-03i: pr-review is registered as a real stage, not just documented -----------------

test('.sdd/runtimes.yml registers pr-review pointing at stages/pr-review.md', () => {
  const runtimes = read('.sdd/runtimes.yml');
  assert.match(runtimes, /\n  pr-review:\n\s+neutral: stages\/pr-review\.md/);
});

test('.claude/agents/pr-review.md is a generated shim pointing at .sdd/stages/pr-review.md', () => {
  const shim = read('.claude/agents/pr-review.md');
  assert.match(shim, /GENERATED by scripts\/generate-agent-shims\.mjs/);
  assert.match(shim, /Follow `\.sdd\/stages\/pr-review\.md` exactly/);
});

test('scripts/guard-checker-readonly.mjs treats pr-review as read-only, per its own stage file\'s explicit warning', () => {
  const guard = read('scripts/guard-checker-readonly.mjs');
  assert.match(guard, /READ_ONLY_AGENTS = new Set\(\[[^\]]*'pr-review'[^\]]*\]\)/);
});

// --- PL-03c: the ledger is populated, tracked, and durable ----------------------------------------

test('.sdd/ledger/index.json is valid JSON mapping file paths to run references', () => {
  const index = JSON.parse(read('.sdd/ledger/index.json'));
  assert.ok(typeof index === 'object' && index !== null && !Array.isArray(index));
  const anyPath = Object.keys(index)[0];
  assert.ok(anyPath, 'expected at least one indexed file (PL-03a\'s migrated entry)');
  const references = index[anyPath];
  assert.ok(Array.isArray(references) && references.length > 0);
  for (const key of ['runId', 'ticket', 'date', 'spec']) {
    assert.ok(key in references[0], `index.json entries must carry a "${key}" field`);
  }
});

test('PL-03a is present as ledger entry #1 with its real verdicts, run id, and an honest no-red-stage note', () => {
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const entry = read(`.sdd/ledger/${runId}/entry.md`);
  const spec = read(`.sdd/ledger/${runId}/spec.md`);

  assert.match(spec, /^# PL-03a/, 'migrated spec.md should be PL-03a\'s spec, verbatim');
  assert.ok(entry.includes('review: PASS'));
  assert.ok(entry.includes('security: PASS'));
  assert.ok(entry.includes(runId));
  // The whole point of the migration edge case: this entry must not claim a red stage ran for a
  // ticket that predates the red stage's own existence.
  assert.ok(
    entry.toLowerCase().includes('predates') || entry.toLowerCase().includes('no `red` stage existed'),
    'PL-03a\'s ledger entry must honestly record that no red stage ran, not backfill a fiction',
  );
});

// Note: as of this PL-03c run, .sdd/ledger/<run-id>/{spec.md,entry.md} and .sdd/ledger/index.json
// are new, uncommitted working-tree files (same as PL-03a's own ledger-relevant files were, right up
// until PL-03a's commit landed) — `git ls-files` on them is legitimately empty right now, and a test
// asserting `tracked.length > 0` the way the PL-03a AC8 test above does would be premature and wrong
// to demand pre-commit. That is NOT the same claim as "these paths are excluded from tracking" —
// the meaningful, currently-checkable invariant is that git does not ignore them (they are eligible
// to be staged and committed), confirmed with `git check-ignore` (a real git plumbing command),
// never by reading .gitignore's text and inferring intent from it.
test('git (not .gitignore text) confirms the ledger tracking boundary: ledger content is not ignored, .pipeline/ working files still are', () => {
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';

  function isIgnored(relativePath) {
    // git check-ignore exits 1 for "not ignored", 0 for "ignored" — the opposite of most Unix tools,
    // and exactly why this must be asserted via the actual exit code rather than string-matching
    // .gitignore's source, which only proves a rule exists, never that git applies it to this path.
    const result = spawnSync('git', ['check-ignore', '-q', relativePath], { cwd: repoRoot });
    assert.ok(result.status === 0 || result.status === 1, `git check-ignore on ${relativePath} exited unexpectedly: ${result.status}, stderr: ${result.stderr}`);
    return result.status === 0;
  }

  // Ledger content — new run's spec.md/entry.md, its backfilled security/ copy (round 3), and the
  // regenerated index.json — must be trackable.
  for (const relativePath of [
    `.sdd/ledger/${runId}/spec.md`,
    `.sdd/ledger/${runId}/entry.md`,
    `.sdd/ledger/${runId}/security/manifest.json`,
    `.sdd/ledger/${runId}/security/results.json`,
    `.sdd/ledger/${runId}/security/report.md`,
    '.sdd/ledger/index.json',
  ]) {
    assert.equal(isIgnored(relativePath), false, `${relativePath} must NOT be gitignored — it is the durable ledger surface`);
  }

  // .pipeline/ working files stay ignored — checked against files that actually exist on disk right
  // now in this checkout, via the same git command, not by re-reading .gitignore's source text.
  for (const relativePath of ['.pipeline/changes.md', '.pipeline/review.md', '.pipeline/spec.md', '.pipeline/security-report.md']) {
    if (!existsSync(resolve(repoRoot, relativePath))) continue;
    assert.equal(isIgnored(relativePath), true, `${relativePath} must still be gitignored`);
  }

  // The one documented carve-out must remain trackable.
  assert.equal(isIgnored('.pipeline/README.md'), false, '.pipeline/README.md must NOT be gitignored (documented carve-out)');
});

test('.pipeline/** stays gitignored — only ledger content and .pipeline/README.md are tracked', () => {
  const gitignore = read('.gitignore');
  assert.ok(gitignore.includes('.pipeline/**'));
  assert.ok(gitignore.includes('!.pipeline/README.md'));
  // .sdd/ledger/ must not be re-excluded anywhere in .gitignore.
  assert.ok(!/^\s*\.sdd\/ledger/m.test(gitignore), '.sdd/ledger/ must not be gitignored — it is the durable, tracked surface');
});

// --- PL-03c: the PL-03a migration is a mechanically-verifiable fact, not an assertion taken on trust

test('the migrated PL-03a ledger entry\'s "Files touched" list matches the real commit\'s actual changed-file set', () => {
  // e3134fe is the commit spec.md's migration instructions name as where PL-03a actually landed —
  // cross-checking entry.md's hand-written list against git's own record of that commit closes the
  // one gap a byte-diff against spec.md can't: whether the *metadata* (not just the spec text) is real.
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const entry = read(`.sdd/ledger/${runId}/entry.md`);
  const section = entry.split('## Files touched')[1].split('## Verdicts')[0];
  const listedFiles = [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1].trim()).sort();

  const stat = execFileSync('git', ['show', '--stat', '--format=', 'e3134feb2090a5b37f63f0ec8a686c5ea88538eb'], { cwd: repoRoot, encoding: 'utf8' });
  const actualFiles = stat
    .split(/\r?\n/)
    .filter((line) => line.includes('|'))
    .map((line) => line.split('|')[0].trim())
    .filter(Boolean)
    .sort();

  assert.ok(actualFiles.length > 0, 'expected `git show --stat` to list at least one changed file for e3134fe');
  assert.deepEqual(listedFiles, actualFiles, 'entry.md\'s "Files touched" list must match e3134fe\'s real changed-file set exactly — no fabricated or dropped files');
});

test('the migrated PL-03a spec.md and entry.md have not silently drifted from the verified migration (pinned content hash)', () => {
  // These hashes were computed directly against the preserved pre-migration scratchpad copy of
  // PL-03a's spec.md (byte-compared equal at migration-verification time) and against entry.md as
  // hand-written for this ticket. Pinning them here doesn't re-prove the original migration was
  // faithful — that evidence was necessarily a point-in-time comparison against an ephemeral,
  // outside-the-repo file that no committed artifact can reproduce — but it does guard against any
  // *future* silent edit to either file going unnoticed, the same content-hash discipline `red.md`
  // and `review.md` use for red tests.
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  const specHash = createHash('sha256').update(read(`.sdd/ledger/${runId}/spec.md`)).digest('hex');
  const entryHash = createHash('sha256').update(read(`.sdd/ledger/${runId}/entry.md`)).digest('hex');
  assert.equal(specHash, '0af1c4384a72b5f1b040cf719ba6dd64038cd407fa8ecfad646f94e0ff387a93', 'PL-03a\'s migrated spec.md changed since this hash was pinned — verify the change is intentional before updating this constant');
  assert.equal(entryHash, 'c7bf82387a3131945529dfd65a772de2a9f675326e2673cc05be05a1809020c1', 'PL-03a\'s migrated entry.md changed since this hash was pinned — verify the change is intentional before updating this constant');
});

test('PL-03a\'s backfilled security/ copy (round 3) is byte-identical to its source security-history run', () => {
  // PL-03c round 3 backfilled entry #1's security/ subdirectory (see .sdd/ledger/README.md) from
  // its own .pipeline/security-history/<run-id>/ directory, using the same copySecurityHistoryIntoLedger
  // helper a normal ledger-append.mjs run uses — this is the mechanical proof the copy is faithful,
  // the same discipline the "Files touched" cross-check above applies to the rest of the migration.
  const runId = '20260731T230940936Z-90330fb19231-PR_DELTA-bf73ea';
  for (const fileName of ['manifest.json', 'results.json', 'report.md']) {
    const ledgerCopy = read(`.sdd/ledger/${runId}/security/${fileName}`);
    const sourcePath = resolve(repoRoot, '.pipeline', 'security-history', runId, fileName);
    if (!existsSync(sourcePath)) continue; // .pipeline/ is gitignored working state; absent on some checkouts.
    assert.equal(ledgerCopy, readFileSync(sourcePath, 'utf8'), `.sdd/ledger/${runId}/security/${fileName} must be byte-identical to its .pipeline/security-history/ source`);
  }
});

// --- PL-03c: CI actually gates the new scripts, not just documents them --------------------------

test('CI runs the ledger-index staleness check and the two new test suites', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('check:ledger-index'), 'CI must gate .sdd/ledger/index.json staleness the same way it gates agent shims');
  assert.ok(ci.includes('test:ledger-index'));
  assert.ok(ci.includes('test:ledger-append'));
});

// Tests for PL-03a acceptance criterion 4 ("every .sdd/ file is complete and readable without
// reference to any runtime-specific file") and for the Deviation (3) finding flagged in
// .pipeline/changes.md: scripts/validate-security-audit-run.mjs still content-hashes
// .claude/agents/security-checker.md, which this same ticket turned into a five-line generated
// pointer. This file checks the .sdd/ tree's static content directly (no subprocess needed) —
// conventions otherwise follow scripts/check-secret-access.test.mjs (node:test, no new framework).
//
// PL-04 rewrite: several assertions below used to pin an exact human-written sentence from a
// stage file (e.g. the precise wording of a refusal, or of a BLOCKED trigger clause). A later,
// purely cosmetic rewording of that sentence made every one of those assertions pass or fail on
// prose rather than on the guarantee it exists to protect, and the pressure in that moment is to
// weaken the assertion rather than fix the doc. Assertions that were pinning prose are now scoped
// to the section/bullet the guarantee lives in (a heading or bold-label string — legitimately
// pinned, since several of these ARE what a script mechanically parses) and check that the
// load-bearing concepts co-occur there, tolerant of exact wording. A verdict literal, a filename,
// a JSON field name, a command name, or a content hash on an immutable historical artifact is still
// pinned exactly — those genuinely are the contract.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

// --- PL-04 structural-assertion helpers -------------------------------------------------------

// Slices `text` from just after the first occurrence of `startAnchor` to just before the next
// occurrence of `endAnchor` after that point. Anchors are literal substrings (a heading, a
// bold-label, a distinctive sentence fragment) — legitimate to pin exactly, since the point is to
// scope *where* we look, not to pin the sentence we're checking the content of.
function sectionBetween(text, startAnchor, endAnchor) {
  const startIdx = text.indexOf(startAnchor);
  assert.ok(startIdx !== -1, `expected to find "${startAnchor}"`);
  const from = startIdx + startAnchor.length;
  if (!endAnchor) return text.slice(from);
  const endIdx = text.indexOf(endAnchor, from);
  assert.ok(endIdx !== -1, `expected to find "${endAnchor}" after "${startAnchor}"`);
  return text.slice(from, endIdx);
}

// True when patternA and patternB both occur within `window` characters of each other, in either
// order — tolerant of a sentence being reworded or reordered as long as the two concepts stay
// close together, which is what actually makes them "the same guarantee" rather than two
// unrelated mentions.
function coOccurs(text, patternA, patternB, window = 200) {
  const forward = new RegExp(`${patternA.source}[\\s\\S]{0,${window}}${patternB.source}`, 'i');
  const backward = new RegExp(`${patternB.source}[\\s\\S]{0,${window}}${patternA.source}`, 'i');
  return forward.test(text) || backward.test(text);
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
});

// PL-04 (was folded into the test above; split out since it now checks a different thing — section
// structure and concept co-occurrence rather than literal markers): the exact BLOCKED conditions
// (progress-classification gate) — a silent truncation of any one of these during a rewrite is the
// highest-cost failure mode this stage's docs could suffer. Originally five exact clauses and one
// exact "risk acceptance never converts..." sentence were pinned verbatim; converted here to scope
// on the real "## Progress classification and gate" heading and require each trigger class's
// load-bearing concepts to still co-occur there, tolerant of exact wording.
test('.sdd/stages/security.md\'s Progress classification and gate section still names every BLOCKED trigger class and preserves the risk-acceptance override guarantee', () => {
  const security = read('.sdd/stages/security.md');
  const gate = sectionBetween(security, '## Progress classification and gate', '## Required artifacts');

  assert.match(gate, /\bBLOCKED\b/, 'the gate section must still name the BLOCKED verdict');

  // 1: a tenant-isolation or RBAC-boundary failure
  assert.match(gate, /tenant[- ]isolation/i, 'the gate section must still name a tenant-isolation failure as a trigger');
  assert.match(gate, /\bRBAC\b/, 'the gate section must still name an RBAC-boundary failure as a trigger');
  // 2: any current CRITICAL or HIGH failure or regression
  assert.match(gate, /\bCRITICAL\b/, 'the gate section must still name CRITICAL severity as a trigger');
  assert.match(gate, /\bHIGH\b/, 'the gate section must still name HIGH severity as a trigger');
  assert.match(gate, /\b(failure|regression)\b/i, 'the gate section must still name a failure/regression as a trigger');
  // 3: lost coverage on a CRITICAL or HIGH boundary
  assert.ok(
    coOccurs(gate, /\bcoverage\b/i, /\b(lost|loss)\b/i, 60),
    'the gate section must still name lost coverage on a critical boundary as a trigger',
  );
  // 4: missing selected-check rows, invalid normalized data, or overwritten run history
  assert.match(gate, /selected[- ]check/i, 'the gate section must still name missing selected-check rows as a trigger');
  assert.match(gate, /\binvalid\b/i, 'the gate section must still name invalid normalized data as a trigger');
  assert.match(gate, /\bhistory\b/i, 'the gate section must still name overwritten run history as a trigger');
  // 5: a runtime-dependent critical boundary represented as PASS without authorized dynamic evidence
  assert.match(gate, /dynamic evidence/i, 'the gate section must still name unauthorized dynamic evidence as a trigger');

  // Risk acceptance never converts a result to PASS and cannot override the tenant/RBAC gate.
  assert.match(gate, /risk acceptance/i, 'the gate section must still discuss risk acceptance');
  assert.ok(
    coOccurs(gate, /risk acceptance/i, /\bPASS\b/, 150),
    'the gate section must state risk acceptance cannot convert a result to PASS',
  );
  assert.ok(
    coOccurs(gate, /risk acceptance/i, /\b(tenant|RBAC)\b/i, 200),
    'the gate section must state risk acceptance cannot override the tenant/RBAC gate',
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

  // AC 2, structural (PL-04): red must refuse to finish with a RED-BROKEN test left in it. The
  // original test pinned two exact sentences — the procedural refusal in step 5, and the Output
  // contract's restatement — so a partial edit softening one while leaving the other untouched
  // still failed. Preserve that "pin both halves" defense structurally: each of the Procedure and
  // Output contract sections must independently co-occur the RED-BROKEN literal with a refusal
  // word, tolerant of exact phrasing.
  const refusal = /\b(may not|must not|cannot|refuses?\b|not allowed|not permitted)\b/i;
  const procedure = sectionBetween(red, '## Procedure', '## Output contract');
  const outputContract = sectionBetween(red, '## Output contract', '## Staleness of required inputs (PL-04)');
  assert.ok(
    coOccurs(procedure, /RED-BROKEN/, refusal, 250),
    'red.md\'s Procedure section must state, in refusal language, that this stage cannot finish while a test is RED-BROKEN',
  );
  assert.ok(
    coOccurs(outputContract, /RED-BROKEN/, refusal, 250),
    'red.md\'s Output contract section must independently restate the RED-BROKEN refusal, not rely solely on the Procedure section',
  );

  // AC 6 / D-006, structural (PL-04): the impact map's (un)availability must be disclosed, never
  // implied away. Rather than pinning the exact phrase "Poetry environment is not available in
  // this checkout" (already reworded/wrapped once by PL-03b's resolver landing), require the tool
  // name ("Poetry") to co-occur with an availability-negation concept within the Required inputs
  // section, tolerant of exact wording and line-wrapping.
  const requiredInputs = sectionBetween(red, '## Required inputs', '## Procedure');
  assert.ok(
    coOccurs(requiredInputs, /Poetry/, /\b(not available|unavailable|not set up|isn't available|is not usable)\b/i, 200),
    'red.md must state the resolver\'s unavailability explicitly when the Poetry environment is missing, not silently proceed',
  );
});

test('.sdd/stages/tester.md is rewritten off changes.md per D-018, and does not author behavioral tests', () => {
  const tester = read('.sdd/stages/tester.md');

  // Structural (PL-04): the D-018 inversion statement is this stage's central guarantee — scoped
  // to the intro (before "## Required inputs") and checked for the concept (a refusal word
  // co-occurring with "author"/"behavioral test"), tolerant of exact wording.
  const intro = tester.slice(0, tester.indexOf('## Required inputs'));
  assert.match(
    intro,
    /\b(do not|does not|never|must not)\b[\s\S]{0,60}\bauthor\b[\s\S]{0,80}\bbehavioral tests?\b/i,
    'tester.md\'s intro must state, in refusal language, that this stage does not author behavioral tests (the D-018 inversion)',
  );

  const requiredInputs = sectionBetween(tester, '## Required inputs', '## Procedure');
  // Structural (PL-04): changes.md is read for context only, never for deriving an assertion.
  assert.ok(
    coOccurs(requiredInputs, /changes\.md/, /\bnot\b[\s\S]{0,80}\b(deriving|derive)\b[\s\S]{0,40}\bassertions?\b/i, 250),
    'tester.md must state changes.md is not used to derive assertions',
  );
  // Migrated (same reasoning as red.md's equivalent check above): the resolver now exists and is
  // wired into this stage, so the disclosure is conditional on the Poetry environment, not permanent.
  assert.ok(
    coOccurs(requiredInputs, /Poetry/, /\b(not available|unavailable|not set up|isn't available|cannot run)\b/i, 200),
    'tester.md must state the resolver\'s unavailability explicitly when the Poetry environment is missing, not silently proceed',
  );

  const procedure = sectionBetween(tester, '## Procedure', '## Output contract');
  // Structural (PL-04): a spotted behavioral gap is reported, not filled — co-occurrence of
  // "missing"/gap language with a refusal-to-write word, tolerant of exact phrasing.
  assert.ok(
    coOccurs(procedure, /\bmissing\b/i, /\b(do not|does not|never)\b[\s\S]{0,40}\bwrite\b/i, 200),
    'tester.md must state a spotted behavioral gap is reported, not filled',
  );
  assert.match(procedure, /\breport\b[\s\S]{0,80}\bgap\b/i, 'tester.md must instruct reporting the gap rather than silently dropping it');

  // AC 5, restated: the Output contract must also require the report, not just the Procedure prose
  // — same "pin both halves" defense as red.md's RED-BROKEN check above. These are Output contract
  // heading names the stage's own report format depends on (structural section-heading markers,
  // not prose), so they stay pinned literally.
  assert.ok(tester.includes('Reported behavioral gaps'), 'tester.md\'s Output contract must have a dedicated section for reported (not authored) behavioral gaps');
  assert.ok(tester.includes('Affected-test regression results'), 'tester.md\'s Output contract must have a dedicated section for the impact resolver\'s regression run (the half of TDAD tester now performs)');
});

test('.sdd/stages/review.md checks red-test integrity and spec trace', () => {
  const review = read('.sdd/stages/review.md');
  assert.ok(review.includes('Red-test integrity'), 'review.md must check red-test integrity');
  assert.ok(review.includes('Spec trace'), 'review.md must check the @spec trace');

  // PL-03h moved the content-hash table out of red.md's prose and into red.json, because reading
  // a control input out of a markdown document is the defect that ticket exists to remove. The
  // assertion's intent is unchanged — review must still recompute hashes over the full set red
  // recorded. Structural (PL-04): rather than pinning the exact sentence "recomputes the SHA-256
  // content hash of every file `red.json`'s `tests` array lists", scope to the mechanical-half
  // bullet and require the load-bearing concepts (SHA-256, red.json, its `tests` array, hashing)
  // to all appear there.
  const mechanicalHalf = sectionBetween(review, 'Red-test integrity, mechanical half (the script):', 'Red-test integrity, judgment half (you):');
  assert.match(mechanicalHalf, /SHA-256/, 'review.md\'s Red-test integrity mechanical half must name the SHA-256 hash algorithm');
  assert.match(mechanicalHalf, /red\.json/, 'review.md\'s Red-test integrity mechanical half must name red.json as the source of the file list');
  assert.match(mechanicalHalf, /`tests`/, 'review.md\'s Red-test integrity mechanical half must name red.json\'s `tests` array specifically');
  assert.match(mechanicalHalf, /\bhash\b/i, 'review.md\'s Red-test integrity mechanical half must describe hashing, not just listing, those files');

  // AC 3 / AC 4: both checks must be wired to the fail-closed verdict, not left as an observation
  // with no consequence — an undeclared hash mismatch or an unresolvable @spec ID must produce
  // NEEDS_FIXES, and the passing exception (declared in changes.json) must be named explicitly.
  // Structural (PL-04): co-occurrence of the verdict literal, the exception keyword, and
  // changes.json's declaration mechanism within the judgment-half bullet, rather than the exact
  // original sentence.
  const judgmentHalf = sectionBetween(review, 'Red-test integrity, judgment half (you):', 'Spec trace, mechanical half (the script):');
  assert.match(judgmentHalf, /NEEDS_FIXES/, 'review.md\'s Red-test integrity judgment half must name the NEEDS_FIXES verdict');
  assert.match(judgmentHalf, /\bunless\b/i, 'review.md\'s Red-test integrity judgment half must name the declared-in-changes.json exception');
  assert.match(judgmentHalf, /changes\.json/, 'review.md\'s Red-test integrity judgment half must name changes.json as where the exception is declared');
  assert.match(judgmentHalf, /\bdeclar(e|es|ed|ation)\b/i, 'review.md\'s Red-test integrity judgment half must require the change to be declared, not merely present');

  // The uncited/unresolvable @spec case must force NEEDS_FIXES. Structural (PL-04): co-occurrence
  // of the verdict literal, the @spec marker, and an unresolvable/uncited concept within the
  // spec-trace judgment bullet.
  const specTraceJudgment = sectionBetween(review, 'Spec trace, judgment half (you):', '- **Architectural boundaries**');
  assert.match(specTraceJudgment, /@spec/, 'review.md\'s Spec trace judgment half must reference the @spec marker');
  assert.match(specTraceJudgment, /\bunresolvable\b/i, 'review.md\'s Spec trace judgment half must name an unresolvable @spec ID as a failure');
  assert.match(specTraceJudgment, /NEEDS_FIXES/, 'review.md\'s Spec trace judgment half must name the NEEDS_FIXES verdict');

  // review.md's Critical list must name the uncited/unresolvable @spec case explicitly, not just
  // describe the mechanism above — same "pin both halves" defense used elsewhere in this file.
  const criticalBullet = sectionBetween(review, '- **Critical**', '- **Warning**');
  assert.match(criticalBullet, /@spec/, 'review.md\'s Critical list must reference @spec');
  assert.match(criticalBullet, /\b(uncited|unresolvable)\b/i, 'review.md\'s Critical list must name the uncited/unresolvable @spec case explicitly');

  assert.ok(review.includes('@spec'), 'review.md must reference the @spec marker convention');
});

test('.sdd/stages/planner.md requires stable AC-*/EC-* IDs, in presentation order, for both Acceptance criteria and Edge cases', () => {
  const planner = read('.sdd/stages/planner.md');

  // Structural (PL-04): rather than matching the literal example text "`AC-1`, `AC-2`" (which
  // breaks if the doc is reworded to a different example, e.g. "AC-1 and AC-2" or three examples
  // instead of two), scope to each bullet's own text and require (a) at least two `AC-n`/`EC-n`
  // -shaped example IDs, showing a numbering scheme rather than one fixed ID, and (b) the phrase
  // "stable ID" — the actual load-bearing requirement — appears in that bullet specifically, not
  // just somewhere in the file.
  const acceptanceCriteria = sectionBetween(planner, '**Acceptance criteria**', '**Edge cases**');
  const edgeCases = sectionBetween(planner, '**Edge cases**', '**Open questions**');

  const acIds = acceptanceCriteria.match(/`AC-\d+`/g) || [];
  assert.ok(acIds.length >= 2, 'planner.md\'s Acceptance criteria bullet must show at least two `AC-n` example IDs, documenting the numbering scheme');
  assert.match(acceptanceCriteria, /stable\s+ID/i, 'planner.md\'s Acceptance criteria bullet must require a stable ID per item');

  const ecIds = edgeCases.match(/`EC-\d+`/g) || [];
  assert.ok(ecIds.length >= 2, 'planner.md\'s Edge cases bullet must show at least two `EC-n` example IDs, documenting the numbering scheme');
  assert.match(edgeCases, /stable\s+ID/i, 'planner.md\'s Edge cases bullet must require a stable ID per item');

  // The "don't renumber on amendment, preserve existing IDs" guarantee (originally pinned as the
  // literal phrase "preserve every existing"). Structural (PL-04): the co-occurrence of a
  // preserve/retain instruction and the word "renumber" in the amendment-handling paragraph,
  // rather than one fixed sentence.
  const amendmentGuidance = sectionBetween(planner, 'If spec.md is later amended', '## Staleness of required inputs (PL-04)');
  assert.match(amendmentGuidance, /\brenumber(ing)?\b/i, 'planner.md must address renumbering explicitly when spec.md is amended after red has run');
  assert.ok(
    coOccurs(amendmentGuidance, /\b(preserve|retain|keep)\b/i, /\b(AC-\*|EC-\*|existing ID|ID)\b/i, 150),
    'planner.md must instruct preserving/retaining existing AC-*/EC-* IDs, not renumbering them, on a spec amendment',
  );
});

// --- PL-03e (wiring pass): spec.md's first section is a plain-English Ticket Check ----------------

test('.sdd/stages/planner.md requires "Ticket Check" as spec.md\'s first section, with exactly its four required items', () => {
  const planner = read('.sdd/stages/planner.md');

  // Structural (PL-04): rather than matching the literal phrase '"Ticket Check" is always first',
  // verify the actual ordering guarantee directly — every named spec.md section (per planner.md's
  // own "in this order" instruction) must appear, in planner.md's own presentation order, after
  // "Ticket Check". This proves the same thing the prose claimed without depending on how the
  // claim is worded.
  const sectionNames = ['Ticket Check', 'Goal', 'Scope', 'Affected files', 'Interfaces / signatures', 'Approach', 'Acceptance criteria', 'Edge cases', 'Open questions'];
  const positions = sectionNames.map((name) => {
    const marker = `**${name}**`;
    const idx = planner.indexOf(marker);
    assert.ok(idx !== -1, `planner.md must list a "${name}" spec.md section`);
    return idx;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[0] < positions[i], `planner.md must document "Ticket Check" before "${sectionNames[i]}" — spec.md's Ticket Check section must come first`);
  }

  const requiredItems = [
    "What I'm about to build",
    "What I'm explicitly not doing",
    "How you'll know it worked",
    'What I had to guess',
  ];
  const ticketCheckSection = sectionBetween(planner, '**Ticket Check**', '**Goal**');
  for (const item of requiredItems) {
    assert.ok(ticketCheckSection.includes(item), `planner.md's Ticket Check must require the item: "${item}"`);
  }
  // Structural (PL-04): the section's whole point is being readable by a non-engineer — scoped to
  // the Ticket Check bullet itself (not the whole file) and checked for the two load-bearing
  // concepts (an explicit non-engineer audience and a no-jargon constraint) rather than the exact
  // three-item list "no signatures, no file paths, no jargon", since a planner could satisfy the
  // item names while writing them in full engineering jargon.
  assert.match(ticketCheckSection, /non-engineer/i, 'planner.md\'s Ticket Check section must name its audience as a non-engineer');
  assert.match(ticketCheckSection, /jargon/i, 'planner.md\'s Ticket Check section must state a no-jargon constraint');
});

test('.sdd/stages/planner.md reads the ticket\'s declared lane and records it in spec.json, defaulting to null when absent', () => {
  const planner = read('.sdd/stages/planner.md');
  assert.ok(planner.includes('.github/ISSUE_TEMPLATE/pipeline-ticket.yml'), 'planner.md must name the issue template lane is read from');
  assert.match(planner, /"lane"/, 'planner.md\'s spec.json shape must document a "lane" field');
  assert.ok(planner.toLowerCase().includes('null'), 'planner.md must state lane defaults to/records null when the ticket declares none');
});

test('.sdd/pipeline.md documents the six-stage sequence and the ledger step', () => {
  const pipeline = read('.sdd/pipeline.md');

  // Structural (PL-04): rather than the loose regex /planner.*red.*dev.*tester.*review.*security/s
  // (which only proves the six words appear in that relative order *somewhere* in the whole file,
  // not that they're the Stage sequence's own stage markers), scope to the "## Stage sequence"
  // section itself and assert each stage's bolded marker appears there in strictly increasing
  // order.
  const stageSequence = sectionBetween(pipeline, '## Stage sequence', '## Routing');
  const stageMarkers = ['**planner**', '**red**', '**dev**', '**tester**', '**review**', '**security**'];
  const positions = stageMarkers.map((marker) => {
    const idx = stageSequence.indexOf(marker);
    assert.ok(idx !== -1, `.sdd/pipeline.md's Stage sequence section must document ${marker}`);
    return idx;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i], `.sdd/pipeline.md's Stage sequence must list ${stageMarkers[i - 1]} before ${stageMarkers[i]}`);
  }

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

// PL-04 review pass 1 / Blocker 1: a script this round added (scripts/write-stamp.mjs,
// scripts/check-stamp-freshness.mjs) is exactly as capable of shipping with no CI step, silently,
// as the C1 blocker itself was of shipping with no caller — this pins that both suites are actually
// gated, not merely present in package.json's scripts map.
test('CI runs the two new stamp-script test suites (write-stamp.mjs, check-stamp-freshness.mjs)', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('test:write-stamp'), 'CI must run write-stamp.mjs\'s own test suite');
  assert.ok(ci.includes('test:stamp-freshness'), 'CI must run check-stamp-freshness.mjs\'s own test suite');
  const pkg = read('package.json');
  assert.ok(pkg.includes('"test:write-stamp"'), 'package.json must declare the test:write-stamp script CI runs');
  assert.ok(pkg.includes('"test:stamp-freshness"'), 'package.json must declare the test:stamp-freshness script CI runs');
});

// PL-04 review pass 2 / Critical 2: the two pins above name their suites literally — that closed the
// two instances dev found in pass 1, but could not catch a third. This round's own review found
// exactly a third and fourth: scripts/validate-security-audit-run.mjs's own test suite
// (test:security-audit-run) had a package.json script but no CI step at all, and
// scripts/validate-security-audit-agents.mjs (a script this same round changed — G1's A4) had neither
// a CI step nor a test suite of any kind. A suite nothing runs is indistinguishable from no tests.
// This is the generalized version of the two pins above: it enumerates every scripts/*.test.mjs file
// actually on disk and checks each one, rather than trusting a maintained list of literal names, so it
// catches the `test:security-audit-run` shape (a real suite with no CI step) again automatically,
// without anyone naming it.
//
// CORRECTED (PL-04 review pass 3 / Warning 1b): this comment, and `.sdd/stages/CHANGELOG.md`'s "Review
// pass 2" entry, both originally claimed this single assertion "would have caught all three gaps above"
// (all of pass 2's Blocker 2, plus the two pass-1 stamp-suite gaps). That overclaimed by two thirds of
// pass 2's own list. Of the three gaps Blocker 2 named: (1) `test:security-audit-run` — a suite on disk
// with no CI step — is exactly the shape this test enumerates and WAS genuinely caught; but (2)
// `check:security-audit-agents` — a `check:*` npm script with no CI step, not a `scripts/*.test.mjs`
// file — and (3) `validate-security-audit-agents.mjs` having no test suite AT ALL are both structurally
// outside a walk over test files that already exist on disk: there is nothing there to enumerate for
// either one. The two-thirds this assertion could never have caught are precisely the two shapes that
// actually bit this round. The test immediately below this one closes shape (3) for real (see its own
// comment for why shape (2) — a `check:*` script's own CI step, as opposed to its test suite's — is
// deliberately NOT generalized the same way: several `check:*` scripts legitimately have no CI step of
// their own at all, because they validate a specific per-run/gitignored `.pipeline/` artifact rather
// than committed static config, and a blanket rule here would be wrong about them, not merely silent).
test('every scripts/*.test.mjs suite has both a package.json "test:*" script and a matching CI step — a suite nothing runs is indistinguishable from no tests', () => {
  const testFiles = readdirSync(resolve(repoRoot, 'scripts'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  assert.ok(testFiles.length > 0, 'expected at least one scripts/*.test.mjs suite on disk to check — if this fails, the glob below is broken, not that coverage genuinely dropped to zero');

  const pkg = JSON.parse(read('package.json'));
  const ci = read('.github/workflows/ci.yml');

  // Built from each script's own VALUE (the command it actually runs), never guessed from its KEY via
  // a filename transform — there is no consistent filename -> key convention in this codebase (e.g.
  // guard-checker-readonly.test.mjs's own script is named "test:readonly-guard", not
  // "test:guard-checker-readonly"), so only the command text itself can say which file a script wires.
  const scriptKeyForFile = new Map();
  for (const [key, value] of Object.entries(pkg.scripts ?? {})) {
    if (typeof value !== 'string') continue;
    const match = value.match(/scripts\/([\w.-]+\.test\.mjs)\b/);
    if (match) scriptKeyForFile.set(match[1], key);
  }

  for (const file of testFiles) {
    const scriptKey = scriptKeyForFile.get(file);
    assert.ok(scriptKey, `scripts/${file} has no package.json script that actually runs it ("node --test scripts/${file}") — a test suite npm never invokes is dead weight, not coverage`);
    assert.ok(scriptKey.startsWith('test:'), `scripts/${file}'s own script ("${scriptKey}") does not follow the "test:*" naming convention every other suite's script uses`);
    assert.ok(ci.includes(scriptKey), `scripts/${file}'s own script ("${scriptKey}") has no step in .github/workflows/ci.yml — CI must actually run "npm run ${scriptKey}", not merely have it declared in package.json`);
  }
});

// PL-04 review pass 3 / Warning 1b: the test above enumerates scripts/*.test.mjs files that already
// exist on disk — it structurally cannot notice a control-plane validator script that has package.json
// wiring (a "check:*" entry) but no test suite at all, because there is no file for it to walk. That is
// exactly shape (3) from the comment above: validate-security-audit-agents.mjs had a check:* script
// (check:security-audit-agents) with no test:* counterpart and no test file, for an entire round, before
// this same round's fix added both. This test enumerates package.json's own "check:*" scripts instead —
// the other direction — and requires each to have a paired "test:*" script naming a real file, which
// (combined with the file-enumeration test above, once that file exists) closes the loop: a control-
// plane script can no longer ship with package.json wiring but no test suite, and if it does have a
// suite, that suite's own CI wiring is what the test above already checks.
//
// Deliberately narrower than "every check:* script must also have its own CI step" (shape (2), also
// named in the comment above) — that would be a false rule, not merely an unproven one: check:bounds,
// check:red-integrity, check:security-audit-run, and check:stamp-freshness all validate a specific
// per-run artifact under gitignored .pipeline/ working state (a run id, a lane, a diff base) that does
// not exist on a bare CI checkout, so .github/workflows/ci.yml deliberately runs only their test suites,
// never the check:* script itself — see that file's own comments at each of those steps. A blanket "has
// no ci.yml step for its own check:* command" assertion would fail loudly on all four of those, for a
// reason that is a legitimate design choice, not a gap. Distinguishing the two classes mechanically (is
// this specific check:* script's target a piece of committed static config, or a per-run/gitignored
// artifact its own command line doesn't even have the arguments for on a bare checkout?) would need
// either a maintained exception list — the exact "trusting a maintained list of literal names" shape
// this whole file's generalization effort exists to move away from — or actually invoking each script
// and inspecting why it fails, which is a materially different (and heavier) kind of test than this
// file's other assertions. Left as a narrower, true claim rather than a broader, false one.
test('every "check:<suffix>" script in package.json has a matching "test:<suffix>" script naming a real scripts/*.test.mjs file — a control-plane validator wired into package.json with no test suite at all is the other structural gap the file-enumeration test above cannot see', () => {
  const pkg = JSON.parse(read('package.json'));
  const scripts = pkg.scripts ?? {};
  const checkKeys = Object.keys(scripts).filter((key) => key.startsWith('check:'));
  assert.ok(checkKeys.length > 0, 'expected at least one "check:*" script in package.json to check — if this fails, package.json\'s scripts changed shape, not that coverage genuinely dropped to zero');

  for (const checkKey of checkKeys) {
    const suffix = checkKey.slice('check:'.length);
    const testKey = `test:${suffix}`;
    assert.ok(
      Object.prototype.hasOwnProperty.call(scripts, testKey),
      `package.json's "${checkKey}" has no matching "${testKey}" script — every existing "check:<suffix>"/"test:<suffix>" pair in this file follows that exact naming convention, and a "check:*" control-plane validator added without its "test:*" counterpart is precisely the "no test suite at all" gap validate-security-audit-agents.mjs shipped with for a full round`,
    );
    const testValue = scripts[testKey];
    const match = typeof testValue === 'string' ? testValue.match(/scripts\/([\w.-]+\.test\.mjs)\b/) : null;
    assert.ok(match, `package.json's "${testKey}" ("${testValue}") does not run a scripts/*.test.mjs suite via "node --test" — every other "test:*" script in this file points at a real test file the same way`);
    assert.ok(
      existsSync(resolve(repoRoot, 'scripts', match[1])),
      `package.json's "${testKey}" points at scripts/${match[1]}, which does not exist on disk — a declared test script with no backing file is indistinguishable from no test suite at all`,
    );
  }
});

// =================================================================================================
// [lite] PL-11 — the /pipeline-lite lane's documented half
// =================================================================================================
//
// Authored by the `red` stage from .pipeline/spec.md alone. These follow this file's existing
// structural-assertion discipline (see its header): scope to a real heading or bold label — those
// genuinely are the contract, and several are mechanically parsed elsewhere — then require the
// load-bearing concepts to co-occur inside it, tolerant of wording. A verdict literal, a filename, a
// JSON field name, and a command name are still pinned exactly.
//
// The lane's documentation is not decoration here. `/pipeline-lite` is the one entry point that
// deliberately runs neither `red` nor `security`, and the only thing standing between "a
// proportionate lane" and "a quiet way around the gates" is that its own definition says, in the
// same place a person actually reads, precisely what it gave up. An undocumented lite lane and a
// bypass are the same artifact.
//
// TWO CONVENTIONS EVERY ASSERTION BELOW FOLLOWS, both learned the hard way while authoring them:
//
//  1. Every alternation handed to `coOccurs` is wrapped in a non-capturing group. `coOccurs` splices
//     `patternB.source` straight into a larger pattern, so a bare `/a|b/` becomes a top-level
//     alternation of the WHOLE composed regex — `lite[\s\S]{0,400}red\.md` OR `absen` OR `missing` —
//     and the assertion then passes on any document containing the word "missing" anywhere, with no
//     co-occurrence involved at all. That is not a hypothetical: the first draft of the tester.md
//     assertion below passed against an unmodified tester.md for exactly this reason.
//  2. No `$` anchor against a repo document, and `\r?\n` wherever a newline is matched literally.
//     Every file read here is CRLF in this working tree (`.sdd/**`, `CLAUDE.md`, `package.json`,
//     `.github/workflows/ci.yml`), so `/^foo:$/m` silently never matches — the `\r` sits between
//     `foo:` and the line end.

/** The authoritative section for the lane, sliced by its own heading — placed between
 * `### `/pipeline <ticket>`` and `### Per-stage entry points` per spec.md's Interfaces section. */
function pipelineLiteSection() {
  return sectionBetween(read('.sdd/pipeline.md'), '### `/pipeline-lite', '### Per-stage entry points');
}

// @spec AC-1
test('[lite] .sdd/pipeline.md defines /pipeline-lite runtime-neutrally: the eligibility gate first, the stages run, the stages skipped, routing/loop-cap reuse, and the mandatory ledger step', () => {
  const pipeline = read('.sdd/pipeline.md');
  assert.match(pipeline, /### `\/pipeline-lite/, 'expected a dedicated /pipeline-lite entry-point section');

  const section = pipelineLiteSection();

  // The gate comes first, and it is mechanical — not a judgment call made in prose.
  assert.ok(section.includes('scripts/check-lite-eligible.mjs'), 'the section must name the script that computes eligibility');
  const gateIdx = section.indexOf('check-lite-eligible.mjs');
  const plannerIdx = section.indexOf('planner');
  assert.ok(gateIdx !== -1 && plannerIdx !== -1 && gateIdx < plannerIdx,
    'the eligibility gate is step one — a lane entered first and checked later has already skipped the gates for anything that turns out not to be small');

  // The stages that DO run, in order.
  let cursor = -1;
  for (const stage of ['planner', 'dev', 'tester', 'review']) {
    const idx = section.indexOf(stage, cursor + 1);
    assert.ok(idx > cursor, `the section must list ${stage} in sequence after the stage before it`);
    cursor = idx;
  }
  assert.ok(section.includes('ledger-append.mjs --lite'), 'the mandatory ledger step names the exact command that records the run');

  // The stages that deliberately do NOT run, named as skipped rather than merely absent.
  assert.ok(coOccurs(section, /\bred\b/, /skip/i, 200), 'the section must say `red` is skipped, not simply omit it');
  assert.ok(coOccurs(section, /\bsecurity\b/, /skip/i, 200), 'the section must say `security` is skipped, not simply omit it');

  // Routing and the loop cap are reused, not redefined.
  assert.match(section, /(?:\b3\b|three)/, 'the section must state that the existing 3-attempt loop cap applies');
  assert.match(section, /(?:loop cap|routing)/i);

  // Disambiguation from the two adjacent entry points.
  assert.ok(section.includes('/hotfix'), 'the section must disambiguate itself from /hotfix');
  assert.ok(section.includes('/re-gate'), 'the section must disambiguate itself from /re-gate');
});

// @spec AC-1
test('[lite] /pipeline-lite is listed in .sdd/pipeline.md\'s intro paragraph and its Entry points preamble, not only in its own section', () => {
  const pipeline = read('.sdd/pipeline.md');
  const intro = sectionBetween(pipeline, '# Pipeline — stage sequence, routing, and loop caps', '## Staleness stamps');
  assert.ok(intro.includes('/pipeline-lite'), 'a lane nobody can find from the top of the file is a lane that gets reinvented as a hand-edit');

  const entryPointsPreamble = sectionBetween(pipeline, '## Entry points', '### `/pipeline <ticket>`');
  assert.ok(entryPointsPreamble.includes('/pipeline-lite'), 'the Entry points list must name every entry point, including this one');
});

// @spec AC-2 AC-3
test('[lite] the lane adds no new subagent stage: `review` itself is the surviving gate, and the section names where its read-only property is structurally enforced', () => {
  const section = pipelineLiteSection();
  assert.ok(coOccurs(section, /\breview\b/, /(?:no new (?:subagent|stage)|unchanged)/i, 300),
    'the section must say plainly that the surviving gate is the existing `review` stage, unchanged — not a new, lighter reviewer');
  assert.ok(section.includes('guard-checker-readonly.mjs'), 'the section must name the guard script that enforces review\'s read-only property');
  assert.ok(section.includes('READ_ONLY_AGENTS'), 'and the specific registry within it — "enforced somewhere" is the claim this project already had to correct once');

  // AC-3: the surviving gate's decision still comes from the JSON sidecar, never from prose.
  assert.ok(section.includes('review.json'), 'the section must name review.json as the source of the verdict');

  // Nothing is registered as a new stage.
  assert.ok(!read('.sdd/runtimes.yml').includes('pipeline-lite'),
    '.sdd/runtimes.yml must be untouched by this ticket — the lane is an entry point, not a stage');
  const agentShims = readdirSync(resolve(repoRoot, '.claude', 'agents'));
  assert.ok(!agentShims.some((name) => name.includes('lite')), 'no .claude/agents/*.md shim may be added for a stage that does not exist');
});

// @spec AC-17
test('[lite] the section carries an Honest limits paragraph naming exactly what the lane gives up', () => {
  const honestLimits = sectionBetween(pipelineLiteSection(), 'Honest limits', '');

  assert.ok(coOccurs(honestLimits, /\bred\b/, /(?:after|order|first)/i, 300),
    'it must name red\'s spec-first ordering — that any test for a lite ticket is written after the diff exists');
  assert.match(honestLimits, /(?:D-018|inver)/i,
    'the D-018 inversion is reintroduced deliberately and only here; saying so is the whole point of this paragraph');
  assert.match(honestLimits, /attacker[- ]brief/i, 'it must name the attacker-brief sweep that does not happen');
  assert.match(honestLimits, /CORE-01/, 'it must name the CORE-01..06 mandatory checks that do not run');
  assert.ok(honestLimits.includes('.pipeline/security-history/'), 'it must name the immutable audit record that is never written for this run');
  assert.match(honestLimits, /(?:curated|best[- ]effort)/i, 'it must concede the barred-path list is curated and best-effort, not a complete classifier');
  assert.ok(coOccurs(honestLimits, /(?:fail[- ]closed|ambigu)/i, /\/pipeline\b/, 300),
    'it must state the fail-closed default: ambiguous eligibility routes to /pipeline');
});

// @spec EC-1
test('[lite] the section routes the three adjacent cases explicitly: ambiguity to /pipeline, an incident to /hotfix, a barred path to /pipeline', () => {
  const section = pipelineLiteSection();
  assert.ok(coOccurs(section, /(?:exits? ?`?2`?|could not (?:be )?(?:run|performed))/i, /\/pipeline\b/, 300),
    'an eligibility check that could not run (exit 2) routes to /pipeline — ambiguity is ineligibility, never a provisional entry');
  assert.ok(coOccurs(section, /(?:incident|production|outage)/i, /\/hotfix/, 300),
    'a small change during a production incident is /hotfix, and the routing table must say so');
  assert.ok(coOccurs(section, /barred/i, /\/pipeline\b/, 300), 'a small change on a barred path is /pipeline');
});

// @spec AC-4
test('[lite] .sdd/bounds.yml carries the lite_eligibility block and .sdd/bounds.md explains it, including the lane-vs-lane disambiguation and the no-third-list rule', () => {
  const boundsYml = read('.sdd/bounds.yml');
  assert.match(boundsYml, /^lite_eligibility:\s*$/m);
  assert.match(boundsYml, /^[ \t]+max_files:[ \t]*5[ \t]*\r?$/m);
  assert.match(boundsYml, /^[ \t]+max_changed_lines:[ \t]*150[ \t]*\r?$/m);

  const boundsMd = read('.sdd/bounds.md');
  assert.match(boundsMd, /##.*Lite[- ]lane eligibility/i, 'bounds.md must carry a human-facing section for the new block');
  const section = sectionBetween(boundsMd, 'Lite-lane eligibility', '');

  assert.ok(coOccurs(section, /lanes/i, /(?:which paths|path fence|fence)/i, 300),
    'the section must say what `lanes:` bounds (which paths a ticket may touch)');
  assert.ok(coOccurs(section, /lite/i, /(?:which stages|skip)/i, 300),
    'and what the lite bounds bound (which stages run) — two different axes sharing one file is exactly what gets confused later');
  assert.ok(section.includes('hotfix_barred_paths') && section.includes('deny_for_fenced_lanes'),
    'the section must name both lists the lite barred set is computed from');
  assert.ok(coOccurs(section, /(?:union|computed)/i, /(?:no third|not a third|never a third)/i, 400),
    'and state that there is deliberately no third barred-path list to maintain');
});

// @spec AC-12
test('[lite] .sdd/ledger/README.md documents the lite entry shape, why it is indexed, and what it structurally lacks', () => {
  const readme = read('.sdd/ledger/README.md');
  assert.match(readme, /##.*Lite[- ]lane entries/i, 'the ledger README must carry a Lite-lane entries section');
  const section = sectionBetween(readme, 'Lite-lane entries', '\n## ');

  assert.ok(section.includes('SKIPPED_LITE'), 'the exact verdict literal is the contract — pinned, not paraphrased');
  assert.ok(section.includes('skippedStages'), 'as is the JSON field name');
  assert.ok(coOccurs(section, /index/i, /(?:spec|govern|ratif)/i, 400),
    'the section must give the REASON a lite entry is indexed (a real, ratified spec that review passed), not merely state that it is');
  assert.ok(coOccurs(section, /(?:hotfix|override)/i, /exclud/i, 400),
    'and contrast it against a hotfix/override entry\'s exclusion — the contrast is what makes the decision legible rather than arbitrary');

  for (const absent of ['security.json', 'red.json', 'security/']) {
    assert.ok(section.includes(absent), `the section must state that a lite entry has no ${absent}`);
  }
});

// @spec AC-13
test('[lite] .claude/skills/pipeline-lite/SKILL.md exists, is thin, and matches the other shims\' frontmatter conventions', () => {
  const skillPath = '.claude/skills/pipeline-lite/SKILL.md';
  assert.ok(existsSync(resolve(repoRoot, skillPath)), `${skillPath} does not exist`);
  const skill = read(skillPath);

  assert.match(skill, /^---\r?\n[\s\S]*?\r?\n---/, 'the shim must open with YAML frontmatter, like every other skill');
  assert.match(skill, /^name: pipeline-lite[ \t]*\r?$/m);
  assert.match(skill, /^description: \S.*\r?$/m);
  assert.match(skill, /^disable-model-invocation: true[ \t]*\r?$/m, 'this command takes real actions — it is invoked explicitly, never auto-triggered');
  assert.match(skill, /^argument-hint: \S.*\r?$/m);
  assert.ok(skill.includes('.sdd/pipeline.md'), 'the body must point at the authoritative, runtime-neutral definition');

  // Thin: a shim that restates the procedure is a second copy of it, and the two will drift.
  assert.ok(skill.split('\n').length < 60, 'the shim must stay a pointer, not a second copy of the lane\'s procedure');
});

// @spec AC-13
test('[lite] every `### `/<command>`` section in .sdd/pipeline.md has a matching .claude/skills/<command>/SKILL.md', () => {
  const pipeline = read('.sdd/pipeline.md');
  const commands = [...pipeline.matchAll(/^### `\/([a-z][a-z0-9-]*)/gm)].map((match) => match[1]);
  assert.ok(commands.length >= 10, `expected pipeline.md's entry-point sections to be discoverable; found ${commands.length}`);
  assert.ok(commands.includes('pipeline-lite'), 'the generalized check is only meaningful once it actually covers the new command');

  for (const command of new Set(commands)) {
    assert.ok(
      existsSync(resolve(repoRoot, '.claude', 'skills', command, 'SKILL.md')),
      `.sdd/pipeline.md documents /${command} but .claude/skills/${command}/SKILL.md does not exist — a documented entry point with no runtime shim is a command a person cannot actually run`,
    );
  }
});

// @spec AC-14
test('[lite] the new script is wired and gated: package.json scripts, a CI step, and scripts/tsconfig.json include', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['check:lite-eligible'] ?? '', /node scripts\/check-lite-eligible\.mjs/);
  assert.match(pkg.scripts['test:lite-eligible'] ?? '', /node --test scripts\/check-lite-eligible\.test\.mjs/);

  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('test:lite-eligible'), 'CI must actually run the new suite — a suite nothing runs is indistinguishable from no tests');

  const tsconfig = read('scripts/tsconfig.json');
  assert.ok(tsconfig.includes('"check-lite-eligible.mjs"'), 'the new script must be type-checked');
  assert.ok(tsconfig.includes('"check-lite-eligible.test.mjs"'), 'and so must its suite');
});

// @spec AC-15
test('[lite] every script this ticket touches has coverage: a new suite for the new script, and [lite]-tagged cases in each existing suite', () => {
  assert.ok(
    existsSync(resolve(repoRoot, 'scripts', 'check-lite-eligible.mjs')),
    'coverage "for scripts/check-lite-eligible.mjs" is not coverage of anything until that script exists — this is the half of AC-15 the red stage cannot satisfy on its own',
  );
  assert.ok(read('scripts/check-lite-eligible.test.mjs').includes('check-lite-eligible.mjs'),
    'the new suite must actually exercise the new script');

  for (const suite of ['scripts/ledger-append.test.mjs', 'scripts/build-ledger-index.test.mjs', 'scripts/check-bounds.test.mjs']) {
    const taggedTests = [...read(suite).matchAll(/^test\('\[lite\]/gm)];
    assert.ok(taggedTests.length > 0, `${suite} must carry [lite]-tagged cases for the behavior this ticket adds to the script it covers`);
  }
});

// @spec AC-16
test('[lite] .sdd/stages/tester.md treats a missing red.md as legitimate on the lite lane while keeping the D-018 guarantee in force', () => {
  const tester = read('.sdd/stages/tester.md');
  const requiredInputs = sectionBetween(tester, '## Required inputs', '## Procedure');

  assert.ok(requiredInputs.includes('red.md'), 'item 1 still names red.md as an input');
  assert.ok(coOccurs(requiredInputs, /lite/i, /(?:red\.md|absent|missing)/i, 400),
    'item 1 must name the lite lane as the case where red.md\'s absence is legitimate — "stop and say which stage needs to run first" is the wrong answer on a lane that deliberately skipped it');
  assert.ok(coOccurs(requiredInputs, /lite/i, /(?:state|say)/i, 400),
    'and require tester to STATE that, rather than either stopping or passing over it silently');

  // The D-018 guarantee is preserved in force, not merely mentioned: tester still authors nothing.
  const procedure = sectionBetween(tester, '## Procedure', '## Output contract');
  assert.ok(coOccurs(procedure, /(?:you do not write it|never)/i, /behavioral/i, 400),
    'tester still never authors a behavioral test — the lite lane makes that MORE consequential, not less, since no red stage covered anything');
  assert.ok(coOccurs(procedure, /report/i, /gap/i, 300), 'and still reports gaps rather than filling them');

  const outputContract = sectionBetween(tester, '## Output contract', '## Staleness of required inputs');
  const redSuiteBullet = sectionBetween(outputContract, 'Red suite result', '- **');
  assert.ok(coOccurs(redSuiteBullet, /(?:no red suite|no red\.md|no such suite)/i, /(?:explicit|state|say)/i, 400),
    'the Red suite result bullet must require an explicit statement when no red suite exists for the run — a blank section reads as "not checked"');
});

// @spec AC-16
test('[lite] .sdd/stages/CHANGELOG.md records the PL-11 round, and no other stage file\'s procedure is changed', () => {
  const changelog = read('.sdd/stages/CHANGELOG.md');
  assert.match(changelog, /^## PL-11/m, 'the changelog is where a stage-file amendment is explained, so the stage file itself stays a procedure');
  const section = sectionBetween(changelog, '## PL-11', '\n## ');
  assert.ok(section.includes('tester'), 'the PL-11 entry must name which stage file it amended');

  // Mechanical half of "no other stage file's procedure is changed". This only sees UNCOMMITTED
  // edits, which is exactly the state this suite runs in during a pipeline run; the durable half is
  // the per-stage marker assertions earlier in this file, which would fail if a guarantee were
  // silently dropped from planner.md/red.md/dev.md/review.md/security.md at any point.
  const changedStageFiles = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.sdd/stages'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const allowed = new Set(['.sdd/stages/tester.md', '.sdd/stages/CHANGELOG.md']);
  for (const file of changedStageFiles) {
    assert.ok(allowed.has(file), `${file} was modified, but this ticket amends only tester.md (plus the changelog)`);
  }
});

// @spec AC-18
test('[lite] the lane is discoverable from .sdd/hotfix.md, CLAUDE.md, and .sdd/README.md', () => {
  const hotfix = read('.sdd/hotfix.md');
  const whenRight = sectionBetween(hotfix, '## When this is the right call', '## Who may use it');
  assert.ok(whenRight.includes('/pipeline-lite'),
    'hotfix.md\'s "not for a fix that is too small to need a spec" list must now point somewhere — a prohibition with no alternative is what produced the unrecorded hand-edit this whole lane exists to replace');
  assert.ok(coOccurs(whenRight, /too small/i, /\/pipeline-lite/, 400),
    'and it must be pointed at from that specific item, not merely mentioned elsewhere in the section');

  // '' (read to EOF), not '\n## ': CLAUDE.md's "## Agent pipeline" is its own last section in this
  // checkout, so a next-heading endAnchor (the convention used for the other three sectionBetween
  // calls in this test) has nothing to find — sectionBetween already supports this exact case
  // (falls back to text.slice(from) when endAnchor is falsy); this is that documented path, not a
  // new one.
  const relatedCommands = sectionBetween(read('CLAUDE.md'), 'Related commands:', '');
  assert.ok(relatedCommands.includes('/pipeline-lite'), 'CLAUDE.md\'s Agent pipeline related-commands list must name the lane');

  const sddReadme = read('.sdd/README.md');
  const directoryMap = sectionBetween(sddReadme, '## Directory map', '## The generated surfaces');
  assert.ok(directoryMap.includes('/pipeline-lite'), '.sdd/README.md\'s directory map names the entry points pipeline.md defines');
  // The more specific, backtick-quoted anchor (not the bare '.claude/skills/' substring): that bare
  // substring's FIRST occurrence in this file is in the much earlier "Why this exists" section (the
  // pre-.sdd/ Claude Code copy this document contrasts itself with), not the "entry-point commands"
  // paragraph this assertion actually means to scope to — sectionBetween always finds the first
  // occurrence, so the ambiguous anchor silently scoped this check to the wrong section entirely.
  const skillsParagraph = sectionBetween(sddReadme, '`.claude/skills/*/SKILL.md`', '\n## ');
  assert.ok(skillsParagraph.includes('pipeline-lite'), '.sdd/README.md\'s .claude/skills/*/SKILL.md paragraph must name the new shim');
});

// =================================================================================================
// [inline] PL-12 — the /inline-edit lane's documented half
// =================================================================================================
//
// Authored by the `red` stage from .pipeline/spec.md alone, before the lane exists. Same discipline
// as the [lite] block above (scope to a real heading or bold label, then require the load-bearing
// concepts to co-occur inside it), and the same two hard-won conventions it records: every
// alternation handed to `coOccurs` is wrapped in a non-capturing group (a bare `/a|b/` becomes a
// top-level alternation of the WHOLE composed pattern and the assertion silently stops testing
// co-occurrence at all), and no `$` anchors — every file read here is CRLF in this working tree.
//
// Why the documentation is the deliverable and not decoration: /inline-edit is the one lane that
// invites a human to edit code directly, mid-session, with no `dev`-stage isolation and no `red`
// suite in front of the diff. What separates that from the unrecorded hand-edit it exists to
// replace is entirely whether its own definition says, in the place a person actually reads,
// what it forces (a ratified spec before any edit), what it gave up (`red`, `dev`), and what is
// still owed at every stop. An undocumented inline lane and a hand-edit are the same artifact.

/** The authoritative section for the lane, sliced by its own heading. A NEW helper alongside
 * `pipelineLiteSection()` — deliberately never a widening of it (EC-20b): `pipelineLiteSection()`
 * slices '### `/pipeline-lite' ... '### Per-stage entry points', so a new section placed inside that
 * range would silently widen every existing `[lite]` assertion's search window. The `/re-gate` ->
 * `/hotfix` placement this file asserts below is what keeps the two windows disjoint. */
function inlineEditSection() {
  return sectionBetween(read('.sdd/pipeline.md'), '### `/inline-edit', '### `/hotfix');
}

// @spec AC-1
test('[inline] .sdd/pipeline.md defines /inline-edit runtime-neutrally end to end, placed between /re-gate and /hotfix, naming red and dev as deliberately skipped', () => {
  const pipeline = read('.sdd/pipeline.md');
  assert.match(pipeline, /### `\/inline-edit/, 'expected a dedicated /inline-edit entry-point section');

  // Placement is load-bearing, not cosmetic — semantically it is the middle member of the
  // outside-the-ordinary-sequence family (/re-gate re-verifies after a hand-edit, /inline-edit gates
  // one being made deliberately, /hotfix runs no gate at all), and mechanically it is what keeps the
  // new section out of pipelineLiteSection()'s slice (see the EC-20 test below).
  const regateIdx = pipeline.indexOf('### `/re-gate');
  const inlineIdx = pipeline.indexOf('### `/inline-edit');
  const hotfixIdx = pipeline.indexOf('### `/hotfix');
  assert.ok(regateIdx !== -1, 'expected the existing /re-gate section to still be present');
  assert.ok(hotfixIdx !== -1, 'expected the existing /hotfix section to still be present');
  assert.ok(regateIdx < inlineIdx && inlineIdx < hotfixIdx,
    'the /inline-edit section must sit between /re-gate and /hotfix — anywhere earlier puts it inside pipelineLiteSection()\'s window');

  const section = inlineEditSection();

  // The spec-first gate is what this lane IS: nothing may be edited until spec.md AND spec.json
  // exist for the ticket being worked.
  assert.ok(section.includes('planner'), 'the section must name planner as the first stage the lane runs');
  assert.ok(section.includes('spec.json'), 'the spec-first gate is checked against spec.json, not only spec.md');
  assert.ok(coOccurs(section, /spec\.md/, /(?:nothing may be edited|before any edit|until)/i, 400),
    'the section must state that no edit happens until a real spec exists — a lane that gates after the edit has not gated anything');

  // The stages that DO run, in order, ending at the mandatory ledger step.
  let cursor = -1;
  for (const marker of ['planner', 'changes.json', 'tester', 'review', 'security', 'ledger-append.mjs --inline']) {
    const idx = section.indexOf(marker, cursor + 1);
    assert.ok(idx > cursor, `the section must name ${marker} in sequence after the step before it`);
    cursor = idx;
  }
  assert.ok(section.includes('changes.md'), 'the editor authors changes.md as well as changes.json — there is no dev stage to write either');
  assert.ok(section.includes('write-stamp.mjs'), 'the section must name the stamp step for the editor-authored changes.json');
  assert.ok(section.includes('--why-inline'), 'the mandatory ledger step names the exact command that records the run');
  assert.ok(section.includes('--ticket'), 'including --ticket, the mechanically-checkable half of "spec-first, forced"');

  // The two stages that deliberately do NOT run, named as skipped rather than merely absent.
  assert.ok(coOccurs(section, /\bred\b/, /skip/i, 300), 'the section must say `red` is skipped, not simply omit it');
  assert.ok(coOccurs(section, /\bdev\b/, /skip/i, 300), 'the section must say `dev` is skipped, not simply omit it');
  assert.ok(coOccurs(section, /\bdev\b/, /(?:no `?dev`? subagent|directly|inline|in this session)/i, 400),
    'and must say the implementation is made directly in-session rather than by a dev subagent');
});

// @spec AC-2
test('[inline] the section states the obligations checklist at five named stops, each naming what is produced, what is owed, the exact ledger command, and what is recorded where', () => {
  const section = inlineEditSection();
  assert.match(section, /obligation/i, 'the checklist is the lane\'s central affordance: a person learns what they will owe before they incur it');

  // The five stop markers spec.md's own Interfaces block names (STOP A..STOP E), in order.
  let cursor = -1;
  for (const stop of ['STOP A', 'STOP B', 'STOP C', 'STOP D', 'STOP E']) {
    const idx = section.indexOf(stop, cursor + 1);
    assert.ok(idx > cursor, `the section must carry ${stop} in order — five named stops, not a single closing summary`);
    cursor = idx;
  }

  // Stop A states the whole list BEFORE the edit exists — that ordering is the point.
  const stopA = sectionBetween(section, 'STOP A', 'STOP B');
  assert.ok(coOccurs(stopA, /(?:owe|owed|still owed|remain)/i, /(?:gate|review|security|tester)/i, 600),
    'the first stop must state which gates are still owed, before any edit has been made');

  // Each stop names the ledger command that will apply, including its non-PASS composition.
  assert.ok(section.includes('--override-review') || section.includes('--override-security'),
    'the checklist must name the override composition for a non-PASS outcome, not only the clean-PASS command');

  // ...and what gets recorded where.
  assert.ok(section.includes('.sdd/ledger/'), 'the checklist must name where the durable record lands');
  assert.ok(section.includes('(INLINE)'), 'including the title marker a reader will actually see on the entry');
  assert.ok(section.includes('entry.json'), 'and the machine-facing half that carries the disclosure');
  assert.ok(section.includes('index.json'), 'and the index decoration every record for this run\'s files carries');
  assert.ok(section.includes('skippedStages'), 'the exact field name is the contract — pinned, not paraphrased');
});

// @spec AC-3 EC-18
test('[inline] the section states the abnormal-stop obligation: an abandoned lane leaves an unrecorded hand-edit, discharged only by finishing or reverting', () => {
  const section = inlineEditSection();

  assert.ok(coOccurs(section, /(?:abandon|walk(?:ed|ing)? away|stop(?:ping)? here|abnormal)/i, /(?:revert|reverting)/i, 700),
    'the section must name reverting the edit as one of the two discharges of the obligation entering this lane creates');
  assert.ok(coOccurs(section, /(?:unrecorded|no ledger entry|nothing is recorded)/i, /(?:hand[- ]edit|on disk)/i, 500),
    'and must say plainly what an abandoned lane leaves behind — the exact failure this lane exists to replace');
  assert.match(section, /D-005/, 'the failure has a name in this project\'s own decision log; citing it is what makes the warning legible rather than generic');
  assert.ok(coOccurs(section, /(?:--override-review|--override-security)/, /(?:discharge|finish|record)/i, 600),
    'the other discharge is finishing the lane — plain, or composed with --override-* for a non-PASS outcome');
  assert.ok(coOccurs(section, /(?:gates said no|refus|did not pass)/i, /(?:not a discharge|unless|still)/i, 500),
    '"the gates said no, so I stopped" must be named explicitly as NOT a discharge unless the edit is also reverted or the outcome recorded');
});

// @spec AC-4
test('[inline] the section carries an Honest limits paragraph naming exactly what the lane gives up', () => {
  const honestLimits = sectionBetween(inlineEditSection(), 'Honest limits', '');

  // (a) no red — the D-018 inversion, at any size, with no mechanical size bound.
  assert.ok(coOccurs(honestLimits, /\bred\b/, /(?:after|order|first)/i, 300),
    'it must name red\'s spec-first ordering — any test covering this change was written after the diff already existed');
  assert.match(honestLimits, /(?:D-018|inver)/i, 'the D-018 inversion is reintroduced deliberately here; saying so is the whole point of this paragraph');
  assert.ok(coOccurs(honestLimits, /(?:any size|no mechanical|size bound)/i, /(?:lite|not imported|deliberately)/i, 500),
    'it must state there is no mechanical size bound on this lane, and why lite\'s is deliberately not imported (D-2)');

  // (b) no dev-stage isolation; changes.md is self-reported.
  assert.ok(coOccurs(honestLimits, /\bdev\b/, /(?:isolation|self[- ]report|same context|one context)/i, 400),
    'it must name the loss of dev-stage isolation — the implementer and the session are one context');
  assert.ok(honestLimits.includes('changes.md'), 'and that changes.md/changes.json are the editor\'s own self-report');

  // (c) the "do not run /red here" rule is unenforced, and why it cannot be detected at ledger time.
  assert.ok(coOccurs(honestLimits, /(?:unenforced|cannot be (?:detected|enforced)|indistinguishable)/i, /red\.json/, 600),
    'it must concede the "do not run /red on this lane" rule is unenforced, and say why a same-round red.json is indistinguishable from a leftover');

  // (d) --ticket and the stamp check verify which ticket and what shape, never that planner ran.
  assert.ok(honestLimits.includes('--ticket'), 'it must name --ticket as verifying WHICH ticket, not that planner ran');
  assert.ok(coOccurs(honestLimits, /stamp/i, /(?:presence|shape)/i, 400),
    'and the stamp check as presence-and-shape only');
  assert.ok(coOccurs(honestLimits, /planner/i, /(?:never|not proof|does not prove|neither)/i, 500),
    'neither proves planner actually ran this round — the same honest limit /re-gate already states');

  // (e) --why-inline is disclosure, not authorization.
  assert.ok(coOccurs(honestLimits, /--why-inline/, /(?:disclosure|not authorization|nothing verifies)/i, 400),
    'it must state that --why-inline is a disclosure requirement, and that nothing verifies who supplied it');
});

// @spec AC-5
test('[inline] the section carries a "not this lane" routing table, including the recorded lite-vs-inline rule in prose', () => {
  const section = inlineEditSection();

  assert.ok(coOccurs(section, /(?:incident|production|outage|broken)/i, /\/hotfix/, 400),
    'a production incident routes to /hotfix, and the routing table must say so');
  assert.ok(coOccurs(section, /review\.json/, /\/re-gate/, 500),
    'a ticket that already has a review.json from a prior run, hand-edited since, routes to /re-gate');
  assert.ok(coOccurs(section, /(?:agent|implement)/i, /\/pipeline\b/, 400),
    'wanting an agent to implement it from the spec routes to /pipeline (or /pipeline-lite if small)');
  assert.ok(coOccurs(section, /spec-first test/i, /\/pipeline\b/, 500),
    'a change where a spec-first test would genuinely have earned its keep routes to /pipeline — the one prohibition worth enforcing socially');

  // D-3, in prose: the choice is stated by a human, not computed, and neither lane is a fallback.
  assert.ok(coOccurs(section, /\/pipeline-lite/, /(?:yourself|by hand|human|live session)/i, 600),
    'the lite-vs-inline rule must be stated: if you are not actually making the edit yourself, use /pipeline-lite (when eligible) or /pipeline');
});

// @spec AC-6
test('[inline] /inline-edit is named in .sdd/pipeline.md\'s opening paragraph and its Entry points preamble, not only inside its own section', () => {
  const pipeline = read('.sdd/pipeline.md');

  const intro = sectionBetween(pipeline, '# Pipeline — stage sequence, routing, and loop caps', '## Staleness stamps');
  assert.ok(intro.includes('/inline-edit'), 'a lane nobody can find from the top of the file is a lane that gets reinvented as an unrecorded hand-edit');

  const entryPointsPreamble = sectionBetween(pipeline, '## Entry points', '### `/pipeline <ticket>`');
  assert.ok(entryPointsPreamble.includes('/inline-edit'), 'the Entry points preamble must name every entry point, including this one');
});

// @spec AC-7
test('[inline] .claude/skills/inline-edit/SKILL.md exists, is thin, and matches the other shims\' frontmatter conventions', () => {
  const skillPath = '.claude/skills/inline-edit/SKILL.md';
  assert.ok(existsSync(resolve(repoRoot, skillPath)), `${skillPath} does not exist`);
  const skill = read(skillPath);

  assert.match(skill, /^---\r?\n[\s\S]*?\r?\n---/, 'the shim must open with YAML frontmatter, like every other skill');
  assert.match(skill, /^name: inline-edit[ \t]*\r?$/m);
  assert.match(skill, /^description: \S.*\r?$/m);
  assert.match(skill, /^disable-model-invocation: true[ \t]*\r?$/m, 'this command takes real actions — it is invoked explicitly, never auto-triggered');
  assert.match(skill, /^argument-hint: \S.*\r?$/m);
  assert.ok(skill.includes('.sdd/pipeline.md'), 'the body must point at the authoritative, runtime-neutral definition');

  // The refusals most easily lost, restated here and nowhere else duplicated.
  assert.ok(coOccurs(skill, /(?:never|do not|don't)/i, /(?:edit|change)[\s\S]{0,80}(?:before|until)/i, 300),
    'the shim must restate the one refusal the whole lane rests on: never edit before the spec exists');
  assert.ok(coOccurs(skill, /--ticket/, /spec\.json/, 400),
    'and the circularity warning /re-gate already carries: --ticket is the caller\'s own assertion, never derived from spec.json');

  assert.ok(skill.split('\n').length < 60, 'the shim must stay a pointer, not a second copy of the lane\'s procedure');
});

// @spec AC-8
test('[inline] .sdd/ledger/README.md documents the inline-edit entry shape, why it is indexed, and what it structurally lacks', () => {
  const readme = read('.sdd/ledger/README.md');
  assert.match(readme, /##.*Inline[- ]edit entries/i, 'the ledger README must carry an Inline-edit entries section');
  const section = sectionBetween(readme, 'Inline-edit entries', '\n## ');

  for (const field of ['skippedStages', 'reason', 'note', 'size']) {
    assert.ok(section.includes(field), `the exact entry.json field name "${field}" is the contract — pinned, not paraphrased`);
  }
  assert.ok(section.includes('(INLINE)'), 'the section must document the title marker');
  assert.ok(section.includes('## Inline edit'), 'and the entry.md section name it introduces');
  assert.ok(coOccurs(section, /index\.json/, /skippedStages/, 400),
    'and the condensed index.json decoration every record for the run\'s files carries');

  assert.ok(coOccurs(section, /index/i, /(?:spec|govern|ratif)/i, 500),
    'the section must give the REASON an inline entry is indexed (a real, ratified spec that review AND security passed against the final tree), not merely state that it is');
  assert.ok(coOccurs(section, /(?:hotfix|override)/i, /exclud/i, 500),
    'and contrast it against a hotfix/override entry\'s exclusion — the contrast is what makes the decision legible rather than arbitrary');

  assert.ok(section.includes('red.json'), 'the section must state that an inline entry carries no red.json');
  assert.ok(coOccurs(section, /red\.json/, /(?:leftover|never copied|no)/i, 400),
    'and why a leftover is never copied into it — copying one would manufacture evidence of a stage that never ran');
});

// @spec AC-9 EC-20
test('[inline] .sdd/stages/tester.md names the /inline-edit lane alongside /pipeline-lite, and CHANGELOG.md records PL-12 as amending only tester.md', () => {
  const tester = read('.sdd/stages/tester.md');
  const requiredInputs = sectionBetween(tester, '## Required inputs', '## Procedure');
  assert.ok(coOccurs(requiredInputs, /inline[- ]edit/i, /(?:red\.md|absent|missing)/i, 400),
    'Required inputs item 1 must name the inline-edit lane as a second legitimate red.md-absent case — "stop and say which stage needs to run first" is the wrong answer on a lane that never invokes red');

  const outputContract = sectionBetween(tester, '## Output contract', '## Staleness of required inputs');
  const redSuiteBullet = sectionBetween(outputContract, 'Red suite result', '- **');
  assert.ok(coOccurs(redSuiteBullet, /inline[- ]edit/i, /(?:no red suite|no red\.md|no such suite|explicit)/i, 400),
    'the Red suite result bullet must name this lane too — the two halves are pinned independently so a partial edit cannot soften one while leaving the other');

  // The D-018 guarantee is preserved in force, unchanged by this widening.
  const procedure = sectionBetween(tester, '## Procedure', '## Output contract');
  assert.ok(coOccurs(procedure, /(?:you do not write it|never)/i, /behavioral/i, 400),
    'tester still never authors a behavioral test — a lane with no red stage makes that MORE consequential, not less');

  const changelog = read('.sdd/stages/CHANGELOG.md');
  assert.match(changelog, /^## PL-12/m, 'the changelog is where a stage-file amendment is explained, so the stage file itself stays a procedure');
  const pl12Idx = changelog.indexOf('## PL-12');
  const pl11Idx = changelog.indexOf('## PL-11');
  assert.ok(pl11Idx !== -1, 'the existing PL-11 entry must remain');
  assert.ok(pl12Idx < pl11Idx, 'the PL-12 entry belongs above PL-11 — newest first, as this file already reads');
  const pl12 = sectionBetween(changelog, '## PL-12', '\n## ');
  assert.ok(pl12.includes('tester'), 'the PL-12 entry must name which stage file it amended');

  // EC-20a, mechanical half: this ticket may not exceed the same two-file allowlist PL-11 used.
  const changedStageFiles = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.sdd/stages'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const allowed = new Set(['.sdd/stages/tester.md', '.sdd/stages/CHANGELOG.md']);
  for (const file of changedStageFiles) {
    assert.ok(allowed.has(file), `${file} was modified, but this ticket amends only tester.md (plus the changelog)`);
  }
});

// @spec AC-10
test('[inline] the lane is discoverable from CLAUDE.md and both .sdd/README.md sites', () => {
  // '' (read to EOF), not '\n## ': CLAUDE.md's "## Agent pipeline" is its own last section in this
  // checkout — the same documented sectionBetween path the [lite] test above already relies on.
  const relatedCommands = sectionBetween(read('CLAUDE.md'), 'Related commands:', '');
  assert.ok(relatedCommands.includes('/inline-edit'), 'CLAUDE.md\'s Agent pipeline related-commands list must name the lane');

  const sddReadme = read('.sdd/README.md');
  const directoryMap = sectionBetween(sddReadme, '## Directory map', '## The generated surfaces');
  assert.ok(directoryMap.includes('/inline-edit'), '.sdd/README.md\'s directory map names the entry points pipeline.md defines');

  const skillsParagraph = sectionBetween(sddReadme, '`.claude/skills/*/SKILL.md`', '\n## ');
  assert.ok(skillsParagraph.includes('inline-edit'), '.sdd/README.md\'s .claude/skills/*/SKILL.md paragraph must name the new shim');
});

// @spec EC-19
test('[inline] the section reuses the existing routing and 3-attempt loop cap, routing a NEEDS_FIXES/BLOCKED back to another inline edit rather than to /dev', () => {
  const section = inlineEditSection();

  assert.ok(coOccurs(section, /(?:NEEDS_FIXES|BLOCKED)/, /(?:inline|another)/i, 500),
    'a non-PASS gate routes back to another INLINE edit — not to /dev, which does not run on this lane');
  assert.match(section, /(?:\b3\b|three)/, 'the section must state that the existing 3-attempt cap applies');
  assert.ok(coOccurs(section, /(?:loop cap|attempt|cap)/i, /(?:existing|reuse|same|no second)/i, 400),
    'and that it is REUSED — this lane defines no second cap and no second loop');
  assert.ok(coOccurs(section, /\bred\b/, /(?:after the fix|still never|must not)/i, 500),
    'red still never runs, and specifically must not be authored after the fix — that would be the D-018 inversion wearing a spec-first label');
});

// @spec EC-20
test('[inline] the new section sits OUTSIDE pipelineLiteSection()\'s window, and every existing [lite] anchor still resolves', () => {
  // (b) The one placement mistake that would silently weaken the whole [lite] block rather than fail
  // it loudly: a section inside '### `/pipeline-lite' .. '### Per-stage entry points' widens every
  // [lite] assertion's search window at once.
  assert.ok(!pipelineLiteSection().includes('/inline-edit'),
    'the /inline-edit section must not fall inside pipelineLiteSection()\'s slice — that would widen every existing [lite] assertion\'s window instead of failing');
  assert.ok(inlineEditSection().trim().length > 0,
    'the new section must be reachable through its OWN helper, anchored on its own heading — never by widening pipelineLiteSection()');

  // (c) The 400-character [lite] windows in tester.md must survive the inline-lane wording added
  // beside them: this is the assertion that fails if `lite` and `red.md`/`state` get pushed apart.
  const requiredInputs = sectionBetween(read('.sdd/stages/tester.md'), '## Required inputs', '## Procedure');
  assert.ok(coOccurs(requiredInputs, /lite/i, /(?:red\.md|absent|missing)/i, 400),
    'the existing [lite] Required-inputs assertion must keep passing — the inline wording must not push its two halves more than 400 characters apart');
  assert.ok(coOccurs(requiredInputs, /lite/i, /(?:state|say)/i, 400),
    'and so must its "tester must STATE that" half');

  // (d) The generalized `### `/<command>`` <-> shim test automatically demands the new shim, and its
  // own floor still holds.
  const commands = [...read('.sdd/pipeline.md').matchAll(/^### `\/([a-z][a-z0-9-]*)/gm)].map((match) => match[1]);
  assert.ok(commands.length >= 10, `the generalized command/shim test's floor must still hold; found ${commands.length}`);
  assert.ok(commands.includes('inline-edit'), 'and it must now cover /inline-edit, which is what makes the shim mandatory rather than optional');
});

// @spec AC-21
test('[inline] coverage and wiring: [inline]-tagged cases in the three existing suites, no new script file, and every deliberately-untouched file left alone', () => {
  for (const suite of ['scripts/ledger-append.test.mjs', 'scripts/build-ledger-index.test.mjs', 'scripts/sdd-completeness.test.mjs']) {
    const taggedTests = [...read(suite).matchAll(/^test\('\[inline\]/gm)];
    assert.ok(taggedTests.length > 0, `${suite} must carry [inline]-tagged cases for the behavior this ticket adds to what it covers`);
  }
  // The half of this AC the red stage cannot satisfy on its own (same shape as PL-11's AC-15 pin):
  // [inline]-tagged cases "covering the touched scripts" are not coverage of anything until the
  // behavior they name actually exists in those two scripts.
  assert.ok(read('scripts/ledger-append.mjs').includes('--inline'),
    'the [inline] cases in ledger-append.test.mjs cover a flag that does not exist yet — coverage of an absent feature is not coverage');
  assert.ok(read('scripts/build-ledger-index.mjs').includes('readInlineField'),
    'and build-ledger-index.mjs must actually read the inline field the [inline] cases assert it carries');

  // No new script file — which is precisely why package.json, ci.yml and scripts/tsconfig.json need
  // no edit. Asserting the absence of the wiring without also asserting the absence of the thing that
  // would require it would be a rule with no reason behind it.
  const untrackedScripts = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'scripts'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(untrackedScripts, [],
    'PL-12 adds flags to two existing scripts; a new scripts/ file would need package.json/ci.yml/tsconfig wiring this ticket states it does not need');

  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const path of [
    'package.json',
    '.github/workflows/ci.yml',
    'scripts/tsconfig.json',
    '.sdd/runtimes.yml',
    '.sdd/bounds.yml',
    '.sdd/bounds.md',
    '.sdd/hotfix.md',
    'scripts/check-lite-eligible.mjs',
    'scripts/check-bounds.mjs',
    'scripts/pipeline-contracts.mjs',
  ]) {
    assert.ok(!changed.includes(path), `${path} must be untouched by PL-12 — see spec.md's "Files deliberately not touched"`);
  }
  assert.ok(!changed.some((file) => file.startsWith('.claude/agents/')),
    '.claude/agents/** must be untouched — /inline-edit is an entry point that composes existing stages, not a new stage');

  // docs/PRD_Tickets.md is asserted BY CONTENT, not by the diff: this checkout already carries an
  // unrelated, pre-existing modification to that file (it is dirty against HEAD before PL-12 starts),
  // so a `changed.includes(...)` assertion here would fail for a reason that has nothing to do with
  // this ticket and could only be "fixed" by reverting someone else's in-flight work. What the ticket
  // actually forbids is registering PL-12 there, which is exactly what this checks.
  const prd = read('docs/PRD_Tickets.md');
  assert.ok(!prd.includes('inline-edit'), 'docs/PRD_Tickets.md must not be edited by this run — the ticket forbids it');
  assert.ok(!prd.includes('PL-12'), 'PL-12 is deliberately not registered in docs/PRD_Tickets.md by this run');
});

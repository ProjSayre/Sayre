// Tests scripts/pipeline-contracts.mjs — the shared JSON-sidecar contract that PL-03h round 4
// introduces to replace markdown-parsing control decisions across build-ledger-index.mjs,
// check-red-integrity.mjs, and ledger-append.mjs.
//
// What this suite is, and is not, a replacement for: build-ledger-index.test.mjs,
// check-red-integrity.test.mjs, and ledger-append.test.mjs previously carried extensive direct
// coverage of `extractSection`'s fence/comment/duplicate-heading handling — a fenced shadow, an
// HTML-comment shadow, a genuine duplicate heading, an ATX closing sequence, a setext heading, and
// so on. That coverage tested a markdown-ambiguity-resolution mechanism this round deletes outright;
// there is no `extractSection` left to shadow, duplicate, or fence around. The *intent* behind that
// coverage — a security-relevant read must fail closed on anything other than the one unambiguous
// shape it expects — is what this suite re-targets at the JSON contract that replaces it: malformed
// JSON, a missing required field, a value that is the wrong type, a verdict/classification literal
// outside its allowed set, and (documented explicitly, not silently glossed over) JSON's own
// "last key wins" duplicate-key semantics, which this contract inherits from `JSON.parse` itself and
// makes no attempt to special-case. See each script's own test file for where the equivalent
// per-caller assertions now live (e.g. "an appended, fabricated PASS block no longer overrides a
// real NEEDS_FIXES" is now "review.json's verdict field is read once, as one literal, with no
// 'blocks' to append at all").

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  SidecarError,
  isDeclaredInChanges,
  knownSpecIds,
  parseJsonOrThrow,
  readChangesJson,
  readJsonSidecar,
  readRedJson,
  readReviewJson,
  readSecurityJson,
  readSpecJson,
  requireArray,
  requireBoolean,
  requireEnum,
  requireObject,
  requireString,
} from './pipeline-contracts.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function pipelineDir(files) {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-pipeline-contracts-'));
  roots.push(root);
  const dir = join(root, '.pipeline');
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  }
  return dir;
}

// --- readJsonSidecar / parseJsonOrThrow: the shared "parse or throw" primitive ------------------

test('readJsonSidecar returns null when the file does not exist at all — never a thrown error', () => {
  const dir = pipelineDir({});
  assert.equal(readJsonSidecar(dir, 'spec.json', '.pipeline/spec.json'), null);
});

test('readJsonSidecar throws a SidecarError, naming the file, on truncated/invalid JSON — JSON.parse either succeeds or throws, there is no partial-read path', () => {
  const dir = pipelineDir({ 'spec.json': '{ "ticket": "PL-1", "goal": ' }); // truncated
  assert.throws(
    () => readJsonSidecar(dir, 'spec.json', '.pipeline/spec.json'),
    (error) => error instanceof SidecarError && /\.pipeline\/spec\.json is not valid JSON/.test(error.message),
  );
});

test('parseJsonOrThrow rejects a document that is syntactically valid JSON but not the expected shape only at the caller\'s validation step, not at parse time — parsing itself succeeds for any valid JSON value', () => {
  assert.deepEqual(parseJsonOrThrow('[1,2,3]', 'test'), [1, 2, 3]);
});

// --- Shared validation primitives — one implementation, every reader built from it ---------------

test('requireObject rejects an array, a primitive, and null, accepting only a plain object', () => {
  assert.throws(() => requireObject([], 'label'), SidecarError);
  assert.throws(() => requireObject('x', 'label'), SidecarError);
  assert.throws(() => requireObject(null, 'label'), SidecarError);
  assert.deepEqual(requireObject({ a: 1 }, 'label'), { a: 1 });
});

test('requireString rejects a non-string and an empty string', () => {
  assert.throws(() => requireString(42, 'label', 'field'), SidecarError);
  assert.throws(() => requireString('', 'label', 'field'), SidecarError);
  assert.equal(requireString('ok', 'label', 'field'), 'ok');
});

test('requireArray rejects a non-array, including an object with numeric-looking keys', () => {
  assert.throws(() => requireArray({ 0: 'a', 1: 'b' }, 'label', 'field'), SidecarError);
  assert.deepEqual(requireArray(['a'], 'label', 'field'), ['a']);
});

test('requireBoolean rejects a truthy/falsy non-boolean ("true" the string, 1, 0) — the exact "left blank or shape-guessed" case red.json\'s impactMapPresent field must never allow', () => {
  assert.throws(() => requireBoolean('true', 'label', 'field'), SidecarError);
  assert.throws(() => requireBoolean(1, 'label', 'field'), SidecarError);
  assert.throws(() => requireBoolean(undefined, 'label', 'field'), SidecarError);
  assert.equal(requireBoolean(false, 'label', 'field'), false);
});

test('requireEnum rejects a near-miss literal ("PASSED" is not "PASS") the same way ledger-append.mjs\'s old extractVerdict had to guard against explicitly with a trim/exact-match check', () => {
  assert.throws(() => requireEnum('PASSED', 'label', 'field', ['PASS', 'NEEDS_FIXES']), SidecarError);
  assert.equal(requireEnum('PASS', 'label', 'field', ['PASS', 'NEEDS_FIXES']), 'PASS');
});

// --- spec.json ------------------------------------------------------------------------------------

function validSpecJson(overrides = {}) {
  return {
    ticket: 'PL-99z — Sample ticket',
    goal: 'Do the sample thing.',
    acceptanceCriteria: [{ id: 'AC-1', text: 'First criterion.' }],
    edgeCases: [{ id: 'EC-1', text: 'First edge case.' }],
    ...overrides,
  };
}

test('readSpecJson parses a well-formed spec.json and knownSpecIds returns every declared AC-*/EC-* id', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson() });
  const spec = readSpecJson(dir);
  assert.equal(spec.ticket, 'PL-99z — Sample ticket');
  assert.deepEqual(knownSpecIds(spec), new Set(['AC-1', 'EC-1']));
});

test('readSpecJson fails closed when required and the file does not exist', () => {
  const dir = pipelineDir({});
  assert.throws(() => readSpecJson(dir), /spec\.json does not exist/);
});

test('readSpecJson returns null (not a throw) when explicitly optional and the file does not exist', () => {
  const dir = pipelineDir({});
  assert.equal(readSpecJson(dir, { required: false }), null);
});

test('readSpecJson fails closed when "goal" is missing', () => {
  const raw = validSpecJson();
  delete raw.goal;
  const dir = pipelineDir({ 'spec.json': raw });
  assert.throws(() => readSpecJson(dir), /field "goal" must be a non-empty string/);
});

test('readSpecJson fails closed when "acceptanceCriteria" is not an array (e.g. a single object, the shape an LLM sometimes collapses a one-item list to)', () => {
  const raw = validSpecJson({ acceptanceCriteria: { id: 'AC-1', text: 'First.' } });
  const dir = pipelineDir({ 'spec.json': raw });
  assert.throws(() => readSpecJson(dir), /field "acceptanceCriteria" must be an array/);
});

test('readSpecJson fails closed when an id does not match the AC-n/EC-n shape', () => {
  const raw = validSpecJson({ acceptanceCriteria: [{ id: 'AC1', text: 'Missing the dash.' }] });
  const dir = pipelineDir({ 'spec.json': raw });
  assert.throws(() => readSpecJson(dir), /does not match the required AC-n \/ EC-n shape/);
});

test('readSpecJson fails closed on a duplicate id shared between acceptanceCriteria and edgeCases — the JSON-contract equivalent of extractSection\'s old "fail closed on ambiguity" invariant, now a same-array uniqueness check instead of a heading-count check', () => {
  const raw = validSpecJson({ edgeCases: [{ id: 'AC-1', text: 'Reuses the AC-1 id by mistake.' }] });
  const dir = pipelineDir({ 'spec.json': raw });
  assert.throws(() => readSpecJson(dir), /id "AC-1" appears more than once/);
});

test('readSpecJson never launders an id-shaped token that only appears in prose — unlike the old extractKnownSpecIds, there is no section text to grep at all, only declared {id,text} items', () => {
  // Analogous to the old "AC-77 appears only inside a fenced code example" exploit: here there is no
  // markdown at all for a fenced example to hide in — "AC-77" only "exists" if it is a declared item.
  const raw = validSpecJson({ goal: 'Mentions AC-77 in prose, e.g. "see @spec AC-77 for the format."' });
  const dir = pipelineDir({ 'spec.json': raw });
  const spec = readSpecJson(dir);
  assert.ok(!knownSpecIds(spec).has('AC-77'), 'a token appearing only inside a string value must never resolve as a declared id');
});

// --- spec.json's "lane" field (PL-03e — the wiring pass, .sdd/stages/planner.md) -----------------
//
// Unlike every other field on spec.json, "lane" is optional and defaults to null: it did not exist
// before this ticket, so every spec.json already on disk (and every existing fixture in this test
// file's own suite) has no "lane" key at all and must keep parsing exactly as before.

test('readSpecJson returns lane: null when "lane" is absent — every spec.json written before this field existed must keep parsing', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson() });
  const spec = readSpecJson(dir);
  assert.equal(spec.lane, null);
});

test('readSpecJson returns lane: null when "lane" is explicitly null, not just when the key is absent', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson({ lane: null }) });
  const spec = readSpecJson(dir);
  assert.equal(spec.lane, null);
});

test('readSpecJson returns the declared lane when planner records one', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson({ lane: 'frontend' }) });
  const spec = readSpecJson(dir);
  assert.equal(spec.lane, 'frontend');
});

test('readSpecJson fails closed when "lane" is present but not a string (e.g. a number)', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson({ lane: 42 }) });
  assert.throws(() => readSpecJson(dir), /field "lane" must be a non-empty string/);
});

test('readSpecJson fails closed when "lane" is present but an empty string — an empty lane is not the same as a genuinely undeclared one', () => {
  const dir = pipelineDir({ 'spec.json': validSpecJson({ lane: '' }) });
  assert.throws(() => readSpecJson(dir), /field "lane" must be a non-empty string/);
});

// --- red.json -------------------------------------------------------------------------------------

function validRedJson(overrides = {}) {
  return {
    impactMapPresent: false,
    tests: [{ path: 'scripts/sample.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' }],
    ...overrides,
  };
}

test('readRedJson parses a well-formed red.json', () => {
  const dir = pipelineDir({ 'red.json': validRedJson() });
  const red = readRedJson(dir);
  assert.equal(red.impactMapPresent, false);
  assert.equal(red.tests[0].classification, 'RED-CORRECT');
});

test('readRedJson returns null when optional and absent (a ticket that predates the red stage)', () => {
  const dir = pipelineDir({});
  assert.equal(readRedJson(dir, { required: false }), null);
});

test('readRedJson fails closed on "RED-BROKEN" — the literal .sdd/stages/red.md says may never appear in a finished red.md is not in the allowed enum at all, so there is no separate "scan the whole document for this substring" check left to write', () => {
  const dir = pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'a'.repeat(64), specIds: [], classification: 'RED-BROKEN' }] }) });
  assert.throws(() => readRedJson(dir), /field "classification" must be exactly one of/);
});

test('readRedJson fails closed when impactMapPresent is missing — omitting the field is not the same as stating its absence, and the type system refuses to treat them alike', () => {
  const raw = validRedJson();
  delete raw.impactMapPresent;
  const dir = pipelineDir({ 'red.json': raw });
  assert.throws(() => readRedJson(dir), /field "impactMapPresent" must be a boolean/);
});

test('readRedJson fails closed on a malformed sha256 (wrong length, or containing a non-hex character)', () => {
  const dir = pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'not-a-real-hash', specIds: [], classification: 'RED-CORRECT' }] }) });
  assert.throws(() => readRedJson(dir), /must be a 64-character hex digest/);
});

test('readRedJson fails closed when "tests" lists the same path twice — the JSON-contract analog of extractSection\'s old "fail closed on a genuine duplicate heading" invariant: two entries for one path is the same ambiguity (which entry\'s hash/specIds governs?) one level down', () => {
  const raw = validRedJson({
    tests: [
      { path: 'scripts/dup.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' },
      { path: 'scripts/dup.test.mjs', sha256: 'b'.repeat(64), specIds: ['AC-2'], classification: 'RED-CORRECT' },
    ],
  });
  const dir = pipelineDir({ 'red.json': raw });
  assert.throws(() => readRedJson(dir), /lists "scripts\/dup\.test\.mjs" more than once/);
});

test('readRedJson lowercases a recorded sha256 so a case-differing but byte-identical hash is never treated as a mismatch', () => {
  const dir = pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'A'.repeat(64), specIds: [], classification: 'RED-CORRECT' }] }) });
  const red = readRedJson(dir);
  assert.equal(red.tests[0].sha256, 'a'.repeat(64));
});

// --- changes.json / isDeclaredInChanges -------------------------------------------------------------

test('isDeclaredInChanges is exact-equality against the structured "path" field — a denial sentence has nowhere to hide, because there is no prose field to search at all', () => {
  const dir = pipelineDir({
    'changes.json': { filesChanged: [], redTestChanges: [{ path: 'scripts/foo.test.mjs', reason: 'I did NOT change this — declared anyway per the schema' }] },
  });
  const changes = readChangesJson(dir);
  assert.equal(isDeclaredInChanges(changes, 'scripts/foo.test.mjs'), true, 'the schema only has room for a path and a reason string — the reason\'s content is review\'s judgment call, not this function\'s');
  assert.equal(isDeclaredInChanges(changes, 'scripts/other.test.mjs'), false);
});

test('isDeclaredInChanges returns false for every path when changesJson is null (no changes.json for this run)', () => {
  assert.equal(isDeclaredInChanges(null, 'scripts/foo.test.mjs'), false);
});

test('readChangesJson fails closed when a redTestChanges entry has no "reason"', () => {
  const dir = pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [{ path: 'x.ts' }] } });
  assert.throws(() => readChangesJson(dir), /field "reason" must be a non-empty string/);
});

test('readChangesJson tolerates an empty filesChanged array (a legitimately clean sub-task, not the same as changes.json being absent)', () => {
  const dir = pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [] } });
  const changes = readChangesJson(dir);
  assert.deepEqual(changes.filesChanged, []);
});

// --- review.json ----------------------------------------------------------------------------------

test('readReviewJson parses PASS and NEEDS_FIXES, and nothing else', () => {
  assert.equal(readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS' } })).verdict, 'PASS');
  assert.equal(readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES' } })).verdict, 'NEEDS_FIXES');
});

test('readReviewJson fails closed on a verdict that merely contains the word PASS as a substring or sentence, the exact adversarial shape ledger-append.test.mjs previously had to construct against markdown prose ("This run should probably PASS once minor things are fixed")', () => {
  const dir = pipelineDir({ 'review.json': { verdict: 'This run should probably PASS once minor things are fixed.' } });
  assert.throws(() => readReviewJson(dir), /field "verdict" must be exactly one of/);
});

test('readReviewJson fails closed when required and review.json does not exist', () => {
  assert.throws(() => readReviewJson(pipelineDir({})), /review\.json does not exist/);
});

test('honest limit, documented rather than special-cased: a literal duplicate top-level JSON key resolves via JSON.parse\'s own "last value wins" semantics, not a contract-level ambiguity check — this is a property of the JSON specification itself, not something readReviewJson adds or could remove', () => {
  const dir = pipelineDir({ 'review.json': '{"verdict":"NEEDS_FIXES","verdict":"PASS"}' });
  assert.equal(readReviewJson(dir).verdict, 'PASS');
});

// --- security.json ----------------------------------------------------------------------------------

test('readSecurityJson requires runId even when verdict is BLOCKED — a run id always exists once security-checker creates its immutable run directory, win or lose', () => {
  const dir = pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-123' } });
  const security = readSecurityJson(dir);
  assert.equal(security.verdict, 'BLOCKED');
  assert.equal(security.runId, 'run-123');
});

test('readSecurityJson fails closed when runId is missing', () => {
  const dir = pipelineDir({ 'security.json': { verdict: 'PASS' } });
  assert.throws(() => readSecurityJson(dir), /field "runId" must be a non-empty string/);
});

test('readSecurityJson fails closed on a verdict outside {PASS, BLOCKED}', () => {
  const dir = pipelineDir({ 'security.json': { verdict: 'PARTIAL', runId: 'run-123' } });
  assert.throws(() => readSecurityJson(dir), /field "verdict" must be exactly one of/);
});

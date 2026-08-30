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
// outside its allowed set, and a duplicate object key. See each script's own test file for where the
// equivalent per-caller assertions now live (e.g. "an appended, fabricated PASS block no longer
// overrides a real NEEDS_FIXES" is now "review.json's verdict field is read once, as one literal,
// with no 'blocks' to append at all").
//
// CORRECTED (round 5 / review Critical 1): this header, and the "honest limit" test that used to sit
// in the review.json section below, previously claimed duplicate-key resolution was an accepted,
// undisturbed property of `JSON.parse` this contract "inherits... and makes no attempt to
// special-case." That claim was false and, worse, was itself the thing that let a genuine exploit
// through review: `{"verdict":"NEEDS_FIXES","verdict":"PASS"}` parsed as `PASS` end to end against
// the real `ledger-append.mjs` (see .pipeline/review.md's round-4 report). `parseJsonOrThrow`
// (scripts/pipeline-contracts.mjs) now runs a strict, duplicate-key-rejecting parser instead of
// delegating to `JSON.parse` — see that file's header for the full "why a strict parser is
// achievable for JSON and was not for markdown" argument. The tests below assert the corrected
// behavior (throws, naming the duplicated key) rather than the resolution rule that used to be
// documented as an accepted limit.
//
// PL-04 / C2 (test-sediment consolidation): every "malformed sidecar -> fails closed" case across
// every reader (spec.json, red.json, changes.json, review.json, security.json, and their shared
// "stamp" field), plus the duplicate-object-key cases, used to each be its own top-level `test()` —
// same three-line shape (build an invalid sidecar, call the reader, assert it throws a specific,
// named error) repeated ~25 times. They are now one row each in SIDECAR_VALIDATION_CASES near the
// end of this file, run by one `test()`. Nothing was dropped: every row is exactly the assertion the
// standalone test made, under the same name (the row's `name` field carries the same documentation
// the test name used to). Every *positive*/behavioral test (parses correctly, returns null when
// optional, lowercases a hash, never launders a prose token into a declared id, ...) is unaffected
// and stays a standalone test, since collapsing those into a shared table would blur what each one
// individually proves.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  MAX_JSON_FILE_BYTES,
  STAMP_FRESH,
  STAMP_STALE,
  STAMP_UNKNOWN,
  SidecarError,
  buildStamp,
  computeTreeHash,
  isDeclaredInChanges,
  knownSpecIds,
  parseJsonOrThrow,
  readChangesJson,
  readGapsJson,
  readJsonFile,
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
  stampFreshness,
} from './pipeline-contracts.mjs';

// Namespace import for new AC-14 exports that do not yet exist in pipeline-contracts.mjs.
// Using a namespace import (rather than adding to the named import above) avoids a static
// SyntaxError that would prevent ALL tests in this file from running — accessing a missing named
// export via a namespace object returns `undefined` rather than a thrown error at module load time.
import * as _allContracts from './pipeline-contracts.mjs';

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

/** A throwaway git repo with one committed, tracked file — for `computeTreeHash`/`buildStamp`/
 * `stampFreshness` (A2), which need a real `git` working tree to observe (unlike every other test in
 * this file, which never shells out to git at all). Mirrors ledger-append.test.mjs's own
 * initGit()/commitAll() fixture conventions, duplicated locally rather than imported — a different
 * test file, and a small enough helper that duplicating it is cheaper than coupling the two files. */
function gitFixtureRepo() {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-pipeline-contracts-git-'));
  roots.push(root);
  writeFileSync(join(root, 'tracked.txt'), 'original content\n', 'utf8');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'pipeline-contracts-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Pipeline Contracts Test'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial commit'], { cwd: root });
  return root;
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

// --- SC-12 (round 6): a file over the size ceiling is refused before it is read or parsed ---------

test('readJsonSidecar (via readJsonFile) refuses a file over MAX_JSON_FILE_BYTES, naming the size, without reading its contents into memory first', () => {
  const dir = pipelineDir({});
  const path = join(dir, 'oversized.json');
  writeFileSync(path, `{"value":"${'a'.repeat(MAX_JSON_FILE_BYTES)}"}`, 'utf8'); // over the ceiling by construction
  assert.throws(
    () => readJsonSidecar(dir, 'oversized.json', '.pipeline/oversized.json'),
    (error) => error instanceof SidecarError && /byte ceiling/.test(error.message) && /\.pipeline\/oversized\.json/.test(error.message),
  );
});

test('readJsonFile is the same size-capped, strict-parsing primitive readJsonSidecar delegates to, reusable by callers that already have a full path (SEC-10: ledger-append.mjs\'s findCompletedSecurityRun and build-ledger-index.mjs\'s readEntryJson)', () => {
  const dir = pipelineDir({ 'x.json': { a: 1 } });
  assert.deepEqual(readJsonFile(join(dir, 'x.json'), 'test'), { a: 1 });
});

// --- Duplicate object keys: the JSON-native ambiguity this round introduced and closes ------------
//
// Plain `JSON.parse` (and the JSON grammar itself — ECMA-404 / RFC 8259) permits an object to repeat
// a key and leaves resolution parser-defined; V8 resolves to the LAST occurrence. That is the exact
// "last one wins" resolution rule review round 3's duplicate-`## Verdict`-heading exploit used, one
// layer down the stack — and review round 4 reproduced it end to end against the real
// ledger-append.mjs (see .pipeline/review.md). `parseJsonOrThrow` (below, and every reader built on
// it — see SIDECAR_VALIDATION_CASES' "PARSE-DUP"/"*-DUP" rows near the end of this file) pins the fix
// directly at the shared primitive every sidecar reader is built from, so every ACTUAL CALLER of it
// inherits the fix.
//
// CORRECTED (round 6 / security SEC-10): this comment used to say "so every caller inherits it
// automatically," full stop. That is false as a claim about the codebase as a whole — it is only
// true of code that actually calls `parseJsonOrThrow` (directly, or via `readJsonSidecar`/
// `readJsonFile`). `scripts/ledger-append.mjs`'s `findCompletedSecurityRun` read
// `security-history/<run-id>/manifest.json` and `results.json` with plain `JSON.parse` and was never
// such a caller, so the exact duplicate-key forgery these tests pin at the primitive still worked
// end to end one layer under `security.json` (which is such a caller) — see SEC-10 in
// `.pipeline/security-history/` for the live reproduction, and `ledger-append.test.mjs`'s
// DUPLICATE_KEY_CASES table for the manifest.json/results.json tests added once that call site was
// fixed.
// "Automatic" was the word doing the damage here: it read as a property of the codebase, not of the
// primitive, and made the gap invisible to review until an adversarial pass went looking for it
// directly. The corrected claim is scoped to what is actually decidable at this file's boundary: this
// primitive is duplicate-key-safe, and every caller of it is too — whether a given script IS a caller
// is a fact about that script, checked per site, not something this file can guarantee on its behalf.

test('parseJsonOrThrow does NOT reject the same key name reused across two different, unrelated objects — duplicate-key rejection is scoped to one object literal, matching what "a duplicate heading" meant under the old markdown contract (one section, two competing values)', () => {
  assert.deepEqual(
    parseJsonOrThrow('{"a":{"path":"x"},"b":{"path":"y"}}', 'test'),
    { a: { path: 'x' }, b: { path: 'y' } },
  );
});

test('a JSON.parse reviver cannot see a shadowed duplicate value at all — documented here as the reason parseJsonOrThrow uses a real tokenizing parser instead of a reviver hook, not as a claim this contract makes about itself', () => {
  const seenValuesForVerdict = [];
  JSON.parse('{"verdict":"NEEDS_FIXES","verdict":"PASS"}', (key, value) => {
    if (key === 'verdict') seenValuesForVerdict.push(value);
    return value;
  });
  assert.deepEqual(seenValuesForVerdict, ['PASS'], 'the reviver is invoked once per key, with only the surviving value — this is exactly why a reviver-based fix would not work');
});

test('parseJsonOrThrow does not let a "__proto__" key pollute the object prototype — a hand-rolled parser must preserve JSON.parse\'s own safety here deliberately, not by accident', () => {
  const parsed = parseJsonOrThrow('{"__proto__":{"polluted":true},"x":1}', 'test');
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, '"__proto__" must become an ordinary own property, never replace the object\'s actual prototype');
  assert.equal(parsed.x, 1);
  assert.equal(({}).polluted, undefined, 'Object.prototype itself must be unaffected');
});

// --- SC-12 (round 6): string parsing must stay correct after switching from per-character ----------
// accumulation to slice-per-unescaped-run accumulation (see parseString's own comment in
// pipeline-contracts.mjs). These pin correctness for exactly the boundary cases a run-based rewrite
// can get subtly wrong — an escape at the very start/end of a string, back-to-back escapes with no
// literal run between them, and a \u escape — none of which the pre-existing duplicate-key tests
// above happen to exercise.

test('parseJsonOrThrow parses a plain string with no escapes (a single, uninterrupted run)', () => {
  assert.deepEqual(parseJsonOrThrow('{"a":"hello world"}', 'test'), { a: 'hello world' });
});

test('parseJsonOrThrow parses every single-character escape JSON defines, each producing the correct literal character', () => {
  const parsed = parseJsonOrThrow(String.raw`{"a":"\"\\\/\b\f\n\r\t"}`, 'test');
  assert.deepEqual(parsed, { a: '"\\/\b\f\n\r\t' });
});

test('parseJsonOrThrow handles an escape at the very start of a string, the very end, and back-to-back escapes with no literal run between them', () => {
  assert.deepEqual(parseJsonOrThrow(String.raw`{"a":"\nend"}`, 'test'), { a: '\nend' });
  assert.deepEqual(parseJsonOrThrow(String.raw`{"a":"start\n"}`, 'test'), { a: 'start\n' });
  assert.deepEqual(parseJsonOrThrow(String.raw`{"a":"\n\t\n"}`, 'test'), { a: '\n\t\n' }, 'three consecutive escapes with zero-length literal runs between them');
});

test('parseJsonOrThrow decodes a \\u escape correctly, including one sitting between two literal runs, and passes a literal (unescaped) non-ASCII character straight through', () => {
  // Built via plain string concatenation, deliberately not a template literal, so there is no
  // ambiguity about how many backslashes reach parseJsonOrThrow: '\\u0041' in a normal JS string
  // literal is one escaped backslash followed by the six characters u, 0, 0, 4, 1 — i.e. the JSON
  // text this test hands to the parser literally contains the two-character sequence \u followed by
  // 0041, for the parser's OWN \u-escape handling (parseString) to decode, not JavaScript's.
  const jsonWithUnicodeEscape = '{"a":"before' + '\\u0041' + 'after"}';
  assert.deepEqual(parseJsonOrThrow(jsonWithUnicodeEscape, 'test'), { a: 'beforeAafter' }, '\\u0041 mid-string must decode to "A" without disturbing the literal runs on either side of it');
  assert.deepEqual(parseJsonOrThrow('{"a":"café"}', 'test'), { a: 'café' }, 'a literal, unescaped non-ASCII character is just another character in the run, not an escape');
});

test('parseJsonOrThrow still rejects an unescaped control character inside a string, and an invalid escape character', () => {
  assert.throws(() => parseJsonOrThrow('{"a":"line1\nline2"}', 'test'), SidecarError); // a literal newline byte, not the two-character \n escape
  assert.throws(() => parseJsonOrThrow(String.raw`{"a":"\q"}`, 'test'), SidecarError);
});

test('[SC-12 regression] parseJsonOrThrow parses a large single-string value in roughly linear time, not quadratic — benchmark-shaped so a future regression to per-character accumulation stays visible, but tolerant of CI timing noise (a ratio check, not a strict absolute-time assertion)', () => {
  function timeParseMs(charCount) {
    const text = `{"value":"${'a'.repeat(charCount)}"}`;
    const start = process.hrtime.bigint();
    const parsed = parseJsonOrThrow(text, 'benchmark');
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(parsed.value.length, charCount);
    return elapsedMs;
  }

  timeParseMs(50_000); // warm up the JIT before measuring

  const small = timeParseMs(1_000_000); // 1,000,000-character string
  const large = timeParseMs(8_000_000); // 8x the size

  // SC-12 measured the pre-fix, per-character `out += ch` implementation growing super-linearly —
  // roughly a 4x time increase for a 2x size increase at real-world (40MB -> 80MB) scale, and ~250x
  // slower than native JSON.parse overall. A slice-per-run implementation should grow roughly with
  // the input size: 8x the characters should cost nowhere near 8^2 = 64x the time. This allows a
  // generous 20x (well under 64x, comfortably above what genuine linear growth plus CI noise should
  // ever produce) so the assertion fails fast on a real quadratic-ish regression without being flaky.
  assert.ok(
    large < Math.max(small * 20, 50),
    `expected roughly linear growth: 1M chars took ${small.toFixed(1)}ms, 8M chars took ${large.toFixed(1)}ms (${(large / Math.max(small, 0.001)).toFixed(1)}x)`,
  );
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
//
// The fail-closed cases (missing file, missing/wrong-type/duplicate field) live in
// SIDECAR_VALIDATION_CASES near the end of this file, not here — this section keeps only the
// positive/behavioral tests: parses correctly, returns null when explicitly optional, and never
// launders a prose-only token into a declared id.

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

test('readSpecJson returns null (not a throw) when explicitly optional and the file does not exist', () => {
  const dir = pipelineDir({});
  assert.equal(readSpecJson(dir, { required: false }), null);
});

// @spec AC-14
test('readSpecJson never launders an id-shaped token that only appears in prose — unlike the old extractKnownSpecIds, there is no section text to grep at all, only declared {id,text} items', () => {
  // Analogous to the old "AC-77 appears only inside a fenced code example" exploit: here there is no
  // markdown at all for a fenced example to hide in — "AC-77" only "exists" if it is a declared item.
  const raw = validSpecJson({ goal: 'Mentions AC-77 in prose, e.g. "illustrated as AC-77, not as a declared item."' });
  const dir = pipelineDir({ 'spec.json': raw });
  const spec = readSpecJson(dir);
  assert.ok(!knownSpecIds(spec).has('AC-77'), 'a token appearing only inside a string value must never resolve as a declared id');
});

// --- spec.json's "lane" field (PL-03e — the wiring pass, .sdd/stages/planner.md) -----------------
//
// Unlike every other field on spec.json, "lane" is optional and defaults to null: it did not exist
// before this ticket, so every spec.json already on disk (and every existing fixture in this test
// file's own suite) has no "lane" key at all and must keep parsing exactly as before. The two
// fail-closed cases (wrong type, empty string) are in SIDECAR_VALIDATION_CASES.

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

test('readRedJson lowercases a recorded sha256 so a case-differing but byte-identical hash is never treated as a mismatch', () => {
  const dir = pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'A'.repeat(64), specIds: [], classification: 'RED-CORRECT' }] }) });
  const red = readRedJson(dir);
  assert.equal(red.tests[0].sha256, 'a'.repeat(64));
});

// =================================================================================================
// PL-CI-QUAL — validateRedTest gains duplicateOf/justification/extends (AC-7, EC-9, EC-14).
// =================================================================================================

// @spec AC-7 EC-14
test('[red-quality] readRedJson passes duplicateOf/justification/extends through on a test entry, and a legacy entry with none of the three still parses exactly as before', () => {
  const dir = pipelineDir({
    'red.json': validRedJson({
      tests: [
        { path: 'scripts/a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' },
        {
          path: 'scripts/b.test.mjs', sha256: 'b'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT',
          duplicateOf: 'scripts/a.test.mjs', justification: 'b.test.mjs extends a.test.mjs\'s AC-1 case for the CLI path.',
          extends: 'scripts/a.test.mjs',
        },
      ],
    }),
  });
  const red = readRedJson(dir);
  assert.equal(red.tests[0].duplicateOf, undefined, 'a legacy entry with none of the three fields must parse exactly as before (EC-14)');
  assert.equal(red.tests[1].duplicateOf, 'scripts/a.test.mjs', 'duplicateOf must be passed through, not silently dropped (AC-7)');
  assert.equal(red.tests[1].justification, 'b.test.mjs extends a.test.mjs\'s AC-1 case for the CLI path.', 'justification must be passed through (AC-7)');
  assert.equal(red.tests[1].extends, 'scripts/a.test.mjs', 'extends must be passed through (AC-7)');
});

// @spec AC-7
test('[red-quality] readRedJson rejects duplicateOf present without a non-empty justification, naming both fields', () => {
  const dir = pipelineDir({
    'red.json': validRedJson({
      tests: [{ path: 'scripts/a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT', duplicateOf: 'scripts/b.test.mjs' }],
    }),
  });
  assert.throws(() => readRedJson(dir), /(?=[\s\S]*duplicateOf)(?=[\s\S]*justification)/,
    'error must name both duplicateOf and justification (AC-7)');
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

test('readChangesJson tolerates an empty filesChanged array (a legitimately clean sub-task, not the same as changes.json being absent)', () => {
  const dir = pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [] } });
  const changes = readChangesJson(dir);
  assert.deepEqual(changes.filesChanged, []);
});

// --- review.json ----------------------------------------------------------------------------------

test('readReviewJson parses PASS and NEEDS_FIXES, and nothing else', () => {
  assert.equal(readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS' } })).verdict, 'PASS');
  // PL-CI-QUAL / AC-21: NEEDS_FIXES now requires a non-empty findings array at the parser layer —
  // this fixture's subject is verdict parsing, not findings-optionality, so it carries a minimal
  // valid finding rather than losing coverage of the NEEDS_FIXES literal itself.
  assert.equal(readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] } })).verdict, 'NEEDS_FIXES');
});

// --- security.json ----------------------------------------------------------------------------------

test('readSecurityJson requires runId even when verdict is BLOCKED — a run id always exists once security-checker creates its immutable run directory, win or lose', () => {
  // PL-CI-QUAL / AC-21: BLOCKED now requires a non-empty findings array at the parser layer — this
  // fixture's subject is runId, not findings-optionality, so it carries a minimal valid finding.
  const dir = pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-123', findings: [validFinding({ id: 'S1' })] } });
  const security = readSecurityJson(dir);
  assert.equal(security.verdict, 'BLOCKED');
  assert.equal(security.runId, 'run-123');
});

// --- gaps.json (/pipeline-gapfill) ----------------------------------------------------------------

test('readGapsJson accepts a GAPFILL sidecar with non-OK items and rejects ALREADY_COMPLETE with open gaps', () => {
  const good = pipelineDir({
    'gaps.json': {
      ticket: 'W2-04',
      overlays: ['base'],
      securityRequired: true,
      auditFirst: false,
      verdict: 'GAPFILL',
      items: [
        {
          id: 'GAP-1',
          status: 'NARROWED',
          source: 'Acceptance sentence',
          evidence: ['apps/web/x.ts'],
          needsTest: true,
        },
      ],
    },
  });
  const parsed = readGapsJson(good);
  assert.equal(parsed.verdict, 'GAPFILL');
  assert.equal(parsed.items[0].id, 'GAP-1');

  assert.throws(
    () =>
      readGapsJson(
        pipelineDir({
          'gaps.json': {
            ticket: 'W2-04',
            overlays: ['base'],
            securityRequired: true,
            verdict: 'ALREADY_COMPLETE',
            items: [
              {
                id: 'GAP-1',
                status: 'MISSING',
                source: 'x',
                evidence: [],
                needsTest: true,
              },
            ],
          },
        }),
      ),
    /ALREADY_COMPLETE/,
  );
});

// --- Freshness stamps (PL-04 / A2) -----------------------------------------------------------------
//
// Observed live during this fix round: `.pipeline/review.json` read `NEEDS_FIXES` and
// `.pipeline/security.json` read `BLOCKED`, both stale leftovers from a prior session, with nothing on
// either file to say so. `computeTreeHash`/`buildStamp`/`stampFreshness` are the fix; the tests below
// cover, in order: the hash actually reflects working-tree content (not just HEAD), `buildStamp`'s
// shape, `stampFreshness`'s three-state contract (fresh/stale/unknown — never a boolean), and that all
// five `.pipeline/*.json` readers parse an optional `stamp` field identically (the "do not vary the
// shape" requirement — a separate, stage-side change targets this exact contract).

test('computeTreeHash is deterministic: two calls against the same, unchanged working tree produce the same hash', () => {
  const root = gitFixtureRepo();
  assert.equal(computeTreeHash(root), computeTreeHash(root));
});

test('computeTreeHash changes when a tracked file is edited without being committed — a stamp that only tracked HEAD would miss this entirely', () => {
  const root = gitFixtureRepo();
  const before = computeTreeHash(root);
  writeFileSync(join(root, 'tracked.txt'), 'edited, uncommitted content\n', 'utf8');
  const after = computeTreeHash(root);
  assert.notEqual(before, after);
});

test('computeTreeHash changes when a new untracked file appears', () => {
  const root = gitFixtureRepo();
  const before = computeTreeHash(root);
  writeFileSync(join(root, 'untracked.txt'), 'brand new file\n', 'utf8');
  const after = computeTreeHash(root);
  assert.notEqual(before, after);
});

test('computeTreeHash returns to its original value once an uncommitted edit is reverted back to the committed content — the hash reflects current content, not merely "is something dirty"', () => {
  const root = gitFixtureRepo();
  const original = computeTreeHash(root);
  writeFileSync(join(root, 'tracked.txt'), 'temporarily edited\n', 'utf8');
  assert.notEqual(computeTreeHash(root), original);
  writeFileSync(join(root, 'tracked.txt'), 'original content\n', 'utf8');
  assert.equal(computeTreeHash(root), original);
});

test('computeTreeHash never throws outside a git repository at all, and stays deterministic there too (git failures are tolerated, never fatal)', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sayre-pipeline-contracts-nogit-'));
  roots.push(root);
  assert.equal(computeTreeHash(root), computeTreeHash(root));
});

test('buildStamp returns the exact { treeHash, headSha, dirty, writtenAt } shape, with headSha matching git rev-parse HEAD and dirty reflecting an uncommitted change', () => {
  const root = gitFixtureRepo();
  const cleanStamp = buildStamp(root);
  assert.equal(typeof cleanStamp.treeHash, 'string');
  assert.ok(cleanStamp.treeHash.length > 0);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(cleanStamp.headSha, headSha);
  assert.equal(cleanStamp.dirty, false);
  assert.ok(!Number.isNaN(Date.parse(cleanStamp.writtenAt)), 'writtenAt must be a parseable timestamp');

  writeFileSync(join(root, 'tracked.txt'), 'now dirty\n', 'utf8');
  const dirtyStamp = buildStamp(root);
  assert.equal(dirtyStamp.headSha, headSha, 'headSha reflects HEAD, unaffected by an uncommitted change');
  assert.equal(dirtyStamp.dirty, true);
  assert.notEqual(dirtyStamp.treeHash, cleanStamp.treeHash);
});

test('stampFreshness returns "unknown" (never "fresh") for a missing stamp — an artifact with no stamp must never read as trustworthy just because nothing contradicts it', () => {
  const root = gitFixtureRepo();
  assert.equal(stampFreshness(null, root), STAMP_UNKNOWN);
  assert.equal(stampFreshness(undefined, root), STAMP_UNKNOWN);
});

test('stampFreshness returns "fresh" when a stamp\'s treeHash still matches the current working tree, and "stale" the moment the tree changes underneath it', () => {
  const root = gitFixtureRepo();
  const stamp = buildStamp(root);
  assert.equal(stampFreshness(stamp, root), STAMP_FRESH);

  writeFileSync(join(root, 'tracked.txt'), 'the tree moved on since this stamp was written\n', 'utf8');
  assert.equal(stampFreshness(stamp, root), STAMP_STALE);
});

test('stampFreshness is a pure hash comparison, not influenced by dirty/headSha/writtenAt — a stamp with a matching treeHash reads fresh even if its other fields look stale or mismatched', () => {
  const root = gitFixtureRepo();
  const stamp = { treeHash: computeTreeHash(root), headSha: 'deadbeef', dirty: true, writtenAt: '2000-01-01T00:00:00.000Z' };
  assert.equal(stampFreshness(stamp, root), STAMP_FRESH, 'only treeHash equality should matter to this decision');
});

// --- Every .pipeline/*.json reader parses an optional "stamp" field the same way (do not vary the ---
// shape): missing is null (back-compat), a well-formed stamp round-trips, and a malformed one fails
// closed exactly like any other field in this file (the malformed cases are in
// SIDECAR_VALIDATION_CASES below).

test('readReviewJson returns stamp: null when review.json has no "stamp" field — every review.json on disk before this contract existed must keep parsing', () => {
  const dir = pipelineDir({ 'review.json': { verdict: 'PASS' } });
  assert.equal(readReviewJson(dir).stamp, null);
});

test('readReviewJson parses a well-formed "stamp" field into the exact shape it was given', () => {
  const stamp = { treeHash: 'a'.repeat(64), headSha: 'b'.repeat(40), dirty: true, writtenAt: '2026-08-04T07:00:00.000Z' };
  // PL-CI-QUAL / AC-21: NEEDS_FIXES now requires a non-empty findings array — this fixture's
  // subject is the stamp field, so it carries a minimal valid finding to stay a legal NEEDS_FIXES.
  const dir = pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()], stamp } });
  assert.deepEqual(readReviewJson(dir).stamp, stamp);
});

test('readSecurityJson returns stamp: null when absent, and parses a well-formed stamp when present — same shared contract as readReviewJson\'s', () => {
  const dirNoStamp = pipelineDir({ 'security.json': { verdict: 'PASS', runId: 'run-1' } });
  assert.equal(readSecurityJson(dirNoStamp).stamp, null);

  // PL-04 review pass 3 / Warning 1a: 'x'/'y' are not hex characters — readStamp's new hex-shape check
  // (see its own doc comment) would reject them, so this fixture uses a valid-length hex filler instead
  // (still an arbitrary value never compared against anything real — see this test's own name).
  // PL-CI-QUAL / AC-21: BLOCKED now requires a non-empty findings array — this fixture's subject is
  // the stamp field, so it carries a minimal valid finding to stay a legal BLOCKED.
  const stamp = { treeHash: 'c'.repeat(64), headSha: 'f'.repeat(40), dirty: false, writtenAt: '2026-08-04T07:00:00.000Z' };
  const dirWithStamp = pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1', findings: [validFinding({ id: 'S1' })], stamp } });
  assert.deepEqual(readSecurityJson(dirWithStamp).stamp, stamp);
});

test('readSpecJson, readRedJson, and readChangesJson all return stamp: null when absent — the same back-compat contract applies uniformly across every .pipeline/*.json reader, not only review/security', () => {
  const specDir = pipelineDir({ 'spec.json': validSpecJson() });
  assert.equal(readSpecJson(specDir).stamp, null);

  const redDir = pipelineDir({ 'red.json': validRedJson() });
  assert.equal(readRedJson(redDir).stamp, null);

  const changesDir = pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [] } });
  assert.equal(readChangesJson(changesDir).stamp, null);
});

test('readSpecJson, readRedJson, and readChangesJson each parse a well-formed "stamp" field the same shape readReviewJson does', () => {
  const stamp = { treeHash: 'd'.repeat(64), headSha: 'e'.repeat(40), dirty: true, writtenAt: '2026-08-04T08:00:00.000Z' };

  const specDir = pipelineDir({ 'spec.json': validSpecJson({ stamp }) });
  assert.deepEqual(readSpecJson(specDir).stamp, stamp);

  const redDir = pipelineDir({ 'red.json': validRedJson({ stamp }) });
  assert.deepEqual(readRedJson(redDir).stamp, stamp);

  const changesDir = pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [], stamp } });
  assert.deepEqual(readChangesJson(changesDir).stamp, stamp);
});

// === PL-04 / C2: the fail-closed validation matrix =================================================
//
// Every row below used to be its own top-level `test()` (same shape every time: build an otherwise-
// valid sidecar with one field wrong, call the reader, assert it throws a named error). `name` carries
// the same documentation the original test name did; `run`/`check` make exactly the assertion the
// original test body made. Rows tagged [DUP-KEY] are the duplicate-object-key class that produced a
// durable, forged `review: PASS`/`security: PASS` ledger entry end to end (review round 4 / security
// SEC-10 — see the file header above); nothing here is new, and nothing was dropped.

/** Shallow-copies `obj` without `key` — used below wherever a case is "this required field is
 * missing", so the row itself stays one line instead of a 5-line delete-and-return closure. */
function omit(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

/** `error instanceof SidecarError` AND its message names the duplicated key — the predicate every
 * [DUP-KEY] row shares, built once instead of inline per row. */
function duplicateKey(keyName) {
  const pattern = new RegExp(`duplicate key "${keyName}"`);
  return (error) => error instanceof SidecarError && pattern.test(error.message);
}

const SIDECAR_VALIDATION_CASES = [
  // spec.json
  { name: 'spec.json missing entirely (required)', run: () => readSpecJson(pipelineDir({})), check: /spec\.json does not exist/ },
  { name: 'spec.json "goal" missing', run: () => readSpecJson(pipelineDir({ 'spec.json': omit(validSpecJson(), 'goal') })), check: /field "goal" must be a non-empty string/ },
  { name: 'spec.json "acceptanceCriteria" not an array (the shape an LLM sometimes collapses a one-item list to)', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ acceptanceCriteria: { id: 'AC-1', text: 'First.' } }) })), check: /field "acceptanceCriteria" must be an array/ },
  { name: 'spec.json id does not match the AC-n/EC-n shape', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ acceptanceCriteria: [{ id: 'AC1', text: 'Missing the dash.' }] }) })), check: /does not match the required AC-n \/ EC-n shape/ },
  { name: 'spec.json duplicate id shared between acceptanceCriteria and edgeCases — the JSON-contract equivalent of extractSection\'s old "fail closed on ambiguity" invariant', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ edgeCases: [{ id: 'AC-1', text: 'Reuses AC-1 by mistake.' }] }) })), check: /id "AC-1" appears more than once/ },
  { name: 'spec.json "lane" present but wrong type (a number)', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ lane: 42 }) })), check: /field "lane" must be a non-empty string/ },
  { name: 'spec.json "lane" present but an empty string — not the same as genuinely undeclared', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ lane: '' }) })), check: /field "lane" must be a non-empty string/ },

  // red.json
  { name: 'red.json classification "RED-BROKEN" — not in the enum at all, so no separate substring-scan check is needed', run: () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'a'.repeat(64), specIds: [], classification: 'RED-BROKEN' }] }) })), check: /field "classification" must be exactly one of/ },
  { name: 'red.json "impactMapPresent" missing — omission is not the same as a stated absence', run: () => readRedJson(pipelineDir({ 'red.json': omit(validRedJson(), 'impactMapPresent') })), check: /field "impactMapPresent" must be a boolean/ },
  { name: 'red.json malformed sha256 (wrong length, or a non-hex character)', run: () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'x.test.mjs', sha256: 'not-a-real-hash', specIds: [], classification: 'RED-CORRECT' }] }) })), check: /must be a 64-character hex digest/ },
  {
    name: 'red.json "tests" lists the same path twice — two entries for one path is an ambiguity (which entry\'s hash/specIds governs?) one level below a duplicate heading',
    run: () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [
      { path: 'scripts/dup.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT' },
      { path: 'scripts/dup.test.mjs', sha256: 'b'.repeat(64), specIds: ['AC-2'], classification: 'RED-CORRECT' },
    ] }) })),
    check: /lists "scripts\/dup\.test\.mjs" more than once/,
  },
  { name: '[DUP-KEY] red.json duplicate "sha256" key WITHIN one tests[] element (distinct from two elements sharing a path, above)', run: () => readRedJson(pipelineDir({ 'red.json': `{"impactMapPresent":false,"tests":[{"path":"x.test.mjs","sha256":"${'a'.repeat(64)}","specIds":[],"classification":"RED-CORRECT","sha256":"${'b'.repeat(64)}"}]}` })), check: duplicateKey('sha256') },

  // changes.json
  { name: 'changes.json redTestChanges entry has no "reason"', run: () => readChangesJson(pipelineDir({ 'changes.json': { filesChanged: [], redTestChanges: [{ path: 'x.ts' }] } })), check: /field "reason" must be a non-empty string/ },
  { name: '[DUP-KEY] changes.json duplicate "filesChanged" key — a fabricated second files-touched list could otherwise launder an out-of-scope change past review', run: () => readChangesJson(pipelineDir({ 'changes.json': '{"filesChanged":["a.ts"],"redTestChanges":[],"filesChanged":["b.ts"]}' })), check: duplicateKey('filesChanged') },

  // review.json
  { name: 'review.json verdict merely contains the word PASS in a sentence, not the exact literal ("This run should probably PASS once minor things are fixed")', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'This run should probably PASS once minor things are fixed.' } })), check: /field "verdict" must be exactly one of/ },
  { name: 'review.json missing entirely (required)', run: () => readReviewJson(pipelineDir({})), check: /review\.json does not exist/ },
  {
    // CORRECTED (round 5 / review Critical 1): this case used to assert the opposite ("last value
    // wins" as an accepted honest limit) — the exact exploit review round 4 reproduced end to end.
    name: '[DUP-KEY] review.json duplicate "verdict" key, rather than "last value wins" — the exact review:PASS forgery review.md\'s round-4 report demonstrated end to end',
    run: () => readReviewJson(pipelineDir({ 'review.json': '{"verdict":"NEEDS_FIXES","verdict":"PASS"}' })),
    check: duplicateKey('verdict'),
  },

  // security.json
  { name: 'security.json "runId" missing', run: () => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'PASS' } })), check: /field "runId" must be a non-empty string/ },
  { name: 'security.json verdict outside {PASS, BLOCKED}', run: () => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'PARTIAL', runId: 'run-123' } })), check: /field "verdict" must be exactly one of/ },
  { name: '[DUP-KEY] security.json duplicate "verdict" key — the same BLOCKED -> PASS forgery as review.json\'s, one sidecar over', run: () => readSecurityJson(pipelineDir({ 'security.json': '{"verdict":"BLOCKED","runId":"run-123","verdict":"PASS"}' })), check: duplicateKey('verdict') },

  // red-integrity.json — written by tester (AC-14)
  // These rows fail before dev implements readRedIntegrityJson: calling undefined(...) throws
  // TypeError rather than SidecarError, so assert.throws fails because the expected pattern
  // doesn't match. That is RED-CORRECT: the behavior under test (strict validation) does not
  // yet exist. After dev adds readRedIntegrityJson, each row throws the expected SidecarError.
  { name: 'red-integrity.json "redIntegrity" outside the allowed set ("DUNNO" is not PASS/FAIL/UNVERIFIED)', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ redIntegrity: 'DUNNO' }) })), check: /field "redIntegrity" must be exactly one of/ },
  { name: 'red-integrity.json "scriptStatus" outside the allowed set ("unknown" is not one of the four statuses)', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ scriptStatus: 'unknown' }) })), check: /field "scriptStatus" must be exactly one of/ },
  { name: 'red-integrity.json "redExpected" not a boolean — the string "true" must not silently pass', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ redExpected: 'true' }) })), check: /field "redExpected" must be a boolean/ },
  { name: 'red-integrity.json "violations" not an array (a plain string)', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ violations: 'some violation' }) })), check: /field "violations" must be an array/ },
  { name: 'red-integrity.json "judgments" not an array (an object)', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ judgments: {} }) })), check: /field "judgments" must be an array/ },
  { name: 'red-integrity.json judgment entry missing "path"', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ judgments: [{ verdict: 'ok', reason: 'Fine.' }] }) })), check: /field "path" must be a non-empty string/ },
  { name: 'red-integrity.json judgment entry missing "reason"', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ judgments: [{ path: 'x.test.mjs', verdict: 'ok' }] }) })), check: /field "reason" must be a non-empty string/ },
  { name: 'red-integrity.json judgment "verdict" outside the allowed set ("good" is not "ok" or "blocking")', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ judgments: [{ path: 'x.test.mjs', verdict: 'good', reason: 'Fine.' }] }) })), check: /field "verdict" must be exactly one of/ },
  { name: '[DUP-KEY] red-integrity.json duplicate "redIntegrity" key — the same PASS forgery as review.json\'s, one sidecar over', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': '{"redIntegrity":"FAIL","scriptStatus":"clean","redExpected":true,"violations":[],"judgments":[],"redIntegrity":"PASS"}' })), check: duplicateKey('redIntegrity') },

  // PL-FIXBRIEF: additive findings / affectedFiles / fix-brief.json
  { name: 'review.json findings not an array', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: 'R1' } })), check: /field "findings" must be an array/ },
  { name: 'review.json finding missing summary', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [{ id: 'R1', paths: ['a.ts'], requiredOutcome: 'Fixed.' }] } })), check: /field "summary" must be a non-empty string/ },
  { name: 'review.json finding empty paths', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [{ id: 'R1', summary: 'x', paths: [], requiredOutcome: 'Fixed.' }] } })), check: /paths/ },
  // PL-CI-QUAL fix-loop (R1): this row previously carried a spec marker naming edge case 15, which
  // was a mislabel — that edge case is the legacy-red-integrity.json/redQuality-default one (see the
  // genuine, directly-asserting coverage of it below, tagged "[red-quality] readRedIntegrityJson
  // defaults redQuality..."), not review.json's finding-id-uniqueness rule this row actually
  // exercises. Left untagged, like the surrounding rows in this array that also have no individual
  // spec-marker comment — this row's own assertion runs via the shared "every case in
  // SIDECAR_VALIDATION_CASES fails closed" loop below, same as every other row here.
  { name: 'review.json duplicate finding id', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [
    { id: 'R1', summary: 'a', paths: ['a.ts'], requiredOutcome: 'A.' },
    { id: 'R1', summary: 'b', paths: ['b.ts'], requiredOutcome: 'B.' },
  ] } })), check: /R1.*more than once|lists "R1" more than once|duplicate/ },
  { name: 'review.json finding relatedAc id is not AC-n/EC-n', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [{ id: 'R1', summary: 'x', paths: ['a.ts'], relatedAc: ['R1'], requiredOutcome: 'Fixed.' }] } })), check: /does not match the required AC-n \/ EC-n shape/ },
  { name: 'security.json findings not an array', run: () => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'r-1', findings: 'S1' } })), check: /field "findings" must be an array/ },
  { name: 'spec.json affectedFiles not an array', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ affectedFiles: 'scripts/foo.mjs' }) })), check: /field "affectedFiles" must be an array/ },
  { name: 'spec.json affectedFiles lists the same path twice', run: () => readSpecJson(pipelineDir({ 'spec.json': validSpecJson({ affectedFiles: ['a.ts', 'a.ts'] }) })), check: /more than once/ },
  { name: 'fix-brief.json fullSpecStillGoverns is false', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ fullSpecStillGoverns: false }) })), check: /fullSpecStillGoverns/ },
  { name: 'fix-brief.json fullSpecStillGoverns is the string "true"', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ fullSpecStillGoverns: 'true' }) })), check: /fullSpecStillGoverns/ },
  { name: 'fix-brief.json attempt is 1', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ attempt: 1 }) })), check: /attempt/ },
  { name: 'fix-brief.json source outside {review, security}', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ source: 'tester' }) })), check: /field "source" must be exactly one of/ },
  { name: 'fix-brief.json allowedPaths is empty', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ allowedPaths: [] }) })), check: /allowedPaths/ },
  { name: 'fix-brief.json findings is empty', run: () => _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson({ findings: [] }) })), check: /findings/ },

  // PL-CI-QUAL: duplicateOf implies justification (edge case 9), redQuality/qualityViolations
  // validity (acceptance criterion 12), and requiredNonEmpty findings on NEEDS_FIXES/BLOCKED
  // (acceptance criterion 21). PL-CI-QUAL fix-loop (R1): the four rows below no longer carry their
  // own inline spec-marker comments for those first two ids — each row's assertion still runs,
  // unchanged, via the shared "every case in SIDECAR_VALIDATION_CASES fails closed" loop below, but
  // a marker sitting directly on one of these data-array lines is a segment (per
  // scripts/check-red-quality.mjs's marker-to-next-marker split) that never reaches that shared
  // loop's actual assert.throws() call, which check-red-quality.mjs correctly read as a stub. Those
  // two ids instead get their own small, directly-asserting tests (not reliant on the shared loop)
  // immediately after this array closes, each carrying the real @spec marker.
  { name: 'red.json duplicateOf present with justification empty string', run: () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT', duplicateOf: 'b.test.mjs', justification: '' }] }) })), check: /duplicateOf.*justification|justification.*duplicateOf/is },
  { name: 'red.json duplicateOf present with justification whitespace-only', run: () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT', duplicateOf: 'b.test.mjs', justification: '   ' }] }) })), check: /duplicateOf.*justification|justification.*duplicateOf/is },
  { name: 'red-integrity.json redQuality outside {PASS, FAIL, UNVERIFIED}', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ redQuality: 'MAYBE' }) })), check: /field "redQuality" must be exactly one of/ },
  { name: 'red-integrity.json qualityViolations not an array', run: () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ qualityViolations: 'oops' }) })), check: /field "qualityViolations" must be an array/ },
  // @spec AC-21
  { name: 'review.json NEEDS_FIXES with findings entirely absent', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES' } })), check: /field "findings" must be a non-empty array/ },
  { name: 'review.json NEEDS_FIXES with findings explicitly empty', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [] } })), check: /field "findings" must be a non-empty array/ },
  { name: 'security.json BLOCKED with findings entirely absent', run: () => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1' } })), check: /field "findings" must be a non-empty array/ },
  { name: 'security.json BLOCKED with findings explicitly empty', run: () => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1', findings: [] } })), check: /field "findings" must be a non-empty array/ },

  // Every reader's shared, optional "stamp" field
  // PL-04 review pass 3 / Warning 1a: the two rows immediately below predate `readStamp`'s hex-shape
  // check on `treeHash`/`headSha` — they used single-character placeholders ('a'/'b') on the grounds
  // that "the exact treeHash/headSha values here are never compared to anything" (still true of their
  // own subject field, `dirty`). Widened to full-length, correctly-shaped hex placeholders so each row
  // still fails for the reason its name says, not on the new, unrelated hex-format check.
  { name: 'stamp present but missing a required subfield (no "dirty")', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', stamp: { treeHash: 'a'.repeat(64), headSha: 'b'.repeat(40), writtenAt: '2026-08-04T00:00:00.000Z' } } })), check: /stamp: field "dirty" must be a boolean/ },
  { name: 'stamp.dirty present but not a boolean', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', stamp: { treeHash: 'a'.repeat(64), headSha: 'b'.repeat(40), dirty: 'true', writtenAt: '2026-08-04T00:00:00.000Z' } } })), check: /stamp: field "dirty" must be a boolean/ },
  { name: '[DUP-KEY] duplicate key inside "stamp" itself — the same forgery class every other object here is closed against, one level down', run: () => readReviewJson(pipelineDir({ 'review.json': `{"verdict":"PASS","stamp":{"treeHash":"aaaa","treeHash":"bbbb","headSha":"c","dirty":false,"writtenAt":"2026-08-04T00:00:00.000Z"}}` })), check: duplicateKey('treeHash') },
  // PL-04 review pass 3 / Warning 1a: `readStamp` now checks treeHash/headSha against the hex shape
  // `buildStamp()` always produces — a shape check, not a provenance one (see that function's own doc
  // comment for the distinction). These two rows prove the check actually fires; the "accepts a
  // hand-written-but-correctly-shaped stamp" half of that same distinction (e.g. `treeHash:
  // '0'.repeat(64)`) is exactly what the pre-existing `[DUP-KEY]` row above, and `ledger-append.test.mjs`'s
  // own `DUMMY_SPEC_STAMP`, already exercise — this fix narrows what a malformed stamp can look like, it
  // does not, and is not meant to, reject every value a human could type by hand.
  { name: 'stamp.treeHash is not a 64-character hex digest — the shape computeTreeHash() always produces', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', stamp: { treeHash: 'not-a-real-hash', headSha: 'b'.repeat(40), dirty: false, writtenAt: '2026-08-04T00:00:00.000Z' } } })), check: /field "treeHash" must be a 64-character hex digest/ },
  { name: 'stamp.headSha is neither a 40-character hex digest nor the literal "(none)" no-HEAD fallback', run: () => readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', stamp: { treeHash: 'a'.repeat(64), headSha: 'deadbeef', dirty: false, writtenAt: '2026-08-04T00:00:00.000Z' } } })), check: /field "headSha" must be a 40-character hex digest/ },

  // parseJsonOrThrow's own [DUP-KEY] coverage — the primitive every row above is ultimately built on
  { name: '[DUP-KEY] parseJsonOrThrow rejects a duplicate top-level key, not merely "last value wins"', run: () => parseJsonOrThrow('{"verdict":"NEEDS_FIXES","verdict":"PASS"}', 'test'), check: duplicateKey('verdict') },
  { name: '[DUP-KEY] parseJsonOrThrow rejects a duplicate key nested inside an array element, not only at the top level', run: () => parseJsonOrThrow('{"tests":[{"path":"a.test.mjs","path":"b.test.mjs"}]}', 'test'), check: duplicateKey('path') },
];

test('every case in SIDECAR_VALIDATION_CASES fails closed with its named error — the full fail-closed attack surface across every .pipeline/*.json reader, at a glance', () => {
  for (const { name, run, check } of SIDECAR_VALIDATION_CASES) {
    assert.throws(run, check, name);
  }
});

test('readReviewJson accepts stamp.headSha === "(none)" — buildStamp()\'s own documented no-HEAD fallback, not merely coincidentally hex-shaped', () => {
  const result = readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', stamp: { treeHash: 'a'.repeat(64), headSha: '(none)', dirty: false, writtenAt: '2026-08-04T00:00:00.000Z' } } }));
  assert.equal(result.stamp.headSha, '(none)');
});

// PL-CI-QUAL fix-loop (R1): EC-9 and AC-12 previously lived only as inline comments inside
// SIDECAR_VALIDATION_CASES above, where the actual assert.throws() proving each one runs only in
// the shared "every case..." loop a few lines up — a segment split by marker-to-next-marker (see
// scripts/check-red-quality.mjs's specSegments) never sees into that shared loop from an inline
// array-row marker, so check-red-quality.mjs's no-assertion rule correctly flagged both as stubs.
// Each gets its own small, directly-asserting test here, proving the exact same case data drives a
// real throw independent of the shared loop.

// @spec EC-9
test('[red-quality] red.json duplicateOf present with an empty or whitespace-only justification is rejected — asserted directly, not only via the shared loop above', () => {
  assert.throws(
    () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT', duplicateOf: 'b.test.mjs', justification: '' }] }) })),
    /duplicateOf.*justification|justification.*duplicateOf/is,
    'an empty justification alongside duplicateOf must throw (EC-9)',
  );
  assert.throws(
    () => readRedJson(pipelineDir({ 'red.json': validRedJson({ tests: [{ path: 'a.test.mjs', sha256: 'a'.repeat(64), specIds: ['AC-1'], classification: 'RED-CORRECT', duplicateOf: 'b.test.mjs', justification: '   ' }] }) })),
    /duplicateOf.*justification|justification.*duplicateOf/is,
    'a whitespace-only justification alongside duplicateOf must throw (EC-9)',
  );
});

// @spec AC-12
test('[red-quality] red-integrity.json rejects an out-of-enum redQuality and a non-array qualityViolations — asserted directly, not only via the shared loop above', () => {
  assert.throws(
    () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ redQuality: 'MAYBE' }) })),
    /field "redQuality" must be exactly one of/,
    'an out-of-enum redQuality must throw (AC-12)',
  );
  assert.throws(
    () => _allContracts.readRedIntegrityJson(pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ qualityViolations: 'oops' }) })),
    /field "qualityViolations" must be an array/,
    'a non-array qualityViolations must throw (AC-12)',
  );
});

// =================================================================================================
// .pipeline/red-integrity.json — written by tester (AC-14)
// =================================================================================================
//
// Tests for the new readRedIntegrityJson reader and the three RED_INTEGRITY_* constant arrays that
// PL-INTEGRITY-TESTER adds to pipeline-contracts.mjs. These tests intentionally fail on a clean
// checkout (dev has not yet added the exports) — accessing an absent export through the namespace
// import gives `undefined`, so assertions like `Array.isArray(undefined)` and
// `typeof undefined === 'function'` correctly fail with RED-CORRECT classification.
//
// Validation cases are added to SIDECAR_VALIDATION_CASES below; positive/behavioral tests are here.

function validRedIntegrityJson(overrides = {}) {
  return {
    redIntegrity: 'PASS',
    scriptStatus: 'clean',
    redExpected: true,
    violations: [],
    judgments: [],
    ...overrides,
  };
}

// @spec AC-14
test('RED_INTEGRITY_VERDICTS, RED_INTEGRITY_SCRIPT_STATUSES, and RED_INTEGRITY_JUDGMENT_VERDICTS are exported constant arrays with the right values', () => {
  const { RED_INTEGRITY_VERDICTS, RED_INTEGRITY_SCRIPT_STATUSES, RED_INTEGRITY_JUDGMENT_VERDICTS } = _allContracts;
  assert.ok(Array.isArray(RED_INTEGRITY_VERDICTS),
    'RED_INTEGRITY_VERDICTS must be exported as an array — not yet present before dev implements AC-14');
  assert.deepEqual(
    [...(RED_INTEGRITY_VERDICTS ?? [])].sort(),
    ['FAIL', 'PASS', 'UNVERIFIED'],
    'RED_INTEGRITY_VERDICTS must contain exactly PASS, FAIL, UNVERIFIED',
  );
  assert.ok(Array.isArray(RED_INTEGRITY_SCRIPT_STATUSES),
    'RED_INTEGRITY_SCRIPT_STATUSES must be exported as an array');
  assert.deepEqual(
    [...(RED_INTEGRITY_SCRIPT_STATUSES ?? [])].sort(),
    ['clean', 'error', 'no-red-json', 'violations-found'],
    'RED_INTEGRITY_SCRIPT_STATUSES must contain exactly the four documented status values',
  );
  assert.ok(Array.isArray(RED_INTEGRITY_JUDGMENT_VERDICTS),
    'RED_INTEGRITY_JUDGMENT_VERDICTS must be exported as an array');
  assert.deepEqual(
    [...(RED_INTEGRITY_JUDGMENT_VERDICTS ?? [])].sort(),
    ['blocking', 'ok'],
    'RED_INTEGRITY_JUDGMENT_VERDICTS must contain exactly ok and blocking',
  );
});

// @spec AC-14
test('readRedIntegrityJson parses a well-formed red-integrity.json and returns all required fields', () => {
  const dir = pipelineDir({ 'red-integrity.json': validRedIntegrityJson() });
  const result = _allContracts.readRedIntegrityJson(dir);
  assert.equal(result.redIntegrity, 'PASS');
  assert.equal(result.scriptStatus, 'clean');
  assert.equal(result.redExpected, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.judgments, []);
  assert.equal(result.stamp, null, 'stamp must default to null when absent — back-compat, same as every other sidecar');
});

// @spec AC-14
test('readRedIntegrityJson returns null when optional and absent — a ticket predating this contract, or tester was skipped', () => {
  const dir = pipelineDir({});
  assert.equal(_allContracts.readRedIntegrityJson(dir, { required: false }), null);
});

// @spec AC-14
test('readRedIntegrityJson parses a well-formed judgment entry with path, verdict, and reason', () => {
  const dir = pipelineDir({
    'red-integrity.json': validRedIntegrityJson({
      judgments: [{ path: 'scripts/foo.test.mjs', verdict: 'ok', reason: 'Non-behavioral fixture added by tester.' }],
    }),
  });
  const result = _allContracts.readRedIntegrityJson(dir);
  assert.equal(result.judgments.length, 1);
  assert.equal(result.judgments[0].path, 'scripts/foo.test.mjs');
  assert.equal(result.judgments[0].verdict, 'ok');
  assert.equal(result.judgments[0].reason, 'Non-behavioral fixture added by tester.');
});

// @spec AC-14
test('readRedIntegrityJson returns stamp: null when absent and parses a well-formed stamp field — same back-compat contract as every other sidecar reader', () => {
  const stamp = { treeHash: 'a'.repeat(64), headSha: 'b'.repeat(40), dirty: false, writtenAt: '2026-08-13T00:00:00.000Z' };
  const dir = pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ stamp }) });
  assert.deepEqual(_allContracts.readRedIntegrityJson(dir).stamp, stamp);
});

// @spec AC-12 EC-15
test('[red-quality] readRedIntegrityJson defaults redQuality to "UNVERIFIED" and qualityViolations to [] when both keys are absent — a legacy red-integrity.json written before this ticket must keep parsing, never throw', () => {
  const dir = pipelineDir({ 'red-integrity.json': validRedIntegrityJson() });
  const result = _allContracts.readRedIntegrityJson(dir);
  assert.equal(result.redQuality, 'UNVERIFIED', 'absent redQuality must read as "UNVERIFIED", never throw (AC-12, EC-15)');
  assert.deepEqual(result.qualityViolations, [], 'absent qualityViolations must read as [] (AC-12, EC-15)');
});

// @spec AC-12
test('[red-quality] readRedIntegrityJson parses an explicit redQuality/qualityViolations pair', () => {
  const dir = pipelineDir({ 'red-integrity.json': validRedIntegrityJson({ redQuality: 'FAIL', qualityViolations: ['scripts/a.test.mjs: duplicate-spec-id on AC-9'] }) });
  const result = _allContracts.readRedIntegrityJson(dir);
  assert.equal(result.redQuality, 'FAIL', 'an explicit redQuality must be returned verbatim (AC-12)');
  assert.deepEqual(result.qualityViolations, ['scripts/a.test.mjs: duplicate-spec-id on AC-9'], 'an explicit qualityViolations must be returned verbatim (AC-12)');
});

// =================================================================================================
// PL-FIXBRIEF — additive findings / affectedFiles / readFixBriefJson
// =================================================================================================

function validFinding(overrides = {}) {
  return {
    id: 'R1',
    summary: 'Export readFixBriefJson.',
    paths: ['scripts/pipeline-contracts.mjs'],
    relatedAc: ['AC-1'],
    requiredOutcome: 'readFixBriefJson validates fix-brief.json.',
    ...overrides,
  };
}

function validFixBriefJson(overrides = {}) {
  return {
    source: 'review',
    attempt: 2,
    findings: [validFinding()],
    allowedPaths: ['scripts/pipeline-contracts.mjs'],
    fullSpecStillGoverns: true,
    ...overrides,
  };
}

// @spec AC-4 EC-12
test('readReviewJson accepts a missing findings field and returns findings: [] — every review.json on disk today must keep parsing', () => {
  const result = readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS' } }));
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.findings, [],
    'absent findings must default to [] rather than failing validation (AC-4, EC-12)');
});

// @spec AC-4
test('readReviewJson parses a well-formed findings array on NEEDS_FIXES', () => {
  const result = readReviewJson(pipelineDir({
    'review.json': { verdict: 'NEEDS_FIXES', findings: [validFinding()] },
  }));
  assert.equal(result.verdict, 'NEEDS_FIXES');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, 'R1');
  assert.deepEqual(result.findings[0].paths, ['scripts/pipeline-contracts.mjs']);
  assert.deepEqual(result.findings[0].relatedAc, ['AC-1']);
});

// @spec AC-4
test('readReviewJson defaults a missing relatedAc on a finding to []', () => {
  const finding = validFinding();
  delete finding.relatedAc;
  const result = readReviewJson(pipelineDir({
    'review.json': { verdict: 'NEEDS_FIXES', findings: [finding] },
  }));
  assert.deepEqual(result.findings[0].relatedAc, []);
});

// @spec AC-5 EC-12
test('readSecurityJson accepts a missing findings field and returns findings: []', () => {
  const result = readSecurityJson(pipelineDir({ 'security.json': { verdict: 'PASS', runId: 'run-1' } }));
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.findings, [],
    'absent findings must default to [] (AC-5, EC-12)');
});

// @spec AC-5
test('readSecurityJson parses a well-formed findings array on BLOCKED', () => {
  const result = readSecurityJson(pipelineDir({
    'security.json': {
      verdict: 'BLOCKED',
      runId: 'run-1',
      findings: [validFinding({ id: 'S1' })],
    },
  }));
  assert.equal(result.findings[0].id, 'S1');
});

// =================================================================================================
// PL-CI-QUAL — requiredNonEmpty threaded through readReviewJson/readSecurityJson (AC-21, EC-20,
// EC-21) and requireFindingId's corrected message (AC-22, EC-22).
// =================================================================================================

// @spec AC-21 EC-21 EC-20
test('[red-quality] readReviewJson throws at the parser layer (not merely at write-fix-brief.mjs\'s own guard) for NEEDS_FIXES with findings missing or empty, but PASS with the same absent/empty findings still parses (the rule is conditional on the verdict, never blanket)', () => {
  assert.throws(() => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES' } })),
    /field "findings" must be a non-empty array/,
    'a NEEDS_FIXES review.json with no findings key must fail at readReviewJson itself (AC-21)');
  assert.throws(() => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [] } })),
    /field "findings" must be a non-empty array/,
    'a NEEDS_FIXES review.json with an empty findings array must fail the same way (AC-21, EC-21)');
  const passAbsent = readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS' } }));
  assert.deepEqual(passAbsent.findings, [], 'a PASS review.json must not be forced to invent a finding (EC-20)');
  const passEmpty = readReviewJson(pipelineDir({ 'review.json': { verdict: 'PASS', findings: [] } }));
  assert.deepEqual(passEmpty.findings, [], 'a PASS review.json with findings: [] must also still parse (EC-20)');
});

// @spec AC-21 EC-21 EC-20
test('[red-quality] readSecurityJson throws for BLOCKED with findings missing or empty, the same requiredNonEmpty rule as readReviewJson, but PASS still parses with absent findings', () => {
  assert.throws(() => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1' } })),
    /field "findings" must be a non-empty array/,
    'a BLOCKED security.json with no findings key must fail at readSecurityJson itself (AC-21)');
  assert.throws(() => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1', findings: [] } })),
    /field "findings" must be a non-empty array/,
    'a BLOCKED security.json with an empty findings array must fail the same way (AC-21, EC-21)');
  const pass = readSecurityJson(pipelineDir({ 'security.json': { verdict: 'PASS', runId: 'run-1' } }));
  assert.deepEqual(pass.findings, [], 'a PASS security.json must not be forced to invent a finding (EC-20)');
});

// @spec AC-22 EC-22
test('[red-quality] requireFindingId\'s error message names the shape FINDING_ID_PATTERN actually accepts, not the hyphenated "R-n / S-n" form the regex itself rejects', () => {
  let thrown = null;
  try {
    readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [{ id: 'R-1', summary: 'x', paths: ['a.ts'], requiredOutcome: 'Fixed.' }] } }));
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert.ok(thrown, 'a finding id of "R-1" must still be rejected (AC-22)');
  assert.ok(!/R-n \/ S-n/.test(thrown), 'the message must no longer claim the hyphenated "R-n / S-n" shape is what\'s required (AC-22)');
  assert.ok(!/"R-1"[^]*valid|valid[^]*"R-1"/.test(thrown), 'the message must not present "R-1" as an accepted shape — the regex still rejects it (EC-22)');
  // The regex itself is unchanged by AC-22 (message-only fix): "R1"/"S2a" are still accepted, and
  // hyphenated "R-1" is still rejected — both directions pinned here so a future change to the
  // pattern itself (not just its message) is caught the same way.
  assert.doesNotThrow(() => readReviewJson(pipelineDir({ 'review.json': { verdict: 'NEEDS_FIXES', findings: [{ id: 'R1', summary: 'x', paths: ['a.ts'], requiredOutcome: 'Fixed.' }] } })),
    '"R1" (no hyphen) must still be accepted (EC-22)');
  assert.doesNotThrow(() => readSecurityJson(pipelineDir({ 'security.json': { verdict: 'BLOCKED', runId: 'run-1', findings: [{ id: 'S2a', summary: 'x', paths: ['a.ts'], requiredOutcome: 'Fixed.' }] } })),
    '"S2a" must still be accepted (EC-22)');
});

// @spec AC-6 EC-12
test('readSpecJson accepts a missing affectedFiles field and returns affectedFiles: [] — every spec.json on disk today must keep parsing', () => {
  const spec = readSpecJson(pipelineDir({ 'spec.json': validSpecJson() }));
  assert.deepEqual(spec.affectedFiles, [],
    'absent affectedFiles must default to [] rather than failing validation (AC-6, EC-12)');
});

// @spec AC-6
test('readSpecJson parses a unique affectedFiles path list', () => {
  const spec = readSpecJson(pipelineDir({
    'spec.json': validSpecJson({ affectedFiles: ['scripts/a.mjs', 'scripts/b.mjs'] }),
  }));
  assert.deepEqual(spec.affectedFiles, ['scripts/a.mjs', 'scripts/b.mjs']);
});

// @spec AC-3 AC-16
test('readFixBriefJson parses a well-formed fix-brief.json and rejects fullSpecStillGoverns that is not literal true', () => {
  assert.equal(typeof _allContracts.readFixBriefJson, 'function',
    'readFixBriefJson must be exported (AC-3)');
  const result = _allContracts.readFixBriefJson(pipelineDir({ 'fix-brief.json': validFixBriefJson() }));
  assert.equal(result.source, 'review');
  assert.equal(result.attempt, 2);
  assert.equal(result.fullSpecStillGoverns, true);
  assert.deepEqual(result.allowedPaths, ['scripts/pipeline-contracts.mjs']);
  assert.equal(result.findings[0].id, 'R1');
  assert.equal(result.stamp, null, 'stamp defaults to null when absent');
});

// @spec AC-3
test('readFixBriefJson returns null when optional and absent', () => {
  assert.equal(_allContracts.readFixBriefJson(pipelineDir({}), { required: false }), null);
});

// @spec AC-3
test('FINDING_ID_PATTERN is exported and matches R1 / S1 / R2a, not AC-1', () => {
  const { FINDING_ID_PATTERN } = _allContracts;
  assert.ok(FINDING_ID_PATTERN instanceof RegExp, 'FINDING_ID_PATTERN must be exported (AC-3)');
  assert.equal(FINDING_ID_PATTERN.test('R1'), true);
  assert.equal(FINDING_ID_PATTERN.test('S1'), true);
  assert.equal(FINDING_ID_PATTERN.test('R2a'), true);
  assert.equal(FINDING_ID_PATTERN.test('AC-1'), false);
});

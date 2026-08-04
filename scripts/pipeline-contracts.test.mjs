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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  MAX_JSON_FILE_BYTES,
  SidecarError,
  isDeclaredInChanges,
  knownSpecIds,
  parseJsonOrThrow,
  readChangesJson,
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
// ledger-append.mjs (see .pipeline/review.md). These tests pin the fix directly at the shared
// primitive every sidecar reader is built from, so every ACTUAL CALLER of it inherits the fix.
//
// CORRECTED (round 6 / security SEC-10): this comment used to say "so every caller inherits it
// automatically," full stop. That is false as a claim about the codebase as a whole — it is only
// true of code that actually calls `parseJsonOrThrow` (directly, or via `readJsonSidecar`/
// `readJsonFile`). `scripts/ledger-append.mjs`'s `findCompletedSecurityRun` read
// `security-history/<run-id>/manifest.json` and `results.json` with plain `JSON.parse` and was never
// such a caller, so the exact duplicate-key forgery these tests pin at the primitive still worked
// end to end one layer under `security.json` (which is such a caller) — see SEC-10 in
// `.pipeline/security-history/` for the live reproduction, and `ledger-append.test.mjs`'s C1
// regression section for the manifest.json/results.json tests added once that call site was fixed.
// "Automatic" was the word doing the damage here: it read as a property of the codebase, not of the
// primitive, and made the gap invisible to review until an adversarial pass went looking for it
// directly. The corrected claim is scoped to what is actually decidable at this file's boundary: this
// primitive is duplicate-key-safe, and every caller of it is too — whether a given script IS a caller
// is a fact about that script, checked per site, not something this file can guarantee on its behalf.

test('parseJsonOrThrow rejects a document with a duplicate top-level key, naming the key, rather than silently resolving via "last value wins"', () => {
  assert.throws(
    () => parseJsonOrThrow('{"verdict":"NEEDS_FIXES","verdict":"PASS"}', 'test'),
    (error) => error instanceof SidecarError && /duplicate key "verdict"/.test(error.message),
  );
});

test('parseJsonOrThrow rejects a duplicate key nested inside an array element, not only a duplicate at the top level', () => {
  assert.throws(
    () => parseJsonOrThrow('{"tests":[{"path":"a.test.mjs","path":"b.test.mjs"}]}', 'test'),
    (error) => error instanceof SidecarError && /duplicate key "path"/.test(error.message),
  );
});

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

test('readRedJson fails closed on a duplicate key WITHIN one tests[] element (distinct from two elements sharing a path, already covered above) — e.g. a duplicate "sha256" key on the same test object, letting a second, later value silently override the recorded hash', () => {
  const dir = pipelineDir({
    'red.json': `{"impactMapPresent":false,"tests":[{"path":"x.test.mjs","sha256":"${'a'.repeat(64)}","specIds":[],"classification":"RED-CORRECT","sha256":"${'b'.repeat(64)}"}]}`,
  });
  assert.throws(
    () => readRedJson(dir),
    (error) => error instanceof SidecarError && /duplicate key "sha256"/.test(error.message),
  );
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

test('readChangesJson fails closed on a duplicate "filesChanged" key — a fabricated second files-touched list could otherwise launder an out-of-scope change past review', () => {
  const dir = pipelineDir({ 'changes.json': '{"filesChanged":["a.ts"],"redTestChanges":[],"filesChanged":["b.ts"]}' });
  assert.throws(
    () => readChangesJson(dir),
    (error) => error instanceof SidecarError && /duplicate key "filesChanged"/.test(error.message),
  );
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

// CORRECTED (round 5 / review Critical 1): this test used to assert the opposite — that a duplicate
// "verdict" key resolves via "last value wins" as an accepted "honest limit." That was the exact
// exploit review round 4 reproduced end to end (a real NEEDS_FIXES run laundered into a durable
// `review: PASS` ledger entry). Fixed at the shared parseJsonOrThrow primitive (see that function's
// own tests above), so every reader built on it — including this one — now fails closed instead.
test('readReviewJson fails closed on a duplicate "verdict" key rather than resolving via "last value wins" — the exact review:PASS forgery review.md\'s round-4 report demonstrated end to end against the real ledger-append.mjs', () => {
  const dir = pipelineDir({ 'review.json': '{"verdict":"NEEDS_FIXES","verdict":"PASS"}' });
  assert.throws(
    () => readReviewJson(dir),
    (error) => error instanceof SidecarError && /duplicate key "verdict"/.test(error.message),
  );
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

test('readSecurityJson fails closed on a duplicate "verdict" key — the same BLOCKED -> PASS forgery as review.json\'s, one sidecar over', () => {
  const dir = pipelineDir({ 'security.json': '{"verdict":"BLOCKED","runId":"run-123","verdict":"PASS"}' });
  assert.throws(
    () => readSecurityJson(dir),
    (error) => error instanceof SidecarError && /duplicate key "verdict"/.test(error.message),
  );
});

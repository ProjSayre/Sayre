// PL-03h round 4 (architectural): the shared JSON-sidecar contract every pipeline stage writes
// alongside its human-facing markdown, and the ONLY thing scripts/build-ledger-index.mjs,
// scripts/check-red-integrity.mjs, and scripts/ledger-append.mjs read to make a control decision.
//
// Why this file exists (see .pipeline/review.md's round-3 "On convergence" section for the full
// argument this implements): three straight rounds of this ticket each closed one markdown-parsing
// exploit against extractSection (a fenced shadow, an HTML-comment shadow, a mid-line comment
// bypass) and each round's own fix, or the next attacker, found a new one — including a false PASS
// built from a setext heading and an ATX closing sequence, neither of which needed a fence or a
// comment at all. The defect was never any one regex. It is that a security gate was parsing a
// natural-language document whose ambiguity surface is unbounded by construction — enumerating an
// unbounded surface's bad shapes one round at a time cannot converge, the same failure mode PL-03a's
// Bash allowlist died from after four rounds.
//
// The fix is to stop asking a markdown parser to make the decision at all. Every field a control
// decision depends on (a verdict, a content hash, a file-path list, a spec-ID mapping) moves to a
// small JSON sidecar the owning stage writes next to its markdown. `JSON.parse` either succeeds or
// throws, so the *markdown-structural* ambiguity surface (a heading, a fence, an HTML comment, a
// setext heading, an ATX closing sequence — every construct the three prior rounds fought) is gone
// outright, not merely narrowed. What remains here is strict shape validation on top of that
// unambiguous parse: every required key must be present, every literal must be exactly one of its
// allowed values, every array must be an array. A sidecar that doesn't validate fails closed, by
// construction, the same way JSON.parse itself fails closed on truncated or invalid JSON.
//
// CORRECTED (PL-03h round 5 / review Critical 1): this file previously claimed "no ambiguity surface
// of any kind" and "no best-effort reading path anywhere in this file." Both were false. `JSON.parse`
// (and the JSON grammar itself, ECMA-404 / RFC 8259) permits an object to repeat the same key more
// than once and leaves the resolution parser-defined; V8 resolves to the LAST occurrence — the
// identical "last one wins" defect the markdown round's duplicate-heading exploit used, one layer
// down. `{"verdict":"NEEDS_FIXES","verdict":"PASS"}` parsed with plain `JSON.parse` reads as `PASS`.
// review.md's round-4 report reproduced this end to end against the real `ledger-append.mjs`: a
// durable `review: PASS` / `security: PASS` ledger entry for a run whose real, first-written verdict
// was `NEEDS_FIXES` / `BLOCKED`. `parseJsonOrThrow` below no longer delegates to the native
// `JSON.parse` — it runs `parseStrictJson`, a small recursive-descent parser that tracks the set of
// keys seen so far *within each individual object literal* and throws the moment a second occurrence
// of the same key appears in that same object, before the value is ever handed back to a caller. A
// `JSON.parse` *reviver* function cannot do this (verified while building this fix): the reviver is
// invoked once per key, with only the surviving (last) value — the shadowed occurrence is never
// passed to it at all, so there is nothing for a reviver to reject. Rejecting a duplicate key
// therefore requires an actual tokenizing pass over the raw text, not a callback bolted onto the
// engine's own parse.
//
// The honest, asymmetric reason a *strict parser* is achievable here and was not for markdown:
// JSON's grammar is closed and fully specified (ECMA-404 / RFC 8259) — every valid document has a
// finite, enumerable set of constructs (object, array, string, number, boolean, null), so "reject
// anything that isn't exactly one of those, with no duplicate object keys" is a decidable, total
// check. Markdown's ambiguity surface was unbounded by construction — headings, fences, HTML
// comments, setext underlines, ATX closers, and whatever the next round would have found, with no
// fixed grammar to close against. That is why three rounds of patching the markdown scanner each
// closed one exploit and left another open, while this file's JSON-only remaining ambiguity (the one
// case the grammar itself leaves parser-defined) is closed completely, in one pass, by one check.
// What THIS round removes, precisely: not "all ambiguity" — the *markdown-structural* class, in full,
// plus the one narrower JSON-native ambiguity (duplicate keys) the migration itself introduced by
// moving control decisions into JSON in the first place. See `parseStrictJson` below.
//
// What this file does NOT do, stated plainly rather than overclaimed (.pipeline/review.md's
// "Honest limits" framing): it does not verify that a stage told the truth. A review stage that
// writes `{ "verdict": "PASS" }` into review.json when the diff is actually broken still produces a
// PASS here — that is exactly the same trust already placed in every stage's own markdown report,
// unchanged by this contract. What this eliminates is a THIRD PARTY's ability to inject a false
// reading through document formatting, or through a duplicate-key resolution rule buried inside the
// parser, rather than through the stage's own (trusted) say-so — every one of review round 3's
// demonstrated markdown exploits, and review round 4's duplicate-key exploit, worked by exploiting
// the *parser*, not by lying in a field the parser read correctly.
//
// CORRECTED (round 6 / security SEC-10 and SC-12): this file's own header, and
// `scripts/pipeline-contracts.test.mjs`'s duplicate-key section, previously said the fix at
// `parseJsonOrThrow` meant "every caller inherits it automatically." That was false: it is only true
// of callers that actually call `parseJsonOrThrow` (or `readJsonSidecar`, which does). One real call
// site never became a caller — `scripts/ledger-append.mjs`'s `findCompletedSecurityRun` kept reading
// `security-history/<run-id>/manifest.json` and `results.json` with plain `JSON.parse`, one layer
// under `security.json` (which DID read through this file), which is exactly why the same
// duplicate-key forgery this round-5 fix was built to close still worked end to end against the
// immutable audit trail. Fixed by routing that call site (and `build-ledger-index.mjs`'s
// `readEntryJson`) through this file's `readJsonFile`/`readJsonSidecar`, same as everything else —
// see SEC-10 in `.pipeline/security-history/`. Separately, SC-12's benchmark found `parseString`
// below quadratic-ish at real-world adversarial string sizes; see that function's own comment and
// `readJsonFile`'s `MAX_JSON_FILE_BYTES` ceiling for the fix. Neither claim is restored to an
// absolute one here: "inherits it automatically" is true only of code that is actually a caller, and
// whether a given script IS a caller is exactly the kind of fact that must be checked per call site,
// not assumed from the existence of a shared primitive elsewhere in the file.
//
// ADDED (PL-04 round G2 / A2 — "artifacts carry no staleness signal"): every sidecar this file reads
// answers "what is the verdict/shape of this fact," never "is this fact still current." Observed live
// during this same fix round: `.pipeline/review.json` said `NEEDS_FIXES` and `.pipeline/security.json`
// said `BLOCKED`, both left over from a prior session, and nothing on either file marked them as
// stale — any consumer reading them had no way to tell "this is last night's failed run" from "this is
// the real, current state." That is a live correctness hazard, not a hypothetical one, and it is a
// different defect class from every "CORRECTED" note above: those were about a hostile or malformed
// *value* being read; this is about a genuine, honestly-written value that is simply no longer true of
// the tree it is being read against. The fix is an optional `stamp` field (see the "Freshness stamps"
// section below, after the shared validation primitives) every sidecar writer attaches at write time,
// plus one shared, exported function (`stampFreshness`) that is the single way any consumer asks
// whether a stamp is still current — never a bespoke comparison re-derived per call site, for the same
// "one implementation, not one per caller" reason this file already applies to JSON parsing itself.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PL-04 G2 / A2: `computeTreeHash`/`buildStamp`/`stampFreshness` (see the "Freshness stamps" section
// below, after the shared validation primitives) need to shell out to read-only `git` plumbing and
// resolve a sensible default `cwd` — the same `scriptsDir`/`repoRoot` convention every other script in
// this file's own call graph already uses (`ledger-append.mjs`, `build-ledger-index.mjs`).
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

/** Thrown by every validator in this file. A plain Error subclass (not a special control-flow
 * signal) — every caller catches it the same way it already catches any other unexpected error:
 * one clean, prefixed message and a non-zero exit, never a raw stack trace. */
export class SidecarError extends Error {}

function fail(message) {
  throw new SidecarError(message);
}

/** Refuses to read (let alone parse) a JSON file larger than this many bytes — see SC-12 (round 6,
 * the security-checker session that benchmarked `parseStrictJson` at real-world adversarial sizes):
 * `parseString` below used to accumulate a string value one character at a time (`out += ch`),
 * measured at roughly 250x slower than native `JSON.parse` at 80MB, with a super-linear (worse than
 * proportional) growth curve as size increased. `parseString` no longer does that — see its own
 * comment — which removes the super-linear blowup, but a real pipeline JSON artifact (a verdict, a
 * short file-path list, a handful of short text fields) is still always small. This ceiling exists to
 * bound the cost of a pathological file outright, not to accommodate any known legitimate shape, and
 * it is checked via `statSync` before the file is ever read into memory. */
export const MAX_JSON_FILE_BYTES = 10 * 1024 * 1024; // 10MB

/** Reads and strictly parses (see `parseJsonOrThrow`) the file at `path`, refusing anything over
 * `MAX_JSON_FILE_BYTES` first. Shared by every reader in this codebase that already knows the file
 * exists — `readJsonSidecar` below, and, after SEC-10, `scripts/ledger-append.mjs`'s
 * `findCompletedSecurityRun` (which reads `security-history/<run-id>/{manifest,results}.json`) and
 * `scripts/build-ledger-index.mjs`'s `readEntryJson` (which reads `.sdd/ledger/<run-id>/entry.json`)
 * — so the size ceiling and the "read or throw" shape are each defined exactly once, not
 * re-implemented per call site the way SEC-10's missing `parseJsonOrThrow` call was. Unlike
 * `readJsonSidecar`, this function does not treat a missing file as a legitimate `null` — every
 * current caller has already decided absence is an error before calling this. */
export function readJsonFile(path, label) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    fail(`${label}: could not be read (${error.message}).`);
  }
  if (stats.size > MAX_JSON_FILE_BYTES) {
    fail(
      `${label}: is ${stats.size} bytes, over this reader's ${MAX_JSON_FILE_BYTES}-byte ceiling (see ` +
      'SC-12) — refused before being read into memory or parsed. A pipeline JSON artifact is a small, ' +
      'structured document (a verdict, a short path list, a handful of short text fields); a file this ' +
      'large is refused outright, not merely parsed more cheaply than before.',
    );
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label}: could not be read (${error.message}).`);
  }
  return parseJsonOrThrow(raw, label);
}

/** Reads and JSON.parses `<dir>/<fileName>`. Returns `null` (not an error) only when the file does
 * not exist at all — every caller decides for itself whether absence is legitimate (see each
 * `read*Json` function's own `required` option). Any other failure (unreadable file, invalid JSON,
 * or over `MAX_JSON_FILE_BYTES`) always throws, regardless of `required` — a file that exists but
 * cannot be parsed (or is refused as oversized) is never treated as "absent." */
export function readJsonSidecar(dir, fileName, label) {
  const path = join(dir, fileName);
  if (!existsSync(path)) return null;
  return readJsonFile(path, label);
}

/** A strict, duplicate-key-rejecting JSON parser — see this file's header comment for why a plain
 * `JSON.parse` (or a `JSON.parse` reviver, which cannot see a shadowed duplicate at all) is not
 * enough. This is a small hand-rolled recursive-descent parser over the JSON grammar (ECMA-404 /
 * RFC 8259): object, array, string, number, `true`, `false`, `null`. It is deliberately NOT a
 * general-purpose JSON library — it exists to add exactly one check plain `JSON.parse` cannot
 * express (reject a repeated key within one object literal) while otherwise parsing every
 * syntactically valid document the same way `JSON.parse` would.
 *
 * Duplicate-key rejection is scoped to a single object literal, not to the document as a whole: the
 * same key name may appear once each in two different, unrelated objects (e.g. two different
 * `red.json` test entries both having a "path" field) without conflict — only a second occurrence of
 * the identical key *within the same `{...}`* is rejected, matching what "a duplicate heading" meant
 * in the markdown-era version of this same invariant (one document, one section, two competing
 * values for the same fact).
 *
 * `__proto__` is written via `Object.defineProperty` rather than plain assignment, so a JSON document
 * containing that key produces an ordinary own, enumerable property — never a prototype swap. Plain
 * `JSON.parse` already has this property; a hand-rolled parser needs to preserve it deliberately or
 * it would introduce a new class of bug this rewrite did not have before. */
function parseStrictJson(text) {
  const n = text.length;
  let i = 0;

  function syntaxError(message) {
    const consumed = text.slice(0, i);
    const line = consumed.split('\n').length;
    const column = i - consumed.lastIndexOf('\n');
    throw new Error(`${message} (at position ${i}, line ${line}, column ${column})`);
  }

  function skipWhitespace() {
    while (i < n) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++;
      else break;
    }
  }

  function setOwn(obj, key, value) {
    // Matches JSON.parse's own behavior: a "__proto__" key becomes a normal own property, never the
    // object's actual prototype. Every other key is a plain assignment.
    if (key === '__proto__') {
      Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = value;
    }
  }

  function parseValue() {
    skipWhitespace();
    if (i >= n) syntaxError('unexpected end of input');
    const ch = text[i];
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    syntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }

  function parseObject() {
    i++; // consume '{'
    const obj = {};
    const seenKeys = new Set();
    skipWhitespace();
    if (text[i] === '}') { i++; return obj; }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') syntaxError('expected a double-quoted key in object');
      const key = parseString();
      if (seenKeys.has(key)) {
        syntaxError(
          `duplicate key ${JSON.stringify(key)} in a JSON object — a well-formed JSON object may not ` +
          'repeat a key; the JSON grammar leaves resolution parser-defined (typically "last one wins," ' +
          'which is exactly the ambiguity this contract exists to close), so this parser refuses the ' +
          'document outright rather than silently picking a value',
        );
      }
      seenKeys.add(key);
      skipWhitespace();
      if (text[i] !== ':') syntaxError('expected ":" after object key');
      i++;
      const value = parseValue();
      setOwn(obj, key, value);
      skipWhitespace();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      syntaxError('expected "," or "}" in object');
    }
    return obj;
  }

  function parseArray() {
    i++; // consume '['
    const arr = [];
    skipWhitespace();
    if (text[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWhitespace();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      syntaxError('expected "," or "]" in array');
    }
    return arr;
  }

  /** SC-12 (round 6): this used to append one character at a time (`out += ch` on every iteration,
   * even for the common case of a long run of plain, unescaped characters), which is quadratic-ish
   * in V8 at real-world sizes — measured ~250x slower than native `JSON.parse` and super-linear
   * (a roughly 4x time increase for a 2x size increase at 40MB -> 80MB) on an 80MB single-string
   * value, entirely inside this function. Fixed by tracking `runStart`, the index where the current
   * contiguous run of unescaped characters began, and appending that whole run in one `text.slice(...)`
   * call only when the run ends (at a closing quote or an escape sequence) — one slice per escape
   * (or one, for a string with none), never one append per character. This is the same value for the
   * same input, just accumulated in O(runs) string operations instead of O(characters). */
  function parseString() {
    i++; // consume opening quote
    let out = '';
    let runStart = i;
    for (;;) {
      if (i >= n) syntaxError('unterminated string');
      const ch = text[i];
      if (ch === '"') {
        out += text.slice(runStart, i);
        i++;
        break;
      }
      if (ch === '\\') {
        out += text.slice(runStart, i);
        i++;
        const esc = text[i];
        switch (esc) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) syntaxError('invalid \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            syntaxError(`invalid escape character "\\${esc}"`);
        }
        i++;
        runStart = i;
      } else if (ch.charCodeAt(0) < 0x20) {
        syntaxError('unescaped control character in string');
      } else {
        i++;
      }
    }
    return out;
  }

  function parseNumber() {
    const start = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') {
      i++;
    } else if (text[i] >= '1' && text[i] <= '9') {
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    } else {
      syntaxError('invalid number');
    }
    if (text[i] === '.') {
      i++;
      if (!(text[i] >= '0' && text[i] <= '9')) syntaxError('invalid number (no digits after decimal point)');
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!(text[i] >= '0' && text[i] <= '9')) syntaxError('invalid number (no digits in exponent)');
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    return Number(text.slice(start, i));
  }

  const value = parseValue();
  skipWhitespace();
  if (i < n) syntaxError('unexpected trailing content after JSON value');
  return value;
}

/** Parses `raw` with the strict, duplicate-key-rejecting parser above, wrapped so every caller in
 * this codebase reports the same failure shape. Exported so scripts/build-ledger-index.mjs can apply
 * it to `entry.json` (a ledger-internal sidecar, not one of the five `.pipeline/` contracts below,
 * but held to the identical "parse or throw, then validate strictly" standard — see that file). */
export function parseJsonOrThrow(raw, label) {
  try {
    return parseStrictJson(raw);
  } catch (error) {
    fail(
      `${label} is not valid JSON (${error.message}). This parser either succeeds or throws — this ` +
      'file must be regenerated by the stage that owns it, never hand-patched into a "close enough" shape.',
    );
  }
}

// --- Shared validation primitives -----------------------------------------------------------------
//
// Every sidecar reader below is built from exactly these four checks. One shared set, not one
// independently-written check per field per file — the PL-03c round-4 Critical 1 lesson (a
// heading counter and a heading extractor silently drifting apart) applies just as much to two
// JSON validators quietly disagreeing about what "a non-empty string" means as it did to two regexes.

export function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}: must be a JSON object at the top level.`);
  }
  return value;
}

export function requireString(value, label, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label}: field "${field}" must be a non-empty string — got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function requireArray(value, label, field) {
  if (!Array.isArray(value)) {
    fail(`${label}: field "${field}" must be an array — got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function requireBoolean(value, label, field) {
  if (typeof value !== 'boolean') {
    fail(`${label}: field "${field}" must be a boolean (true or false) — got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function requireEnum(value, label, field, allowed) {
  if (!allowed.includes(value)) {
    fail(`${label}: field "${field}" must be exactly one of ${allowed.map((v) => JSON.stringify(v)).join(' | ')} — got ${JSON.stringify(value)}.`);
  }
  return value;
}

export const SPEC_ID_PATTERN = /^(?:AC|EC)-\d+[a-z]?$/;

function requireSpecId(value, label, field) {
  requireString(value, label, field);
  if (!SPEC_ID_PATTERN.test(value)) {
    fail(`${label}: field "${field}" ("${value}") does not match the required AC-n / EC-n shape.`);
  }
  return value;
}

// --- Freshness stamps (PL-04 / A2) ------------------------------------------------------------------
//
// Every sidecar this file reads is a snapshot a stage wrote at some point — with no signal, until
// now, distinguishing "written a moment ago, describes the tree as it is right now" from "written
// last night, describes a tree that no longer exists." Observed live during this same fix round:
// `.pipeline/review.json` said `NEEDS_FIXES` and `.pipeline/security.json` said `BLOCKED`, both stale
// leftovers, and every consumer of either file had no way to tell.
//
// CORRECTED (PL-04 review pass 1 / Blocker 1 / C1): this section originally shipped with this file
// exporting `buildStamp`/`stampFreshness` and the comment below promising "a separate stage-side
// change targets this exact shape" — but nothing ever called `buildStamp` outside a test, no stage's
// own "Exact shape" output contract mentioned `stamp` at all, and `security.md`'s "refuse on a stale
// `review.json`" promise could therefore never fire. Two groups each built one half (this file's
// reader/comparator, `.sdd/**`'s consumption policy) and each assumed the other had built the
// producer. Fixed: `scripts/write-stamp.mjs` is that producer — every stage that writes one of the
// five sidecars below runs it, as the last step for that file, right after writing every other field
// (see each `.sdd/stages/*.md` file's own numbered procedure) — and `scripts/check-stamp-freshness.mjs`
// is the committed consumer every stage's own "Staleness of required inputs" section now names by
// exact command, so "flag on stale" and "refuse on stale" are both real, testable exit codes rather
// than prose asserting a policy. See both scripts' own headers for why each is a committed script
// (an agent cannot reproduce a SHA-256 working-tree hash, or compare one against the tree "right now,"
// by reading or writing a file) rather than an instruction telling a stage to do the equivalent by hand.
//
// The contract every sidecar writer attaches, unvaried across all five `.pipeline/*.json` files:
//
//   "stamp": { "treeHash": "...", "headSha": "...", "dirty": true, "writtenAt": "2026-08-04T..." }
//
// `treeHash` (see `computeTreeHash` below) reflects the *working tree*, including uncommitted state —
// deliberately not `headSha` alone, because a stamp that only tracked `HEAD` would already be stale
// the instant a stage's own uncommitted edits changed anything, which is the entire window every
// pipeline stage actually runs inside. `headSha`/`dirty`/`writtenAt` are recorded for a human reading
// the sidecar; `stampFreshness` below never inspects them — see that function's own comment for why
// the freshness check is one hash comparison, not a multi-field judgment call.
//
// `stamp` is optional on every read* function below: an artifact written before this contract existed
// (every sidecar on disk as of this round) or by a stage that never attaches one has no "stamp" key at
// all, and must keep parsing exactly as it did before — see `STAMP_UNKNOWN` for why "no stamp" and
// "fresh" must never collapse into the same answer. A `stamp` key that IS present is held to this
// file's usual "parse strictly or fail closed" standard: a half-shaped stamp is worse than a missing
// one, since it would otherwise let a consumer compare a real hash against a placeholder and call the
// result meaningful.
//
// CORRECTED (PL-04 review pass 3 / Warning 1a): `readStamp` — and every caller that reads its result as
// a signal of *provenance* (`scripts/ledger-append.mjs`'s `--re-gate` stamp-presence check chief among
// them) — must not claim more than this function actually checks. `readStamp` validates SHAPE: four
// required fields, `dirty` a boolean, `writtenAt` a non-empty string, and, as of this fix, `treeHash`/
// `headSha` matching the hex pattern `buildStamp()` always produces (64 / 40 lowercase hex characters,
// `headSha` alternatively the literal `"(none)"` fallback for a repo with no `HEAD` yet). None of that is
// authentication: these are four unauthenticated JSON fields with no signature and no secret behind
// them, so a hand-written `stamp` object of the right shape (correct field names, correct types, hex
// strings of the correct length) satisfies every check below exactly as well as one `write-stamp.mjs`
// actually produced. The hex-format check added by this fix rejects a stamp that is obviously not
// shaped like `buildStamp()`'s own output (e.g. a `treeHash` that is the string `"unknown"`, or a
// `headSha` copy-pasted from somewhere else at the wrong length) — it does not, and cannot, distinguish
// a hand-crafted-but-correctly-shaped stamp from a genuine one. Building an actual provenance guarantee
// (a signature, a MAC, anything requiring a secret only `write-stamp.mjs` holds) is out of scope here —
// see `readStamp`'s own doc comment below for the exact line this function does and does not cross.

export const STAMP_FRESH = 'fresh';
export const STAMP_STALE = 'stale';
export const STAMP_UNKNOWN = 'unknown';

/** Validates an optional `stamp` field, shared by every read*Json function below. Returns `null`
 * (never throws) when `raw` is `undefined`/`null` — the back-compat path every existing sidecar on
 * disk needs. When `raw` IS present it must be the complete `{ treeHash, headSha, dirty, writtenAt }`
 * shape or this fails closed exactly like any other malformed field in this file.
 *
 * CORRECTED (PL-04 review pass 3 / Warning 1a): `treeHash`/`headSha` are now also checked against the
 * hex pattern `buildStamp()` always produces (the same `/^[0-9a-f]{64}$/i` shape `validateRedTest`
 * already applies to `sha256` above, applied here to the other two hash-shaped fields in this file).
 * State this precisely, because it is easy to overstate: this is a SHAPE check, not a provenance one.
 * It rejects a `treeHash`/`headSha` that could not possibly be `buildStamp()`'s output (wrong length, a
 * non-hex character, a placeholder string) — it does not, and structurally cannot, prove the value was
 * actually produced by `write-stamp.mjs` on a real tree, since a hand-written stamp using the right
 * field names, types, and hex lengths (e.g. `"0".repeat(64)` for `treeHash`) satisfies this check
 * exactly as well as a genuine one. Presence-plus-shape is a hygiene gate — it catches the leftover,
 * pre-contract sidecar with no `stamp` key at all, and a stamp object with an obviously wrong shape —
 * never an authentication mechanism. See this section's header comment for the fuller reasoning, and
 * `ledger-append.mjs`'s own `--re-gate` stamp check for the one caller this distinction matters most
 * to. */
function readStamp(raw, label) {
  if (raw === undefined || raw === null) return null;
  const stampLabel = `${label}: stamp`;
  requireObject(raw, stampLabel);
  const treeHash = requireString(raw.treeHash, stampLabel, 'treeHash');
  if (!/^[0-9a-f]{64}$/i.test(treeHash)) {
    fail(`${stampLabel}: field "treeHash" must be a 64-character hex digest (the shape computeTreeHash() always produces) — got ${JSON.stringify(treeHash)}. This is a shape check, not proof of provenance — see this function's own doc comment.`);
  }
  const headSha = requireString(raw.headSha, stampLabel, 'headSha');
  if (headSha !== '(none)' && !/^[0-9a-f]{40}$/i.test(headSha)) {
    fail(`${stampLabel}: field "headSha" must be a 40-character hex digest (a full "git rev-parse HEAD") or the literal "(none)" (buildStamp()'s own no-HEAD fallback) — got ${JSON.stringify(headSha)}.`);
  }
  const dirty = requireBoolean(raw.dirty, stampLabel, 'dirty');
  const writtenAt = requireString(raw.writtenAt, stampLabel, 'writtenAt');
  return { treeHash: treeHash.toLowerCase(), headSha: headSha === '(none)' ? headSha : headSha.toLowerCase(), dirty, writtenAt };
}

/** Runs one read-only `git` plumbing command at `cwd`, returning `''` (never throwing) on any failure
 * — not a git repository, no `HEAD` yet, or `git` unavailable. Every caller below already tolerates an
 * empty result the same way `ledger-append.mjs`'s own `currentCommitInfo`/`filesTouched` tolerate a
 * `git` failure: fall through rather than throw, so a stamp can still be produced (if a degraded one)
 * in an environment without git. Every argument list passed through this function is read-only by
 * construction (`rev-parse`, `diff`, `ls-files`, `status --porcelain`) — nothing here ever runs `git
 * add`, `git commit`, `git stash`, or any other command that writes to the index, a ref, or the
 * working tree, because this is called mid-run, potentially by more than one pipeline stage reading
 * or writing inside the same working tree at once, and a staleness check must never itself perturb
 * the very state it exists to observe. */
function gitOutput(cwd, args) {
  try {
    // `stdio: [ignore, pipe, ignore]` — stdout is still captured (the `encoding: 'utf8'` return
    // value every caller wants), but stderr is discarded rather than inherited: a failure here (no
    // git repo, no HEAD yet, git unavailable) is an expected, silently-tolerated path (see this
    // function's own comment below), not something that should print git's own usage/error text to
    // whatever is running the calling stage or test.
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Computes a SHA-256 hex digest of the current *working tree* state at `cwd` — see this section's
 * header for why this, not `git rev-parse HEAD` alone, is what `treeHash` must be. Built entirely from
 * the read-only commands `gitOutput` runs (`git diff HEAD` for every tracked change, staged or not;
 * `git ls-files --others --exclude-standard` for untracked paths) plus reading each untracked file's
 * own bytes directly off disk — see `gitOutput`'s own comment for why nothing here ever mutates git
 * state.
 *
 * Honest limits, stated plainly rather than overclaimed: this hashes the tracked diff-from-HEAD plus
 * untracked file contents, not a canonical hash of the tree's full content the way `git write-tree`
 * would produce after staging everything — two different (headSha, diff) pairs that happen to
 * describe identical final file contents could, in principle, still hash differently by construction
 * of this algorithm. And if `git` is unavailable, or `cwd` is not inside a git repository at all,
 * every command below fails the same way regardless of what is actually on disk, collapsing to a
 * constant value. Both are accepted here: this exists to catch the ordinary "the tree moved on since
 * this sidecar was written" case `stampFreshness` is built for, not to be a cryptographic guarantee in
 * a git-unavailable environment — the same "bound the real case, do not over-promise for the
 * pathological one" reasoning `MAX_JSON_FILE_BYTES` already applies elsewhere in this file. */
export function computeTreeHash(cwd = repoRoot) {
  const hash = createHash('sha256');
  hash.update('head:');
  hash.update(gitOutput(cwd, ['rev-parse', 'HEAD']).trim());
  hash.update('\ndiff:');
  hash.update(gitOutput(cwd, ['diff', 'HEAD']));
  const untracked = gitOutput(cwd, ['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  for (const file of untracked) {
    hash.update(`\nuntracked:${file}:`);
    try {
      hash.update(readFileSync(join(cwd, file)));
    } catch {
      hash.update('(unreadable)');
    }
  }
  return hash.digest('hex');
}

/** Builds the exact `stamp` shape this section's header documents, ready for a stage script to attach
 * to its own sidecar object at write time. `writtenAt` is wall-clock "now" — git has no notion of
 * "when was this JSON file written," so unlike the other three fields it is never derived from git. */
export function buildStamp(cwd = repoRoot) {
  return {
    treeHash: computeTreeHash(cwd),
    headSha: gitOutput(cwd, ['rev-parse', 'HEAD']).trim() || '(none)',
    dirty: gitOutput(cwd, ['status', '--porcelain']).trim().length > 0,
    writtenAt: new Date().toISOString(),
  };
}

/** The one, single way any consumer in this codebase asks "is this artifact stale relative to the
 * current tree?" (A2) — every caller asks this one question one way, rather than each re-deriving its
 * own comparison against a stamp it read itself. Returns exactly one of three literal strings, never a
 * boolean: a missing `stamp` (an artifact written before this contract existed, or a stage that never
 * attached one) is a THIRD, distinct state from "fresh" and from "stale," never a default-to-fresh —
 * treating "no stamp" as "fresh" would silently let exactly the artifacts this fix exists to catch
 * (last night's real `NEEDS_FIXES`/`BLOCKED`, sitting untouched with no signal at all) read as
 * trustworthy, which inverts the failure this ticket item is about.
 *
 * This is a hash comparison, deliberately not a judgment call: `stamp.treeHash` (recorded at write
 * time) is compared for exact string equality against `computeTreeHash(cwd)` (computed right now).
 * `headSha`/`dirty`/`writtenAt` are metadata for a human reading the sidecar, never inputs to this
 * decision — reasoning like "well, headSha only changed because of an unrelated commit" is exactly the
 * kind of judgment call this function exists to refuse to make; keep this a hash comparison. */
export function stampFreshness(stamp, cwd = repoRoot) {
  if (!stamp) return STAMP_UNKNOWN;
  return stamp.treeHash === computeTreeHash(cwd) ? STAMP_FRESH : STAMP_STALE;
}

// --- .pipeline/spec.json — written by planner -------------------------------------------------------
//
// { ticket, goal, acceptanceCriteria: [{ id, text }], edgeCases: [{ id, text }] }
//
// `ticket` is the full ticket title exactly as it appears on spec.md's `# ` line (e.g. "PL-03h —
// Fence/comment-aware markdown parsing for the ledger + spec-trace/hash checks"), authored directly
// by planner as a plain string field — never derived by regexing spec.md's title line at read time.
// That is a deliberate, narrow difference from every other field here: a ticket ID used only for
// display (index.json's "ticket" column, entry.md's "Ticket" section) is not a control decision, but
// sourcing it from a JSON string field rather than from markdown structure means NOTHING in this
// codebase's control or display path ever runs a heading/fence/comment-aware parse again, not even
// for a cosmetic field — see scripts/ledger-append.mjs's `extractTicketId`, which regexes this
// already-authoritative string, not spec.md's raw text.

function validateSpecIdItem(item, label, field, index) {
  const itemLabel = `${label}: ${field}[${index}]`;
  requireObject(item, itemLabel);
  const id = requireSpecId(item.id, itemLabel, 'id');
  const text = requireString(item.text, itemLabel, 'text');
  return { id, text };
}

function assertNoDuplicateIds(items, label, fields) {
  const seen = new Map();
  for (const item of items) {
    if (seen.has(item.id)) {
      fail(`${label}: id "${item.id}" appears more than once across ${fields.join('/')} — every AC-*/EC-* id must be unique.`);
    }
    seen.set(item.id, true);
  }
}

export function readSpecJson(pipelineDir, { required = true } = {}) {
  const label = '.pipeline/spec.json';
  const raw = readJsonSidecar(pipelineDir, 'spec.json', label);
  if (raw === null) {
    if (required) fail(`${label} does not exist. planner must write it alongside spec.md — see .sdd/stages/planner.md.`);
    return null;
  }
  requireObject(raw, label);
  const ticket = requireString(raw.ticket, label, 'ticket');
  const goal = requireString(raw.goal, label, 'goal');
  const acceptanceCriteria = requireArray(raw.acceptanceCriteria, label, 'acceptanceCriteria')
    .map((item, i) => validateSpecIdItem(item, label, 'acceptanceCriteria', i));
  const edgeCases = requireArray(raw.edgeCases, label, 'edgeCases')
    .map((item, i) => validateSpecIdItem(item, label, 'edgeCases', i));
  assertNoDuplicateIds([...acceptanceCriteria, ...edgeCases], label, ['acceptanceCriteria', 'edgeCases']);
  // `lane` (PL-03e — see .sdd/stages/planner.md and .github/ISSUE_TEMPLATE/pipeline-ticket.yml) is
  // optional and defaults to null, unlike every other field on this object: it did not exist before
  // this wiring pass, and every spec.json already on disk (including the PL-03a ledger entry backfilled
  // by hand years before this field was designed) has no "lane" key at all and must keep parsing
  // exactly as it did before. A ticket with no declared lane is a real, expected state (bounds is then
  // reported unverified downstream — see .sdd/stages/pr-review.md) rather than a malformed document,
  // so this is a lenient optional read, not a `requireString`-with-a-null-fallback.
  const lane = raw.lane === undefined || raw.lane === null ? null : requireString(raw.lane, label, 'lane');
  const stamp = readStamp(raw.stamp, label); // PL-04 / A2 — optional, null when absent (back-compat)
  return { ticket, goal, acceptanceCriteria, edgeCases, lane, stamp };
}

/** Every AC-n/EC-n id spec.json declares as real — the set an `@spec` marker must resolve against.
 * Replaces check-red-integrity.mjs's old `extractKnownSpecIds`, which had to strip fenced/commented
 * lines out of spec.md's raw prose before grepping it for AC-n/EC-n tokens, precisely because a
 * fenced illustrative example of the marker format (spec.md routinely shows one) could otherwise
 * launder as a real, resolvable id. `spec.json`'s `acceptanceCriteria`/`edgeCases` arrays have no
 * such surface at all: an id is either a declared `{id, text}` item or it doesn't exist in this
 * document — there is no "an id-shaped token appeared somewhere in the section's text" to launder. */
export function knownSpecIds(specJson) {
  return new Set([...specJson.acceptanceCriteria, ...specJson.edgeCases].map((item) => item.id));
}

// --- .pipeline/red.json — written by red ------------------------------------------------------------
//
// { impactMapPresent: boolean, tests: [{ path, sha256, specIds: [...], classification }] }
//
// `classification` is restricted to exactly "RED-CORRECT" | "RED-DEFERRED" by this validator — there
// is no third literal to check for and reject, because "RED-BROKEN" (the state .sdd/stages/red.md
// says may never appear in a finished red.md) simply isn't in the allowed set. The old markdown
// script had to separately grep the whole document for the literal substring "RED-BROKEN" appearing
// anywhere; that check has no JSON equivalent because there is nothing left for it to catch — an
// invalid classification value fails to parse at all, before any caller-level check would run.
//
// Likewise, `impactMapPresent` being a required boolean means "state the impact map's presence or
// absence explicitly, never leave it blank" (.sdd/stages/red.md's own requirement) is enforced by
// the type system here, not by a separate "is this section non-empty" check: there is no way to
// omit a required boolean field, or set it to something that is neither `true` nor `false`, and have
// this validator accept it.

const RED_CLASSIFICATIONS = ['RED-CORRECT', 'RED-DEFERRED'];

function validateRedTest(item, label, index) {
  const itemLabel = `${label}: tests[${index}]`;
  requireObject(item, itemLabel);
  const path = requireString(item.path, itemLabel, 'path');
  const sha256 = requireString(item.sha256, itemLabel, 'sha256');
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    fail(`${itemLabel}: field "sha256" must be a 64-character hex digest — got ${JSON.stringify(sha256)}.`);
  }
  const specIds = requireArray(item.specIds, itemLabel, 'specIds')
    .map((id, j) => requireSpecId(id, itemLabel, `specIds[${j}]`));
  const classification = requireEnum(item.classification, itemLabel, 'classification', RED_CLASSIFICATIONS);
  return { path, sha256: sha256.toLowerCase(), specIds, classification };
}

export function readRedJson(pipelineDir, { required = false } = {}) {
  const label = '.pipeline/red.json';
  const raw = readJsonSidecar(pipelineDir, 'red.json', label);
  if (raw === null) {
    if (required) fail(`${label} does not exist.`);
    return null;
  }
  requireObject(raw, label);
  const impactMapPresent = requireBoolean(raw.impactMapPresent, label, 'impactMapPresent');
  const tests = requireArray(raw.tests, label, 'tests').map((item, i) => validateRedTest(item, label, i));
  // The direct JSON analog of extractSection's old "fail closed on a genuine duplicate heading"
  // invariant: red.md's "## Test paths"/"## Content hashes"/"## @spec mapping" used to be three
  // independently-parsed lists an appended, duplicate section could make disagree with each other.
  // red.json's `tests` array bundles path/sha256/specIds/classification into one object per test, so
  // there is no second list left to disagree — but two *entries* sharing the same `path` would still
  // be exactly that ambiguity restated one level down (which entry's hash governs the rehash check?
  // which entry's specIds govern the spec-trace check?). Refused outright rather than silently
  // checking both.
  const seenPaths = new Map();
  for (const test of tests) {
    if (seenPaths.has(test.path)) fail(`${label}: "tests" lists "${test.path}" more than once — every test path must be unique.`);
    seenPaths.set(test.path, true);
  }
  const stamp = readStamp(raw.stamp, label); // PL-04 / A2 — optional, null when absent (back-compat)
  return { impactMapPresent, tests, stamp };
}

// --- .pipeline/changes.json — written by dev --------------------------------------------------------
//
// { filesChanged: [...], redTestChanges: [{ path, reason }] }
//
// `redTestChanges` replaces check-red-integrity.mjs's old `isDeclaredInChanges`/
// `parseDeclaredRedTestChangePaths`, which had to parse "## Red-test changes"'s bullet-list shape
// (a path is declared only when it is the backtick-quoted subject of its own `- \`path\` — reason`
// entry) and, before that fix, was a raw substring match an adversarial denial sentence could
// satisfy. Checking whether a path is declared is now `redTestChanges.some(rtc => rtc.path === path)`
// — exact equality against an already-structured array, with no bullet-list grammar, no fenced
// example to launder through, and no prose to misread as a declaration or a denial.

function validateRedTestChange(item, label, index) {
  const itemLabel = `${label}: redTestChanges[${index}]`;
  requireObject(item, itemLabel);
  const path = requireString(item.path, itemLabel, 'path');
  const reason = requireString(item.reason, itemLabel, 'reason');
  return { path, reason };
}

export function readChangesJson(pipelineDir, { required = false } = {}) {
  const label = '.pipeline/changes.json';
  const raw = readJsonSidecar(pipelineDir, 'changes.json', label);
  if (raw === null) {
    if (required) fail(`${label} does not exist.`);
    return null;
  }
  requireObject(raw, label);
  const filesChanged = requireArray(raw.filesChanged, label, 'filesChanged')
    .map((item, i) => requireString(item, label, `filesChanged[${i}]`));
  const redTestChanges = requireArray(raw.redTestChanges, label, 'redTestChanges')
    .map((item, i) => validateRedTestChange(item, label, i));
  const stamp = readStamp(raw.stamp, label); // PL-04 / A2 — optional, null when absent (back-compat)
  return { filesChanged, redTestChanges, stamp };
}

/** True only when `path` is the exact `path` field of one of `changesJson.redTestChanges`'s own
 * entries — never a substring/prose match. `changesJson` may be `null` (no changes.json for this
 * run), in which case nothing is ever declared. */
export function isDeclaredInChanges(changesJson, path) {
  if (!changesJson) return false;
  return changesJson.redTestChanges.some((entry) => entry.path === path);
}

// --- .pipeline/review.json — written by review ------------------------------------------------------
//
// { verdict: "PASS" | "NEEDS_FIXES", stamp? }
//
// Replaces `extractVerdict`'s markdown parse of review.md's "## Verdict" section — the exact site of
// every demonstrated exploit across all three prior rounds (a fenced shadow, a comment shadow, a
// mid-line comment bypass, a genuine duplicate heading, an ATX closing sequence, a setext heading).
// `{"verdict": "PASS"}` has none of those constructs to exploit: there is exactly one value, and it
// is either the literal string "PASS", the literal string "NEEDS_FIXES", or the read fails closed.
//
// `stamp` (PL-04 / A2) is optional — see the "Freshness stamps" section above. This is one of the two
// sidecars the A2 fix round found sitting stale, unmarked, on disk (`.pipeline/review.json` read
// `NEEDS_FIXES` from a prior session with nothing to say so); callers that care whether this verdict
// is still current should pass the returned `stamp` through `stampFreshness`, never re-derive their
// own comparison.

export function readReviewJson(pipelineDir, { required = true } = {}) {
  const label = '.pipeline/review.json';
  const raw = readJsonSidecar(pipelineDir, 'review.json', label);
  if (raw === null) {
    if (required) fail(`${label} does not exist. review must write it alongside review.md — see .sdd/stages/review.md.`);
    return null;
  }
  requireObject(raw, label);
  const verdict = requireEnum(raw.verdict, label, 'verdict', ['PASS', 'NEEDS_FIXES']);
  const stamp = readStamp(raw.stamp, label);
  return { verdict, stamp };
}

// --- .pipeline/security.json — written by security-checker --------------------------------------------
//
// { verdict: "PASS" | "BLOCKED", runId, stamp? }
//
// `runId` is always required (even for a BLOCKED verdict) because .sdd/stages/security.md's Required
// artifacts section always creates `.pipeline/security-history/<run-id>/`, win or lose — there is
// always a run id to cite. ledger-append.mjs uses this field directly to locate the completed
// security run, replacing the old `parseCitedRunId`/`isBaselineOnlyMention`/substring-scan fallback
// chain entirely: that chain existed only to recover a run id from prose when a structured field was
// absent or malformed, a problem that cannot occur once the field is a required, strictly-typed JSON
// string.
//
// `stamp` (PL-04 / A2) is optional — see the "Freshness stamps" section above. This is the other of
// the two sidecars the A2 fix round found stale on disk (`.pipeline/security.json` read `BLOCKED`
// from a prior run, also unmarked); same guidance as `readReviewJson` above.

export function readSecurityJson(pipelineDir, { required = true } = {}) {
  const label = '.pipeline/security.json';
  const raw = readJsonSidecar(pipelineDir, 'security.json', label);
  if (raw === null) {
    if (required) fail(`${label} does not exist. security-checker must write it alongside security-report.md — see .sdd/stages/security.md.`);
    return null;
  }
  requireObject(raw, label);
  const verdict = requireEnum(raw.verdict, label, 'verdict', ['PASS', 'BLOCKED']);
  const runId = requireString(raw.runId, label, 'runId');
  const stamp = readStamp(raw.stamp, label);
  return { verdict, runId, stamp };
}

// --- .pipeline/gaps.json — written by gap-scout (/pipeline-gapfill) ---------------------------------
//
// { ticket, overlays, securityRequired, auditFirst?, verdict, items: [...], stamp? }
//
// Control decisions on the gapfill lane (continue vs stop vs escalate; ledger --gapfill) read only
// this file, never gaps.md prose.

export const GAP_ID_PATTERN = /^GAP-\d+[a-z]?$/;
export const GAP_STATUSES = [
  'OK',
  'MISSING',
  'STUBBED',
  'MOCKED',
  'HARDCODED',
  'TODO',
  'NARROWED',
  'UNTESTED',
];
export const GAP_VERDICTS = ['GAPFILL', 'ALREADY_COMPLETE', 'ESCALATE_FULL_PIPELINE'];

export function readGapsJson(pipelineDir, { required = true } = {}) {
  const label = '.pipeline/gaps.json';
  const raw = readJsonSidecar(pipelineDir, 'gaps.json', label);
  if (raw === null) {
    if (required) {
      fail(
        `${label} does not exist. gap-scout must write it alongside gaps.md before the gapfill lane ` +
        'continues — see .sdd/stages/gap-scout.md.',
      );
    }
    return null;
  }
  requireObject(raw, label);
  const ticket = requireString(raw.ticket, label, 'ticket');
  const overlays = requireArray(raw.overlays, label, 'overlays').map((item, i) =>
    requireString(item, label, `overlays[${i}]`),
  );
  if (typeof raw.securityRequired !== 'boolean') {
    fail(`${label}: field "securityRequired" must be a boolean — got ${JSON.stringify(raw.securityRequired)}.`);
  }
  const auditFirst = raw.auditFirst === undefined ? false : raw.auditFirst === true;
  if (raw.auditFirst !== undefined && typeof raw.auditFirst !== 'boolean') {
    fail(`${label}: field "auditFirst" must be a boolean when present — got ${JSON.stringify(raw.auditFirst)}.`);
  }
  const verdict = requireEnum(raw.verdict, label, 'verdict', GAP_VERDICTS);
  const items = requireArray(raw.items, label, 'items');
  const seenIds = new Set();
  const normalizedItems = items.map((item, i) => {
    const itemLabel = `${label}: items[${i}]`;
    requireObject(item, itemLabel);
    const id = requireString(item.id, itemLabel, 'id');
    if (!GAP_ID_PATTERN.test(id)) {
      fail(`${itemLabel}: field "id" must match ${GAP_ID_PATTERN} — got ${JSON.stringify(id)}.`);
    }
    if (seenIds.has(id)) fail(`${itemLabel}: duplicate gap id ${JSON.stringify(id)}.`);
    seenIds.add(id);
    const status = requireEnum(item.status, itemLabel, 'status', GAP_STATUSES);
    const source = requireString(item.source, itemLabel, 'source');
    const evidence = requireArray(item.evidence, itemLabel, 'evidence').map((ev, j) =>
      requireString(ev, itemLabel, `evidence[${j}]`),
    );
    if (typeof item.needsTest !== 'boolean') {
      fail(`${itemLabel}: field "needsTest" must be a boolean — got ${JSON.stringify(item.needsTest)}.`);
    }
    return { id, status, source, evidence, needsTest: item.needsTest };
  });
  if (verdict === 'GAPFILL') {
    const open = normalizedItems.filter((item) => item.status !== 'OK');
    if (open.length === 0) {
      fail(
        `${label}: verdict is "GAPFILL" but every item is "OK" — use "ALREADY_COMPLETE" instead, or ` +
        'list at least one non-OK gap.',
      );
    }
  }
  if (verdict === 'ALREADY_COMPLETE') {
    const open = normalizedItems.filter((item) => item.status !== 'OK');
    if (open.length > 0) {
      fail(
        `${label}: verdict is "ALREADY_COMPLETE" but items ${open.map((i) => i.id).join(', ')} are not ` +
        '"OK" — fix the statuses or use "GAPFILL"/"ESCALATE_FULL_PIPELINE".',
      );
    }
  }
  const stamp = readStamp(raw.stamp, label);
  return {
    ticket,
    overlays,
    securityRequired: raw.securityRequired,
    auditFirst,
    verdict,
    items: normalizedItems,
    stamp,
  };
}

// Regenerates .sdd/ledger/index.json from every .sdd/ledger/<run-id>/entry.json on disk (PL-03c;
// re-pointed from entry.md to entry.json by PL-03h round 4 — see the file header note below).
//
// Usage:
//   node scripts/build-ledger-index.mjs            # writes .sdd/ledger/index.json
//   node scripts/build-ledger-index.mjs --check    # exit 1 + diff if index.json is stale
//
// index.json maps a repo-relative file path to every ledger run that touched it:
//   { "services/core/src/graph-query/index.ts": [ { runId, ticket, date, spec, regate? }, ... ] }
// This is the file-granularity query path spec.md describes: buggy file -> index.json -> the
// spec(s) that mandated it (the same shape as generate-agent-shims.mjs's --check contract — never
// hand-edit index.json, regenerate it and commit the result).
//
// PL-04 / item 3: `regate` is present only on a record produced by a `--re-gate` run (see
// scripts/ledger-append.mjs and .sdd/ledger/README.md's "Re-gate entries" section) — `{ testerRan:
// true | false }`. A re-gate entry is never excluded from this index the way a `bypass: true` entry
// is (the spec really was ratified against the re-gated tree — see readEntryJson's own comment
// below), but until this fix the qualification itself never reached index.json: entry.json's
// `regate` object was written and even documented as reaching this file, yet buildIndex() below
// never read it, so the fast query path (buggy file -> index.json -> spec) surfaced a clean-looking
// attribution indistinguishable from a run that actually passed through dev's own loop — the exact
// laundering `/re-gate` exists to make impossible, just relocated one hop downstream of entry.json.
// Fixed by carrying the one fact that matters (whether tester ran on the re-gated tree) into each
// index record it applies to, deliberately not the whole `regate` object (no `gatesOnly`, no `note`)
// — this is a query index, not a record; a reader who wants the full disclosure text still follows
// `spec`'s sibling `entry.json`. Absent entirely (not `null`) on an ordinary run's records, so this
// index's per-run byte cost only grows for the runs the marker actually applies to.
//
// PL-03h round 4 (architectural — see .pipeline/review.md's round-3 "On convergence" section and
// scripts/pipeline-contracts.mjs's own header for the full argument): this file used to parse
// entry.md with a hand-rolled markdown block scanner (`scanBlockState`/`extractSection`), tracking
// fenced-code-block and HTML-comment state so a heading fabricated inside either couldn't shadow the
// real one. Three rounds of that approach each closed one exploit and produced (or left open)
// another — a false `review: PASS` ledger entry built from a fenced shadow, a comment shadow, a
// mid-line comment bypass, an ATX closing sequence, and a setext heading, the last two needing no
// fence or comment at all. The fix is not a fourth round of shape-patching: every field this file
// used to derive from entry.md's prose (the two verdicts that gate whether a run may be indexed at
// all, and the file-path list that IS the index) now comes from `.sdd/ledger/<run-id>/entry.json`, a
// small JSON sidecar `scripts/ledger-append.mjs` writes next to entry.md. `JSON.parse` either
// succeeds or throws — there is no heading, no fence, no comment, no ambiguity surface for a
// malformed or adversarial entry to exploit. `extractSection`, `scanBlockState`, and
// `stripFencedAndCommentedBlocks` are deleted outright, not left in place unused: every call site
// that used to read markdown for a control decision now reads JSON instead (see
// scripts/check-red-integrity.mjs and scripts/ledger-append.mjs), and there is no remaining
// "purely descriptive" use for a general markdown-section extractor anywhere in this codebase — see
// .pipeline/changes.md for the full accounting of what was retired and why nothing calls it anymore.
//
// entry.md is still written, alongside entry.json, by ledger-append.mjs — it remains the
// human-facing rendering of the same data and is never parsed by this file (or anything else) for a
// control decision. See .sdd/ledger/README.md for entry.json's exact shape and the one-time PL-03a
// migration note (that run's entry.json was backfilled by hand from its own entry.md, the same
// documented affordance entry.md itself already had).
//
// PL-04 / B3: `entry.json`'s `bypass: true` field — see `readEntryJson`'s own comment below — is no
// longer written only by `ledger-append.mjs --hotfix`. That same script's normal path now also sets it
// (derived from the recorded verdicts, never a separately-settable flag — see that file's
// `buildEntryJson`) whenever a run's real, final verdicts were not both literally `PASS` and a human
// recorded a reasoned `--override-review`/`--override-security` to write the entry anyway. This file
// needed NO changes for that: `bypass: true` already meant "no ratified spec governs this entry's
// files, exclude them from the index," which is exactly as true of an overridden non-PASS run as it is
// of a hotfix — B3's explicit instruction was to reuse this exact mechanism rather than add a second,
// parallel "excluded" concept, and the mechanism already generalized without modification.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile, requireArray, requireBoolean, requireObject, requireString } from './pipeline-contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const ledgerDir = join(repoRoot, '.sdd', 'ledger');
const indexPath = join(ledgerDir, 'index.json');

function fail(message) {
  process.stderr.write(`build-ledger-index: ${message}\n`);
  process.exit(1);
}

function relFromRoot(path) {
  return path.split(repoRoot + '\\').join('').split(repoRoot + '/').join('').replace(/^[\\/]/, '').split('\\').join('/');
}

/** Every immediate subdirectory of .sdd/ledger/ is one run — README.md sits alongside them as a
 * file, not a directory, so it's excluded by the isDirectory() filter without special-casing it. */
function listRunDirs() {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Reads and strictly validates `.sdd/ledger/<runId>/entry.json` — the ONLY thing this file reads
 * to decide whether a run may be indexed and which files it touched. Built from the same shared
 * validation primitives (`requireObject`/`requireString`/`requireArray`) every `.pipeline/*.json`
 * reader in scripts/pipeline-contracts.mjs uses, so there is exactly one definition of "a required
 * non-empty string" in this codebase, not one per file that could quietly drift from another (the
 * PL-03c round-4 Critical 1 lesson — a heading counter and a heading extractor silently disagreeing —
 * applies just as much between two JSON validators as it did between two regexes).
 *
 * `verdicts` is checked byte-for-byte against `{ review: "PASS", security: "PASS" }` — not merely
 * "is a well-formed verdicts object" — because a ledger entry only exists at all because
 * `ledger-append.mjs` already re-verified both gates showed PASS; an entry.json claiming anything
 * else is malformed or corrupted, and must never be indexed (round-2/3's `assertVerdictsAreClean`,
 * carried forward at the JSON layer rather than dropped).
 *
 * `bypass` (D-005 #3 / the `/hotfix` wiring pass; generalized by PL-04 / B3 — see this file's own
 * header note) is the one documented exception to all of the above: a hotfix entry
 * (`scripts/ledger-append.mjs --hotfix`) never ran review or security at all, by design, and an
 * overridden entry (`ledger-append.mjs --override-review`/`--override-security`) ran both but ended
 * with a real, final verdict that was not both literally PASS — either way, there is no `verdicts`
 * this script can hold to the strict PASS/PASS check below, and no governing spec to attribute the
 * entry's files to (a run whose real verdict was not PASS never had its spec ratified, the same as a
 * run that never had a spec at all). `bypass` is optional and defaults to falsy — every entry.json
 * written before this field existed (the PL-03a migrated entry included) has no `bypass` key at all
 * and must keep parsing exactly as before; this is a different, ledger-internal file from the five
 * `.pipeline/*.json` contracts scripts/pipeline-contracts.mjs governs, so it does not inherit that
 * contract's "never omit a boolean to mean false" rule. See buildIndex() below for what "bypass"
 * actually changes.
 *
 * `regate` (PL-04 / item 3) is the opposite kind of field from `bypass`: it never excludes a run from
 * the index — a re-gated run's `verdicts` were still checked PASS/PASS above, exactly like any other
 * indexed run — it only decorates the record(s) that run produces (see buildIndex() below). Optional
 * and `null` for every entry.json written before this field existed, or for an ordinary (non-re-gate)
 * run, exactly like `bypass`'s own back-compat default; when present, only `testerRan` is read and
 * validated as a boolean — `gatesOnly` (the exact inverse) and the fixed disclosure `note` string
 * entry.json's own `regate` carries (see scripts/ledger-append.mjs's `buildEntryJson`) are
 * entry.json-only detail this index deliberately does not duplicate. */
function readRegateField(raw, label) {
  if (raw === undefined || raw === null) return null;
  const regateLabel = `${label}: regate`;
  requireObject(raw, regateLabel);
  const testerRan = requireBoolean(raw.testerRan, regateLabel, 'testerRan');
  return { testerRan };
}

/** PL-11: the opposite kind of field from `bypass`, the same way `regate` is — a lite run's
 * `entry.json` genuinely has a real, ratified spec `review` passed against the final tree, so it is
 * indexed rather than excluded; `lite` only decorates the record(s) that run produces (see
 * `buildIndex()` below) and widens the verdicts gate by exactly one shape (see `readEntryJson`
 * below). Optional, `null` for every entry.json written before this field existed and for every
 * non-lite run, matching `regate`'s own back-compat default. When present, only `skippedStages` is
 * read and validated (an array of strings) — `note`/`eligibility` are entry.json-only detail this
 * query index deliberately does not duplicate, the same narrowing `readRegateField` already applies
 * to `regate`'s own `gatesOnly`/`note`. */
function readLiteField(raw, label) {
  if (raw === undefined || raw === null) return null;
  const liteLabel = `${label}: lite`;
  requireObject(raw, liteLabel);
  const skippedStages = requireArray(raw.skippedStages, liteLabel, 'skippedStages')
    .map((item, i) => requireString(item, liteLabel, `skippedStages[${i}]`));
  return { skippedStages };
}

function readEntryJson(runId) {
  const label = `.sdd/ledger/${runId}/entry.json`;
  const path = join(ledgerDir, runId, 'entry.json');
  if (!existsSync(path)) fail(`${label} does not exist.`);
  const raw = readJsonFile(path, label); // size-capped (SC-12) as well as strict/duplicate-key-safe
  requireObject(raw, label);

  const runIdField = requireString(raw.runId, label, 'runId');
  if (runIdField !== runId) {
    fail(`${label}: field "runId" ("${runIdField}") must equal this entry's own directory name ("${runId}").`);
  }
  const ticket = requireString(raw.ticket, label, 'ticket');
  const date = requireString(raw.date, label, 'date');
  const filesTouched = requireArray(raw.filesTouched, label, 'filesTouched')
    .map((item, i) => requireString(item, label, `filesTouched[${i}]`));
  const bypass = raw.bypass === true;
  const regate = readRegateField(raw.regate, label);
  const lite = readLiteField(raw.lite, label);

  if (!bypass) {
    requireObject(raw.verdicts, `${label}: verdicts`);
    const actual = { review: raw.verdicts.review, security: raw.verdicts.security };
    // PL-11 / AC-11, EC-15: the verdicts gate widens by exactly one shape — { review: "PASS",
    // security: "SKIPPED_LITE" } is acceptable ONLY from an entry that declares itself lite AND
    // lists "security" among its own skippedStages. Anything else (no `lite` object at all, or one
    // that omits "security") is a non-lite entry attempting to launder a skipped gate into an
    // indexed one, and is refused exactly like any other malformed `verdicts` value below. Every
    // other non-bypass entry still enforces the original PASS/PASS check byte-for-byte, unchanged.
    const isDeclaredLite = lite !== null && lite.skippedStages.includes('security');
    const expected = isDeclaredLite ? { review: 'PASS', security: 'SKIPPED_LITE' } : { review: 'PASS', security: 'PASS' };
    if (actual.review !== expected.review || actual.security !== expected.security) {
      fail(
        `${label}: field "verdicts" must be exactly ${JSON.stringify(expected)} — got ${JSON.stringify(actual)}. ` +
        'A ledger entry only exists because both gates passed (or the lite lane honestly declares ' +
        'security as skipped) — this one claims something the tooling cannot verify, or is malformed, ' +
        'and must not be indexed.',
      );
    }
  }

  return { runId: runIdField, ticket, date, filesTouched, bypass, regate, lite };
}

/** Builds the in-memory index (file path -> sorted array of run references) from every ledger run
 * directory on disk. Exported so ledger-append.mjs can call it directly after writing a new entry,
 * rather than shelling out to this file as a subprocess. */
export function buildIndex() {
  const index = {};
  for (const runId of listRunDirs()) {
    const entryMdPath = join(ledgerDir, runId, 'entry.md');
    if (!existsSync(entryMdPath)) fail(`.sdd/ledger/${runId}/ has no entry.md`);

    const entry = readEntryJson(runId); // fails closed on anything malformed — see its own doc comment

    if (entry.bypass) {
      // A hotfix entry (D-005 #3, scripts/ledger-append.mjs --hotfix) never has a governing spec —
      // that is the whole point of a bypass, see .sdd/hotfix.md. It is deliberately excluded from
      // the file->spec map built below: index.json[file] must never resolve to a bypass entry, or a
      // caller asking "which spec governs this file" could be handed a hotfix and mistake the
      // absence of a spec for the presence of one. Skip both the spec.md-exists requirement below
      // (a bypass entry never has one) and the indexing loop — the entry's own directory
      // (entry.md/entry.json) remains real and discoverable by other means, just never through this
      // specific query path.
      continue;
    }

    const specPath = join(ledgerDir, runId, 'spec.md');
    if (!existsSync(specPath)) fail(`.sdd/ledger/${runId}/ has no spec.md`);

    for (const file of entry.filesTouched) {
      if (!index[file]) index[file] = [];
      const record = { runId, ticket: entry.ticket, date: entry.date, spec: `.sdd/ledger/${runId}/spec.md` };
      // PL-04 / item 3: carry the re-gate qualification forward, small on purpose — see this file's
      // header comment for why only `testerRan` (never `gatesOnly`/`note`) is copied here, and only
      // when this run's entry.json actually had one (readEntryJson's own back-compat default is
      // `null`). Omitted entirely, not written as `regate: null`, for every ordinary run's records.
      if (entry.regate) record.regate = { testerRan: entry.regate.testerRan };
      // PL-11 / AC-11, EC-20: the same reasoning `regate: { testerRan }` above already uses — carry
      // only `skippedStages` forward (never `note`/`eligibility`), and only when this run's
      // entry.json actually declared itself lite, so a reader following the fast path (buggy file ->
      // index.json) sees the attribution is qualified without a second hop into entry.json. Omitted
      // entirely, not written as `lite: null`, for every non-lite run's records.
      if (entry.lite) record.lite = { skippedStages: entry.lite.skippedStages };
      index[file].push(record);
    }
  }

  // Deterministic ordering so regeneration is byte-stable: sort file keys, and sort each file's
  // runs by runId (every run id begins with a sortable UTC timestamp, so this is also chronological).
  const sorted = {};
  for (const file of Object.keys(index).sort()) {
    sorted[file] = index[file].slice().sort((a, b) => a.runId.localeCompare(b.runId));
  }
  return sorted;
}

/** Unconditional `\n` line endings and a trailing newline, same reasoning as
 * generate-agent-shims.mjs: .gitattributes pins LF on this path so --check is byte-stable across
 * Windows and Linux checkouts. */
export function serializeIndex(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/** Builds the index and writes it to .sdd/ledger/index.json. Exported so ledger-append.mjs can
 * regenerate the index itself immediately after writing a new ledger entry, in the same process. */
export function writeIndex() {
  const index = buildIndex();
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(indexPath, serializeIndex(index), 'utf8');
  return index;
}

/** PL-04 / item 2 (the general defect): the only flag this CLI recognizes. `main()` below used to
 * check `process.argv.includes('--check')` directly and otherwise ignore argv entirely — a typo'd
 * `--chekc` (or any other unrecognized token) silently fell through to the ordinary write-mode path
 * instead of running the staleness check the caller almost certainly meant to invoke. Validated
 * up front now, naming the exact unrecognized token, the same fix applied throughout scripts/. */
const KNOWN_FLAGS = new Set(['--check']);

function main() {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      fail(`unrecognized argument "${arg}" — known flags: --check. A typo'd flag must never look like it worked.`);
    }
  }
  const checkMode = argv.includes('--check');
  const index = buildIndex();
  const content = serializeIndex(index);
  const fileCount = Object.keys(index).length;
  const runCount = listRunDirs().length;

  if (checkMode) {
    const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
    if (current === content) {
      console.log(`build-ledger-index --check: ${relFromRoot(indexPath)} is up to date (${fileCount} file(s), ${runCount} run(s)).`);
      process.exit(0);
    }
    process.stderr.write(`build-ledger-index --check: ${relFromRoot(indexPath)} is stale.\n\n`);
    process.stderr.write(`-- expected (regenerated from .sdd/ledger/*/entry.json) --\n${content}\n`);
    process.stderr.write(`-- actual (on disk) --\n${current ?? '(file does not exist)\n'}\n`);
    process.stderr.write('Run `node scripts/build-ledger-index.mjs` to regenerate, or `npm run generate:ledger-index`.\n');
    process.exit(1);
  }

  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(indexPath, content, 'utf8');
  console.log(`build-ledger-index: wrote ${relFromRoot(indexPath)} (${fileCount} file(s), ${runCount} run(s)).`);
}

// Only run as a CLI entry point — importing buildIndex/writeIndex (e.g. from ledger-append.mjs)
// must not also trigger this file's own --check/write side effects against the importer's argv.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // readEntryJson/parseJsonOrThrow throw SidecarError on malformed JSON or a failed shape check
    // (fail closed on ambiguity, now "fail closed on invalid JSON" — see pipeline-contracts.mjs);
    // this catch is what turns that (and any other unexpected error — an I/O failure, ...) into one
    // clean, prefixed message and exit 1, instead of a raw Node stack trace.
    fail(error.message);
  }
}

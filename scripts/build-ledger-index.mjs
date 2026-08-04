// Regenerates .sdd/ledger/index.json from every .sdd/ledger/<run-id>/entry.json on disk (PL-03c;
// re-pointed from entry.md to entry.json by PL-03h round 4 — see the file header note below).
//
// Usage:
//   node scripts/build-ledger-index.mjs            # writes .sdd/ledger/index.json
//   node scripts/build-ledger-index.mjs --check    # exit 1 + diff if index.json is stale
//
// index.json maps a repo-relative file path to every ledger run that touched it:
//   { "services/core/src/graph-query/index.ts": [ { runId, ticket, date, spec }, ... ] }
// This is the file-granularity query path spec.md describes: buggy file -> index.json -> the
// spec(s) that mandated it (the same shape as generate-agent-shims.mjs's --check contract — never
// hand-edit index.json, regenerate it and commit the result).
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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile, requireArray, requireObject, requireString } from './pipeline-contracts.mjs';

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
 * `bypass` (D-005 #3 / the `/hotfix` wiring pass) is the one documented exception to all of the
 * above: a hotfix entry (`scripts/ledger-append.mjs --hotfix`) never ran review or security, by
 * design, so it has no `verdicts` to check and no governing spec to attribute its files to. It is
 * optional and defaults to falsy — every entry.json written before this field existed (the PL-03a
 * migrated entry included) has no `bypass` key at all and must keep parsing exactly as before; this
 * is a different, ledger-internal file from the five `.pipeline/*.json` contracts
 * scripts/pipeline-contracts.mjs governs, so it does not inherit that contract's "never omit a
 * boolean to mean false" rule. See buildIndex() below for what "bypass" actually changes. */
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

  if (!bypass) {
    requireObject(raw.verdicts, `${label}: verdicts`);
    const expected = { review: 'PASS', security: 'PASS' };
    const actual = { review: raw.verdicts.review, security: raw.verdicts.security };
    if (actual.review !== expected.review || actual.security !== expected.security) {
      fail(
        `${label}: field "verdicts" must be exactly ${JSON.stringify(expected)} — got ${JSON.stringify(actual)}. ` +
        'A ledger entry only exists because both gates passed — this one claims something the tooling ' +
        'cannot verify, or is malformed, and must not be indexed.',
      );
    }
  }

  return { runId: runIdField, ticket, date, filesTouched, bypass };
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
      index[file].push({ runId, ticket: entry.ticket, date: entry.date, spec: `.sdd/ledger/${runId}/spec.md` });
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

function main() {
  const checkMode = process.argv.includes('--check');
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

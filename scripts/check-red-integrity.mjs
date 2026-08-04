// Mechanically checks the two guarantees .sdd/stages/review.md's "Red-test integrity" and
// "Spec trace" checks describe (PL-03c review Critical 3): that no file red.json hashed has changed
// without an explicit, named declaration in changes.json, and that every behavioral test red.json
// lists cites a @spec marker that actually resolves to a real AC-*/EC-* item in spec.json.
//
// Usage:
//   node scripts/check-red-integrity.mjs
//   node scripts/check-red-integrity.mjs --dir <path>
//
// `--dir` (review Critical 3 / PL-03h round 5) points this script at a directory other than
// `.pipeline/` for its three JSON inputs (`red.json`, `spec.json`, `changes.json`) — added so
// `pr-review` (.sdd/stages/pr-review.md) can run the exact same mechanical check against a
// *committed* copy once `.pipeline/` itself is unavailable. `.pipeline/` is gitignored, per-run
// scratch: it does not exist on a fresh checkout of a PR branch, so a `pr-review` run that only ever
// looked at `.pipeline/red.json` there would *always* hit the "no red.json — nothing to check" path
// and get reported as a clean lens, which is worse than no lens at all (a check that always passes
// teaches a reader nothing). `.sdd/ledger/<run-id>/` holds a verbatim copy of the same three files
// (scripts/ledger-append.mjs's copySidecarsIntoLedger) once a run has reached terminal PASS — durable
// and committed, unlike `.pipeline/`. `--dir .sdd/ledger/<run-id>` points this script there instead.
// The "candidate new tests in the diff" check is unaffected either way — it always reads the live
// working-tree diff, independent of which JSON directory is in use, because a candidate-new-test
// report is about what changed on disk right now, not about a specific archived run.
//
// PL-03h round 4 (architectural — see .pipeline/review.md's round-3 "On convergence" section and
// scripts/pipeline-contracts.mjs's own header): this script used to read `.pipeline/red.md`,
// `.pipeline/spec.md`, and `.pipeline/changes.md`'s raw markdown, through a hand-rolled block
// scanner shared with build-ledger-index.mjs (`extractSection`/`stripFencedAndCommentedBlocks`).
// Review's round-3 pass found the scanner's own "strip fenced/commented lines first" fix had not
// been applied to this script's `parseContentHashes`/`parseSpecMapping` parsers, so a fenced
// "here's the format" example inside "## Content hashes (SHA-256)" could overwrite (via `Map.set`)
// the real, recorded hash — inverting the check's result: an untouched red test exited 1 (a false
// violation) and a quietly-weakened, undeclared one exited 0 reporting `clean`. That inversion is
// eliminated **by construction** now, not merely patched: `red.json`'s `tests` array bundles a
// test's `path`/`sha256`/`specIds`/`classification` into one object per test, so there is no second,
// independently-parsed list for a fenced example to make disagree with the first, and no `Map` for a
// later, illustrative entry to silently overwrite — see scripts/pipeline-contracts.mjs's own header.
//
// What this script still does NOT read as JSON: the actual test files red.json lists (it computes
// their real, current SHA-256 and greps their content for `@spec <ID>` markers — a fixed source-code
// comment idiom this pipeline itself writes, not an open-ended natural-language document) and the
// live git diff (for informational "new test file" candidates only, never a control decision). Both
// are unrelated to the markdown-ambiguity class this ticket removes: there is no heading, fence, or
// HTML comment involved in either, only a file's byte content and a fixed regex over a comment
// convention this codebase's own tooling generates.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeclaredInChanges, knownSpecIds, readChangesJson, readRedJson, readSpecJson } from './pipeline-contracts.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const TEST_FILE_PATTERN = /\.test\.(m?js|ts|tsx)$|(^|\/)test_[^/]+\.py$/;

/** `--dir <path>` overrides the default `.pipeline/` directory this script reads its three JSON
 * inputs from — see the file header for why (`pr-review` on a fresh PR checkout, where `.pipeline/`
 * never existed). Absent, defaults to `.pipeline/`, unchanged from every prior version of this
 * script.
 *
 * PL-04 / item 2 (the general defect): any other token throws, naming itself, rather than being
 * silently skipped the way this loop used to skip anything that wasn't literally `--dir` — the same
 * "typo'd flag must never look like it worked" fix applied throughout scripts/. Thrown, not `fail()`d
 * directly, so it reaches this file's own top-level `catch` (see the bottom of this file) and gets
 * the same one clean, prefixed message and exit 1 every other error here already gets.
 *
 * CORRECTED (PL-04 review pass 1 / W2): the fix above closed "any OTHER token" but left `--dir`
 * itself under-validated: `argv[++i]` was taken as the value unconditionally, so `--dir` as the very
 * last token (no value at all) silently fell back to `.pipeline/` (a falsy `undefined`), and `--dir
 * --bogus` silently took the literal string `"--bogus"` as a directory name — main() then found no
 * red.json there and reported `status: "no-red-json"`, exit 0, "nothing to check," for what was
 * actually a typo'd invocation. This is the one script among those audited for this invariant that
 * still violated it. Fixed the same way `ledger-append.mjs`'s `readRegateArgs`/`check-bounds.mjs`'s
 * `--lane` handling validate a value-flag's argument: missing or flag-shaped (starts with `--`) both
 * throw, naming what was actually found. */
function parseArgs(argv) {
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--dir requires a path value (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}) — a typo'd flag must never look like it worked.`);
      }
      dir = value;
      i++;
      continue;
    }
    throw new Error(`unrecognized argument "${argv[i]}" — known flags: --dir <path>. A typo'd flag must never look like it worked.`);
  }
  return { dir };
}

/** Every `@spec <ID> [<ID> ...]` marker occurring anywhere in a test file's actual content — the
 * project's comment idiom per .sdd/stages/red.md ("// @spec AC-3 EC-1" for TS/JS, "# @spec AC-3"
 * for Python). Read from the file itself, not only from red.json's self-reported `specIds`, since
 * the two could go stale relative to each other — this is a source-code-comment convention this
 * pipeline's own tooling writes, not the open-ended markdown surface the rest of this file's history
 * concerns; there is nothing here for a fenced example or an HTML comment to launder through. */
function extractSpecMarkersFromContent(content) {
  const ids = new Set();
  for (const match of content.matchAll(/@spec[ \t]+((?:(?:AC|EC)-\d+[a-z]?[ \t]*)+)/g)) {
    for (const id of match[1].trim().split(/\s+/)) if (id) ids.add(id);
  }
  return ids;
}

function sha256OfFile(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/** True only for a path that both exists and is a regular file — never a directory. PL-03h, finding
 * 5 (carried forward unchanged by this round's architectural change — this has nothing to do with
 * markdown parsing): `existsSync(absolutePath)` alone returns `true` for a directory too, and every
 * call site in this file that reads a listed path's content needs the same guard ahead of it, or it
 * throws the same uncaught `EISDIR`. Used uniformly at all three read sites below (the rehash loop,
 * the spec-trace loop, and the candidate-new-test loop) — review round 3's Warning 1 found the
 * rehash loop had drifted to a separate, independently-guarded `existsSync` + `statSync(...)
 * .isDirectory()` pair instead of calling this shared predicate; fixed here so there is exactly one
 * definition of "safe to read," not one shared predicate plus one independent copy of it. */
function isReadableFile(absolutePath) {
  return existsSync(absolutePath) && statSync(absolutePath).isFile();
}

/** Repo-relative paths changed or newly added in the working tree right now (staged, unstaged, and
 * untracked) — the same "prefer the live diff" approach scripts/ledger-append.mjs uses for its own
 * "files touched" detection, reused here only to surface *candidate* new test files, never to gate
 * on. Best-effort: an empty result (not a git repo, no HEAD yet) just means no candidates reported,
 * not a failure — this is informational only. */
function diffCandidateFiles() {
  const files = new Set();
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of diffOutput.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  } catch {
    // Not a git repo, no HEAD yet, or git unavailable.
  }
  try {
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' });
    for (const line of untrackedOutput.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  } catch {
    // Same fallback reasoning as above.
  }
  return [...files].sort();
}

function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const pipelineDir = dir ? resolve(repoRoot, dir) : join(repoRoot, '.pipeline');
  // Used only in human-readable messages below, so a --dir run's output names the directory it
  // actually read from rather than always saying ".pipeline" regardless of what was checked.
  const dirLabel = dir ? dir.replace(/[/\\]+$/, '') : '.pipeline';

  const redJsonPath = join(pipelineDir, 'red.json');
  const redMdPath = join(pipelineDir, 'red.md');

  if (!existsSync(redJsonPath)) {
    if (!existsSync(redMdPath)) {
      // Legitimate absence, not a violation — a ticket that predates the `red` stage (PL-03a-style),
      // or a review re-invocation with no red stage this run. Mirrors ledger-append.mjs's own
      // no-red-artifacts handling. Nothing to check; nothing to block on. Note for a `--dir` caller
      // (pr-review, review Critical 3): this status means "nothing was checked," never "checked and
      // clean" — a caller that cannot find red.json in either `.pipeline/` or a ledger copy must
      // report this lens as unverified, not as passing.
      console.log(JSON.stringify({ status: 'no-red-json', violations: [], notes: [`No ${dirLabel}/red.json for this run — nothing to check.`] }, null, 2));
      console.log(`check-red-integrity: no ${dirLabel}/red.json for this run — nothing to check.`);
      process.exit(0);
    }
    // <dir>/red.md exists but <dir>/red.json does not: under the JSON-first contract (PL-03h round
    // 4), every control decision reads red.json, so this is not the same "no red stage ran" state as
    // neither file existing — a red stage DID run, and it did not emit the sidecar its own stage
    // contract (.sdd/stages/red.md) now requires. Treating this as a free pass would silently reopen
    // the exact bypass the JSON contract exists to close (a stage that simply omits its sidecar would
    // otherwise sail through as "nothing to check").
    console.log(JSON.stringify({
      status: 'violations-found',
      violations: [`${dirLabel}/red.md exists but ${dirLabel}/red.json does not — under the JSON-first pipeline contract (see .sdd/stages/red.md), red must emit both. This is not the "no red stage for this run" state; it is an incomplete red-stage output.`],
      notes: [],
    }, null, 2));
    process.stderr.write(`check-red-integrity: violation: ${dirLabel}/red.md exists but ${dirLabel}/red.json does not.\n`);
    process.exit(1);
  }

  const redJson = readRedJson(pipelineDir, { required: true });
  const specJson = readSpecJson(pipelineDir, { required: true });
  const changesJson = readChangesJson(pipelineDir, { required: false });
  const knownIds = knownSpecIds(specJson);

  const violations = [];
  const notes = [];

  // Note on what no longer needs a check here: red.json's `impactMapPresent` field is a required,
  // strictly-typed boolean (scripts/pipeline-contracts.mjs's readRedJson) — there is no way to omit
  // it or set it to anything other than true/false, so ".sdd/stages/red.md requires the impact map's
  // presence or absence to be stated explicitly, never left blank" is now enforced at the JSON
  // read, not by a separate "is this section's text non-empty" check. Likewise, a `classification`
  // value of "RED-BROKEN" fails readRedJson's own enum check outright (RED_CLASSIFICATIONS in
  // pipeline-contracts.mjs allows only RED-CORRECT/RED-DEFERRED) — there is no longer a "grep the
  // whole document for this literal substring" step to write, because there is nothing else the
  // field could validly contain.

  // --- Red-test integrity: rehash every listed file, compare against red.json's recorded hash ----
  for (const test of redJson.tests) {
    const { path, sha256: expectedHash } = test;
    const absolutePath = join(repoRoot, path);
    if (!existsSync(absolutePath)) {
      violations.push(`"${path}" is listed in red.json's "tests" but no longer exists on disk.`);
      continue;
    }
    if (!isReadableFile(absolutePath)) {
      violations.push(`"${path}" is listed in red.json's "tests" but is a directory, not a file — cannot hash it.`);
      continue;
    }
    const actualHash = sha256OfFile(absolutePath);
    if (actualHash === expectedHash) continue;
    if (isDeclaredInChanges(changesJson, path)) {
      notes.push(`"${path}"'s content hash changed (from ${expectedHash} to ${actualHash}) and is declared in changes.json's "redTestChanges" — review must judge whether the stated reason is legitimate.`);
    } else {
      violations.push(`"${path}"'s content hash changed (from ${expectedHash} to ${actualHash}) and changes.json does not declare this change in "redTestChanges" — an undeclared red-test change is exactly the failure this check exists to catch.`);
    }
  }

  // --- Spec trace: every listed test must cite at least one @spec ID that resolves to spec.json --
  for (const test of redJson.tests) {
    const { path, specIds } = test;
    const absolutePath = join(repoRoot, path);
    // A directory has no file content to extract a marker from, so it's treated the same as
    // "doesn't exist" here; the red-test-integrity loop above already reports the directory itself
    // as its own violation.
    const idsFromFile = isReadableFile(absolutePath) ? extractSpecMarkersFromContent(readFileSync(absolutePath, 'utf8')) : new Set();
    const allIds = new Set([...specIds, ...idsFromFile]);

    if (allIds.size === 0) {
      violations.push(`"${path}" cites no "@spec" marker at all — neither in red.json's "specIds" nor in the file's own content.`);
      continue;
    }
    for (const id of allIds) {
      if (!knownIds.has(id)) violations.push(`"${path}" cites "@spec ${id}", which does not resolve to a real AC-*/EC-* item in spec.json's "acceptanceCriteria" or "edgeCases".`);
    }
  }

  // --- Candidates: new test files in the diff not covered by red.json's tests (report only) ------
  const testPathSet = new Set(redJson.tests.map((test) => test.path));
  const candidateNewTests = diffCandidateFiles().filter((path) => TEST_FILE_PATTERN.test(path) && !testPathSet.has(path));
  for (const path of candidateNewTests) {
    const absolutePath = join(repoRoot, path);
    const hasMarker = isReadableFile(absolutePath) && extractSpecMarkersFromContent(readFileSync(absolutePath, 'utf8')).size > 0;
    if (!hasMarker) {
      notes.push(`"${path}" is a new test file in the diff, not listed in red.json's "tests", and carries no "@spec" marker — review should judge whether it is behavioral (tester may only add non-behavioral coverage).`);
    }
  }

  const report = {
    status: violations.length > 0 ? 'violations-found' : 'clean',
    testPathsChecked: redJson.tests.map((test) => test.path),
    hashesChecked: redJson.tests.map((test) => test.path),
    candidateNewTests,
    violations,
    notes,
  };
  // JSON first (machine-readable, for tooling), then each note/violation restated as its own plain
  // line — JSON.stringify escapes embedded quotes, which makes the JSON block itself awkward to
  // grep/match against for a human or a test; these plain lines are not JSON-escaped.
  console.log(JSON.stringify(report, null, 2));
  for (const note of notes) console.log(`check-red-integrity: note: ${note}`);

  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`check-red-integrity: violation: ${violation}\n`);
    process.stderr.write(`check-red-integrity: ${violations.length} violation(s) found — see above. review must set NEEDS_FIXES.\n`);
    process.exit(1);
  }
  console.log(`check-red-integrity: no violations found (${redJson.tests.length} test path(s) checked).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // readRedJson/readSpecJson/readChangesJson throw SidecarError on malformed JSON or a failed
    // strict-shape check (see scripts/pipeline-contracts.mjs) — this catch turns that (and any other
    // unexpected error) into one clean, prefixed message and exit 1, instead of a raw Node stack
    // trace.
    process.stderr.write(`check-red-integrity: ${error.message}\n`);
    process.exit(1);
  }
}

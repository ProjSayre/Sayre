#!/usr/bin/env node
/**
 * Lite-lane eligibility check (PL-11): is this change provably small enough, and clear enough of the
 * barred paths, for `/pipeline-lite` to skip `red` and `security` on it?
 *
 * Reuses scripts/check-bounds.mjs's `readBounds()`/`matchesAny()` rather than re-implementing either
 * the bounds read or the glob matcher — one implementation of "does this path match one of these
 * globs" and one implementation of "what does .sdd/bounds.yml say," not a second, independently
 * written copy of either.
 *
 * Usage:
 *   node scripts/check-lite-eligible.mjs                        # live working tree (default)
 *   node scripts/check-lite-eligible.mjs --files <path...>      # explicit list; path/count checks only
 *   node scripts/check-lite-eligible.mjs --base main             # merge-base <base>..HEAD
 *   node scripts/check-lite-eligible.mjs --json
 *
 * Exit 0 = eligible. Exit 1 = ineligible. Exit 2 = the check could not be performed.
 *
 * The 1/2 split is the same one scripts/check-bounds.mjs already documents, for the same reason:
 * collapsing "the check failed" into "the change is clean" is how a broken gate reads as a passing
 * one. `--files` consumes every remaining argument and must be last (the convention
 * scripts/check-bounds.mjs and scripts/ledger-append.mjs's `--hotfix` path already use) — a trailing
 * `--json` after `--files` would otherwise be swallowed as one more file path.
 *
 * `--files` mode is path/count-only: it never shells out to measure changed lines or line length
 * (there is no diff to measure — the caller is naming paths directly), so `changedLines`/`lineLength`
 * are `null` and `changedLinesChecked`/`lineLengthChecked` are `false`. That is not, by itself,
 * ineligible (EC-1's "ambiguous eligibility routes to /pipeline" applies to the CALLER of this script
 * when it cannot even name paths confidently — it does not mean every `--files` invocation is
 * automatically ambiguous). The default (live working tree) and `--base` modes always measure both,
 * and refuse (exit 2) rather than report "eligible" when there is nothing to measure at all (EC-17).
 *
 * Two independent size bounds are enforced, not one: `max_changed_lines` counts LINES, which a diff
 * shaped as a very few, very long lines can defeat while still carrying tens of KB of real content
 * (security round FND-22ef4b5c746e) — `max_line_length` is the orthogonal bound that catches that
 * shape (see `maxChangedLineLength` below).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny, readBounds } from './check-bounds.mjs';

function die(message) {
  process.stderr.write(`check-lite-eligible: ${message}\n`);
  process.exit(2);
}

/** The five kinds of violation `evaluateLiteEligibility` can report — exported so a consumer (e.g.
 * `scripts/ledger-append.mjs`'s `--lite` branch) can recognize/filter them without re-deriving the
 * vocabulary. Order is deliberate but not load-bearing: nothing here depends on it.
 *
 * `'line-length'` (security round FND-22ef4b5c746e): `'changed-lines'` alone counts LINES, not their
 * size, so a diff shaped as a very few, very long lines defeats it — see `maxChangedLineLength`. */
export const LITE_VIOLATION_KINDS = ['barred-path', 'file-count', 'changed-lines', 'unsizable', 'line-length'];

/** union(hotfixBarredPaths, denyForFenced), deduped and sorted — no third list in bounds.yml (see
 * that file's own `lite_eligibility:` header comment for why). */
export function liteBarredPaths(bounds) {
  const hotfix = bounds?.hotfixBarredPaths ?? [];
  const deny = bounds?.denyForFenced ?? [];
  return [...new Set([...hotfix, ...deny])].sort();
}

function listUntracked(cwd) {
  try {
    const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Live working tree: `git diff --name-only HEAD` (tracked modifications, staged or not) plus
 * `git ls-files --others --exclude-standard` (untracked additions) — the same two commands
 * scripts/ledger-append.mjs's own `filesTouched` already uses, so "what changed" is computed one way
 * across both scripts. */
export function resolveWorktreeFiles(cwd = process.cwd()) {
  const files = new Set();
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) if (line.trim()) files.add(line.trim());
  } catch {
    // Not a git repo, no HEAD yet, or git unavailable — an empty result here is handled by main()'s
    // own "nothing to measure" refusal below, never silently treated as "nothing changed, so eligible."
  }
  for (const file of listUntracked(cwd)) files.add(file);
  return [...files].sort();
}

function resolveMergeBase(base, cwd) {
  return execFileSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

/** `git diff --name-only <mergeBase>..HEAD` — the committed-range equivalent of
 * `resolveWorktreeFiles`, for `--base <ref>`. Throws (the caller's job to turn into exit 2) when
 * `base` cannot be resolved against `HEAD` at all. */
function resolveBaseFiles(base, cwd) {
  const mergeBase = resolveMergeBase(base, cwd);
  const out = execFileSync('git', ['diff', '--name-only', `${mergeBase}..HEAD`], { cwd, encoding: 'utf8' });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
}

function countFileLines(content) {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** added+deleted across `files`. Tracked changes come from `git diff --numstat` (HEAD, or
 * `merge-base <base>..HEAD` when `base` is given); an untracked file contributes its own line count
 * (read directly off disk, never inferred from a diff that will never mention it). A numstat row
 * reporting `-`/`-` (binary) yields no number — its path lands in `unsizable` and the change is
 * ineligible (EC-4). A path that is neither a tracked change nor an untracked file (nothing in the
 * diff mentions it, and it does not exist on disk either — e.g. `changes.json` naming a file that was
 * since reverted on an otherwise-clean tree) is unsizable for the same reason: there is nothing here
 * to measure it against, and a change that cannot be measured is never measured as small (EC-17). */
export function countChangedLines(files, { cwd = process.cwd(), base = null } = {}) {
  if (!files || files.length === 0) return { changedLines: 0, unsizable: [] };

  const range = base ? `${resolveMergeBase(base, cwd)}..HEAD` : 'HEAD';
  const numstatOut = execFileSync('git', ['diff', '--numstat', range, '--', ...files], { cwd, encoding: 'utf8' });
  const rows = new Map();
  for (const line of numstatOut.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!match) continue;
    rows.set(match[3], { added: match[1], deleted: match[2] });
  }

  const untracked = new Set(listUntracked(cwd));
  let changedLines = 0;
  const unsizable = [];
  for (const file of files) {
    const row = rows.get(file);
    if (row) {
      if (row.added === '-' || row.deleted === '-') { unsizable.push(file); continue; }
      changedLines += Number(row.added) + Number(row.deleted);
      continue;
    }
    if (untracked.has(file)) {
      try {
        changedLines += countFileLines(readFileSync(resolve(cwd, file), 'utf8'));
      } catch {
        unsizable.push(file);
      }
      continue;
    }
    unsizable.push(file);
  }
  return { changedLines, unsizable };
}

/** The length (in UTF-16 code units — the same "character" unit `countFileLines`'s own line-splitting
 * already implies) of the single longest content line added or removed across `files`, tracked or
 * untracked (security round FND-22ef4b5c746e). `countChangedLines` counts LINES, not their size, so a
 * diff can be shaped as a very few, very long lines — e.g. one line replaced with ~20,000+ characters
 * of new content — and measure as deceptively few "changed lines" while carrying tens of KB of real
 * content; this is the orthogonal, second dimension that catches exactly that shape.
 *
 * Tracked content comes from a full `git diff <range> -- <files>` (never `--numstat`, which reports
 * only counts, no content): every line beginning with `+`/`-`, EXCLUDING the `+++`/`---` file-path
 * header lines, is real added/removed content; its length after stripping the leading marker
 * character is measured directly. Untracked files contribute the longest line of their own on-disk
 * content — the same "read the file directly, never infer it from a diff that will never mention it"
 * reasoning `countChangedLines` already uses for the same case.
 *
 * A binary file's diff has no `+`/`-` content lines at all (git prints "Binary files ... differ"
 * instead), so it contributes nothing here — it is already caught, unconditionally, by
 * `countChangedLines`'s own `unsizable` list (EC-4), which `evaluateLiteEligibility` treats as a
 * violation regardless of this bound. Returns `0` for an empty `files` list, matching
 * `countChangedLines`'s own "nothing to measure" convention. */
export function maxChangedLineLength(files, { cwd = process.cwd(), base = null } = {}) {
  if (!files || files.length === 0) return 0;

  const range = base ? `${resolveMergeBase(base, cwd)}..HEAD` : 'HEAD';
  const diffOut = execFileSync('git', ['diff', range, '--', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  let longest = 0;
  for (const line of diffOut.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const marker = line[0];
    if (marker !== '+' && marker !== '-') continue;
    const contentLength = line.length - 1;
    if (contentLength > longest) longest = contentLength;
  }

  const untracked = new Set(listUntracked(cwd));
  for (const file of files) {
    if (!untracked.has(file)) continue;
    let content;
    try {
      content = readFileSync(resolve(cwd, file), 'utf8');
    } catch {
      continue; // unreadable — already unsizable via countChangedLines; nothing to add here.
    }
    for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
      if (line.length > longest) longest = line.length;
    }
  }

  return longest;
}

/**
 * Pure: the same input always yields the same verdict, with the bounds it was measured against
 * echoed back. `changedLines: null` (and, separately, `lineLength: null`) means "not measured" (the
 * `--files` path-only mode), which sets `changedLinesChecked`/`lineLengthChecked` to `false` and does
 * NOT by itself make a change ineligible.
 *
 * Throws when `bounds.liteEligibility` is `null` — a missing bound is never read as "no bound" (EC-16).
 */
export function evaluateLiteEligibility({ files, changedLines, unsizable = [], lineLength = null, bounds }) {
  if (!bounds || !bounds.liteEligibility) {
    throw new Error(
      'bounds.liteEligibility is null — .sdd/bounds.yml\'s "lite_eligibility" block is missing or ' +
      'malformed (absent, or one of max_files/max_changed_lines/max_line_length is not a ' +
      'non-negative integer). A missing bound is never read as "no bound."',
    );
  }
  const { maxFiles, maxChangedLines, maxLineLength } = bounds.liteEligibility;
  const fileCount = files.length;
  const changedLinesChecked = changedLines !== null && changedLines !== undefined;
  const lineLengthChecked = lineLength !== null && lineLength !== undefined;
  const violations = [];

  const barred = liteBarredPaths(bounds);
  for (const file of files) {
    if (!matchesAny(file, barred)) continue;
    const inHotfix = matchesAny(file, bounds.hotfixBarredPaths ?? []);
    const inDeny = matchesAny(file, bounds.denyForFenced ?? []);
    const lists = [inHotfix ? 'hotfix_barred_paths' : null, inDeny ? 'deny_for_fenced_lanes' : null].filter(Boolean);
    violations.push({
      kind: 'barred-path',
      path: file,
      detail: `"${file}" matches ${lists.join(' and ')} — never eligible for the lite lane.`,
    });
  }

  for (const file of unsizable) {
    violations.push({
      kind: 'unsizable',
      path: file,
      detail: `"${file}" could not be measured (e.g. a binary file, or a path with no diff and no ` +
        'on-disk content) — a change that cannot be measured is never measured as small.',
    });
  }

  if (fileCount > maxFiles) {
    violations.push({
      kind: 'file-count',
      detail: `${fileCount} file(s) touched, exceeds max_files (${maxFiles}).`,
    });
  }

  if (changedLinesChecked && changedLines > maxChangedLines) {
    violations.push({
      kind: 'changed-lines',
      detail: `${changedLines} changed line(s), exceeds max_changed_lines (${maxChangedLines}).`,
    });
  }

  if (lineLengthChecked && lineLength > maxLineLength) {
    violations.push({
      kind: 'line-length',
      detail: `a changed line is ${lineLength} character(s) long, exceeds max_line_length (${maxLineLength}) ` +
        '— few, very long lines can hide a large change behind a small changed-lines count.',
    });
  }

  return {
    eligible: violations.length === 0,
    fileCount,
    changedLines: changedLinesChecked ? changedLines : null,
    changedLinesChecked,
    lineLength: lineLengthChecked ? lineLength : null,
    lineLengthChecked,
    maxFiles,
    maxChangedLines,
    maxLineLength,
    violations,
  };
}

const KNOWN_FLAGS = new Set(['--files', '--base', '--json']);

function parseArgs(argv) {
  const args = { files: null, base: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { args.json = true; }
    else if (arg === '--base') { args.base = argv[++i]; }
    else if (arg === '--files') { args.files = argv.slice(i + 1); break; }
    else {
      die(
        `unrecognized argument "${arg}" — known flags: ${[...KNOWN_FLAGS].join(', ')} (--files ` +
        'consumes every remaining argument). A typo\'d flag must never read as an eligible change.',
      );
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bounds = readBounds();
  const cwd = process.cwd();

  let files;
  let changedLines = null;
  let unsizable = [];
  let lineLength = null;
  let changedLinesChecked = false;

  if (args.files !== null) {
    files = args.files;
  } else {
    try {
      files = args.base ? resolveBaseFiles(args.base, cwd) : resolveWorktreeFiles(cwd);
    } catch (error) {
      die(`could not resolve ${args.base ? `--base "${args.base}"` : 'the working tree'}: ${error.message}`);
    }
    if (files.length === 0) {
      die(
        'nothing to measure: no changed files were found (the working tree — or base diff — is ' +
        'clean); refusing to certify an unmeasured, empty change as eligible.',
      );
    }
    try {
      ({ changedLines, unsizable } = countChangedLines(files, { cwd, base: args.base }));
    } catch (error) {
      die(`could not measure changed lines: ${error.message}`);
    }
    try {
      lineLength = maxChangedLineLength(files, { cwd, base: args.base });
    } catch (error) {
      die(`could not measure line lengths: ${error.message}`);
    }
    changedLinesChecked = true;
  }

  let result;
  try {
    result = evaluateLiteEligibility({
      files,
      changedLines: changedLinesChecked ? changedLines : null,
      unsizable,
      lineLength: changedLinesChecked ? lineLength : null,
      bounds,
    });
  } catch (error) {
    die(error.message);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.eligible) {
    process.stdout.write(
      `Eligible: ${result.fileCount} file(s), ` +
      `${result.changedLinesChecked ? `${result.changedLines} changed line(s)` : 'lines not measured'} ` +
      `(bounds: max_files ${result.maxFiles}, max_changed_lines ${result.maxChangedLines}).\n`,
    );
  } else {
    process.stdout.write(`Ineligible for the lite lane — ${result.violations.length} violation(s):\n`);
    for (const v of result.violations) {
      process.stdout.write(`  [${v.kind}]${v.path ? ` ${v.path}` : ''}: ${v.detail}\n`);
    }
  }

  process.exit(result.eligible ? 0 : 1);
}

// Only run as a CLI entry point — scripts/ledger-append.mjs's --lite branch imports
// evaluateLiteEligibility/countChangedLines as a library, and that import must never also trigger
// this file's own argv-driven main()/process.exit() side effects against the importer's own argv.
// Same guard, same reasoning, as scripts/check-bounds.mjs and scripts/build-ledger-index.mjs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * Bounds check (PL-03d): does a change stay inside the lane its ticket was assigned?
 *
 * This is the deterministic half of `pr-review`. The agent adjudicates whether an out-of-lane
 * change was justified; it never decides whether one occurred. An LLM asked "did this stay in
 * bounds?" can hallucinate a pass — a glob match cannot. Same split D-006 draws between a numeric
 * CI gate and "does this feel janky".
 *
 * Lane definitions come from `.sdd/bounds.yml`, not from `bounds.md`'s prose table, for the reason
 * recorded in that file's header.
 *
 * Usage:
 *   node scripts/check-bounds.mjs --lane frontend --base main
 *   node scripts/check-bounds.mjs --lane frontend --files a.ts b.ts     (explicit file list)
 *   node scripts/check-bounds.mjs --lane frontend --base main --json
 *
 * Exit 0 = in bounds. Exit 1 = violation(s). Exit 2 = the check could not be performed.
 * The 1/2 split matters: a violation is a finding about the change, an error is a finding about
 * the tooling, and collapsing them would let a broken check read as a clean diff.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, posix, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BOUNDS_FILE = resolve(REPO, '.sdd/bounds.yml');

function die(message) {
  process.stderr.write(`check-bounds: ${message}\n`);
  process.exit(2);
}

/**
 * Supported, deliberately minimally: `**` crosses path separators, `*` does not, everything else
 * is literal. No brace expansion, no character classes, no extglob — a lane definition that needs
 * them is a lane definition that has become hard to reason about, which is its own warning.
 *
 * `a/**` matches `a`, `a/b`, and `a/b/c` — a directory glob covers the directory itself, which is
 * what someone writing `apps/web/**` means.
 *
 * Normalization happens before either a glob or a candidate path is split into segments, so a
 * differently-spelled but identical path still matches:
 *   - `\` is treated as `/` first. `git diff --name-only` always emits `/`-separated paths per git's
 *     own convention regardless of OS, but `--hotfix --files` takes raw human input, and this repo
 *     runs on Windows, where copying a path from Explorer or PowerShell tab-completion routinely
 *     produces backslashes.
 *   - `path.posix.normalize()` then collapses redundant `.`/`//` segments (round G1 / A3 originally
 *     stripped only a single leading `./`; review pass 1 / W1 found that special-cased exactly the
 *     two spellings its own fuzz table happened to name and nothing else — `.//x`, `././x`, and the
 *     backslash equivalents of both still evaded `hotfix_barred_paths` after the round G1 fix,
 *     because `.//x` and `././x` are not "a single leading `./`". `posix.normalize` is a real
 *     path-segment resolver, not a second special case: it closes the general class this was always
 *     meant to close, not merely the two spellings review round 1 happened to test.
 *     `posix.normalize('')` is `'.'`, never reached here since every real candidate/glob is non-empty.)
 * Both are applied to the glob and the candidate path identically, so the normalization can never
 * itself create or remove a match a byte-for-byte identical pair of strings wouldn't already have.
 */
function normalizeForMatch(value) {
  return posix.normalize(value.replace(/\\/g, '/'));
}

function splitSegments(value) {
  return normalizeForMatch(value).split('/');
}

/**
 * Matches one path segment (no `/`) against one glob segment (no `/`; may contain literal
 * characters and `*`). Deliberately not built on RegExp — see `globMatches`'s comment for why.
 *
 * This is the classic two-pointer "greedy star" wildcard-match algorithm (the same shape underlying
 * glibc's `fnmatch` and most shell-glob implementations): walk both strings left to right; on a
 * literal mismatch with no star seen yet, fail; on a star, remember where it was and, on a later
 * mismatch, retry by growing what that star consumes one character at a time. Worst case is
 * O(segment-length^2) — polynomial, because only one star's position is ever being retried at a
 * time — never the exponential blowup a regex engine's own backtracking produces once several
 * unanchored quantifiers can each explain the same characters (see `globMatches`). Comparing
 * characters directly also means nothing here is ever treated as a metacharacter: `a+b`, `x(1).ts`,
 * and any Unicode code unit compare by ordinary equality, with nothing to escape and nothing to
 * misinterpret.
 */
function segmentMatches(text, pattern) {
  let ti = 0;
  let pi = 0;
  let starIdx = -1;
  let starMatchIdx = 0;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === '*') {
      starIdx = pi;
      starMatchIdx = ti;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === text[ti]) {
      ti++;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      starMatchIdx++;
      ti = starMatchIdx;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

/**
 * Matches a full candidate path against a full glob, segment by segment.
 *
 * WHY THIS IS A DP OVER SEGMENTS, NOT ONE REGEXP (round G1 / A3 — "the glob matcher is hand-rolled
 * and unfuzzed"):
 * The predecessor built one `RegExp` per glob (translating `**` to `.*` or a slash-anchored group,
 * and `*` to a `[^/]` run) and asked
 * the engine's own backtracking to resolve it. Fuzzing it found a real, reproducible hang: a glob
 * with several unanchored `*`/`**` occurrences in one pattern — even plain `a*a*a*...aZ` within a
 * single segment, no `**` required — matched against a same-shaped, non-matching candidate took
 * upward of 40 SECONDS at well under 100 characters of input. That is classic catastrophic
 * backtracking: a chain of unanchored `.*`/`[^/]*` groups gives the engine an exponential number of
 * ways to partition the same string before it can conclude "no match."
 *
 * No glob in `.sdd/bounds.yml` has that shape today, and that file is git-reviewed config a fenced
 * lane cannot edit (`deny_for_fenced_lanes` denies `.sdd/**`). But the CANDIDATE half of every match
 * this file ever performs is a path, and a path is exactly the thing an ordinary contributor already
 * controls — a filename in their own diff, or a `scripts/ledger-append.mjs --hotfix --files` argument
 * — with no lane restriction on what that filename may be. A hand-rolled matcher on a control path
 * failing safe against a hostile *pattern* is not the only bar to clear: hanging the process outright
 * against a hostile (or merely unlucky) *input* is still a control failure, just an availability one
 * rather than a correctness one, and pr-review / a hotfix eligibility check are exactly the moments a
 * hung process is worst to have. This DP removes the exponential case entirely: matching is bounded
 * by `(glob segments + 1) * (path segments + 1)` cells, each resolved by `segmentMatches` above in
 * polynomial time. There is no input, adversarial or not, this can be made to backtrack indefinitely
 * on.
 *
 * `'**'` as an entire segment (and only then — see `segmentMatches` for why a `**` that is NOT a
 * whole segment, e.g. `a**b`, is deliberately just two ordinary stars) consumes zero or more whole
 * path segments: `dp[i-1][j]` leaves it in place having consumed nothing new, `dp[i][j-1]` grows what
 * it consumes by one segment. That pair of transitions is what makes `apps/web/**` also match the
 * bare path `apps/web` fall straight out of the DP (the "consume zero" transition), with no separate
 * special case the way the regex version needed one.
 */
function globMatches(path, glob) {
  const pathSegments = splitSegments(path);
  const globSegments = splitSegments(glob);
  // dp[i][j]: do the first i glob segments match the first j path segments?
  let prevRow = new Array(pathSegments.length + 1).fill(false);
  prevRow[0] = true;
  for (let i = 1; i <= globSegments.length; i++) {
    const seg = globSegments[i - 1];
    const row = new Array(pathSegments.length + 1).fill(false);
    if (seg === '**') {
      row[0] = prevRow[0];
      for (let j = 1; j <= pathSegments.length; j++) row[j] = prevRow[j] || row[j - 1];
    } else {
      for (let j = 1; j <= pathSegments.length; j++) {
        row[j] = prevRow[j - 1] && segmentMatches(pathSegments[j - 1], seg);
      }
    }
    prevRow = row;
  }
  return prevRow[pathSegments.length];
}

/** Exported (GAP-01) alongside `readBounds` so `scripts/ledger-append.mjs`'s `--hotfix` path can
 * check a touched-file list against `hotfixBarredPaths` using the exact same glob semantics this
 * file's own lane-matching uses — one implementation of "does this path match one of these globs,"
 * not a second matcher written a second way. */
export function matchesAny(path, globs) {
  return globs.some((glob) => globMatches(path, glob));
}

/** Minimal reader for the shape .sdd/bounds.yml actually uses. Kept dependency-free on purpose;
 * if this file's shape outgrows it, add js-yaml rather than growing this.
 *
 * Exported (GAP-01 / security round 6) so `scripts/ledger-append.mjs`'s `--hotfix` path can reuse
 * this exact lane vocabulary and glob-matching logic — imported and called directly, the same
 * "exactly one implementation" convention `ledger-append.mjs` already uses for
 * `build-ledger-index.mjs`'s `writeIndex` — rather than re-parsing `.sdd/bounds.yml` a second,
 * independent way that could silently drift from this one. `.sdd/hotfix.md`'s "who may use it" gate
 * ("anyone on an unfenced (`full`) lane... not available to a fenced contributor") is exactly a
 * question this function's own `lanes` map already answers (a lane other than `full` is fenced); the
 * `hotfixBarredPaths` list below is a second, hotfix-specific gate from that same document's "Honest
 * limits" section and is intentionally NOT the same list as `denyForFenced` above (that one is about
 * who may edit the pipeline's own governance files; this one is about which product-code paths a
 * bypass — which skips the security stage entirely — may never touch, regardless of lane). */
export function readBounds() {
  if (!existsSync(BOUNDS_FILE)) die(`${BOUNDS_FILE} not found`);
  const text = readFileSync(BOUNDS_FILE, 'utf8');
  const lanes = {};
  const denyForFenced = [];
  const hotfixBarredPaths = [];
  let currentLane = null;
  let section = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^lanes:\s*$/.test(line)) { section = 'lanes'; currentLane = null; continue; }
    if (/^deny_for_fenced_lanes:\s*$/.test(line)) { section = 'deny'; currentLane = null; continue; }
    if (/^hotfix_barred_paths:\s*$/.test(line)) { section = 'hotfixBarred'; currentLane = null; continue; }
    if (/^[a-z_]+:/.test(line)) { section = null; currentLane = null; continue; }

    if (section === 'deny') {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) denyForFenced.push(unquote(item[1]));
      continue;
    }
    if (section === 'hotfixBarred') {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) hotfixBarredPaths.push(unquote(item[1]));
      continue;
    }
    if (section !== 'lanes') continue;

    const laneName = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (laneName) { currentLane = laneName[1]; lanes[currentLane] = []; continue; }

    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && currentLane) lanes[currentLane].push(unquote(item[1]));
  }

  if (Object.keys(lanes).length === 0) die('no lanes parsed from .sdd/bounds.yml');
  return { lanes, denyForFenced, hotfixBarredPaths };
}

function unquote(value) {
  const trimmed = value.trim();
  return trimmed.replace(/^["']|["']$/g, '');
}

function changedFiles(base) {
  try {
    const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const out = execFileSync('git', ['diff', '--name-only', `${mergeBase}..HEAD`], { cwd: REPO, encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    die(`could not compute the changed-file list against "${base}": ${error.message}`);
    return [];
  }
}

/** PL-04 / item 2 (the general defect): the set of flags this CLI recognizes. Anything else in argv
 * fails loudly below, naming itself — an unrecognized token used to just fall through this loop's
 * `if`/`else if` chain untouched, silently doing nothing, which is exactly the shape of bug that let
 * a typo'd flag look like it worked elsewhere in scripts/ (see ledger-append.mjs's `assertKnownFlags`
 * for the same fix applied there). */
const KNOWN_FLAGS = new Set(['--lane', '--base', '--json', '--files']);

function parseArgs(argv) {
  const args = { lane: null, base: null, files: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lane') args.lane = argv[++i];
    else if (arg === '--base') args.base = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--files') { args.files = argv.slice(i + 1); break; }
    else {
      die(
        `unrecognized argument "${arg}" — known flags: ${[...KNOWN_FLAGS].join(', ')} (--files consumes ` +
        'every remaining argument). A typo\'d flag must never look like it worked.',
      );
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lane) die('--lane is required (see .sdd/bounds.yml for the vocabulary)');

  const { lanes, denyForFenced } = readBounds();
  const allow = lanes[args.lane];
  if (!allow) {
    die(`unknown lane "${args.lane}". Known lanes: ${Object.keys(lanes).join(', ')}. ` +
        'Refusing rather than defaulting — a typo must not silently widen a fence.');
  }

  const files = args.files ?? changedFiles(args.base ?? 'main');
  const isFenced = args.lane !== 'full';

  const violations = [];
  for (const file of files) {
    if (isFenced && matchesAny(file, denyForFenced)) {
      violations.push({ path: file, reason: 'governs the rules themselves; never in-bounds for a fenced lane' });
      continue;
    }
    if (!matchesAny(file, allow)) {
      violations.push({ path: file, reason: `outside lane "${args.lane}"` });
    }
  }

  const result = { lane: args.lane, fenced: isFenced, filesChecked: files.length, violations };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (violations.length === 0) {
    process.stdout.write(`In bounds: ${files.length} file(s) all match lane "${args.lane}".\n`);
  } else {
    process.stdout.write(`Out of bounds for lane "${args.lane}" — ${violations.length} of ${files.length} file(s):\n`);
    for (const v of violations) process.stdout.write(`  ${v.path}  (${v.reason})\n`);
    process.stdout.write('\nAn out-of-lane change is not automatically wrong — it needs an explicit\n' +
      'justification in changes.md, which pr-review adjudicates. It is never silently accepted.\n');
  }

  process.exit(violations.length === 0 ? 0 : 1);
}

// Only run as a CLI entry point (GAP-01) — `readBounds`/`matchesAny` are now also imported as a
// library by scripts/ledger-append.mjs's `--hotfix` path, and importing a module must never also
// trigger this file's own argv-driven `main()`/`process.exit()` side effects against the importer's
// own argv. Same guard, same reasoning, as scripts/ledger-append.mjs and scripts/build-ledger-index.mjs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

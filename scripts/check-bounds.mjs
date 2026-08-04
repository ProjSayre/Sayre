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
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BOUNDS_FILE = resolve(REPO, '.sdd/bounds.yml');

function die(message) {
  process.stderr.write(`check-bounds: ${message}\n`);
  process.exit(2);
}

/**
 * Converts one glob to an anchored RegExp.
 *
 * Supported, deliberately minimally: `**` crosses path separators, `*` does not, everything else
 * is literal. No brace expansion, no character classes, no extglob — a lane definition that needs
 * them is a lane definition that has become hard to reason about, which is its own warning.
 *
 * `a/**` matches `a`, `a/b`, and `a/b/c` — a directory glob covers the directory itself, which is
 * what someone writing `apps/web/**` means.
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      const doubled = glob[i + 1] === '*';
      if (doubled) {
        const trailingSlash = glob[i + 2] === '/';
        // `a/**` and `a/**/b`: allow the zero-directory case so the directory itself matches.
        if (trailingSlash) { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  // `apps/web/**` should also match the bare path `apps/web`.
  if (glob.endsWith('/**')) {
    const base = globToRegExpSource(glob.slice(0, -3));
    return new RegExp(`^(?:${out}|${base})$`);
  }
  return new RegExp(`^${out}$`);
}

function globToRegExpSource(glob) {
  return globToRegExp(glob).source.replace(/^\^|\$$/g, '');
}

function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Minimal reader for the shape .sdd/bounds.yml actually uses. Kept dependency-free on purpose;
 * if this file's shape outgrows it, add js-yaml rather than growing this. */
function readBounds() {
  if (!existsSync(BOUNDS_FILE)) die(`${BOUNDS_FILE} not found`);
  const text = readFileSync(BOUNDS_FILE, 'utf8');
  const lanes = {};
  const denyForFenced = [];
  let currentLane = null;
  let section = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (/^lanes:\s*$/.test(line)) { section = 'lanes'; currentLane = null; continue; }
    if (/^deny_for_fenced_lanes:\s*$/.test(line)) { section = 'deny'; currentLane = null; continue; }
    if (/^[a-z_]+:/.test(line)) { section = null; currentLane = null; continue; }

    if (section === 'deny') {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) denyForFenced.push(unquote(item[1]));
      continue;
    }
    if (section !== 'lanes') continue;

    const laneName = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (laneName) { currentLane = laneName[1]; lanes[currentLane] = []; continue; }

    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && currentLane) lanes[currentLane].push(unquote(item[1]));
  }

  if (Object.keys(lanes).length === 0) die('no lanes parsed from .sdd/bounds.yml');
  return { lanes, denyForFenced };
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

function parseArgs(argv) {
  const args = { lane: null, base: null, files: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lane') args.lane = argv[++i];
    else if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--files') { args.files = argv.slice(i + 1); break; }
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

main();

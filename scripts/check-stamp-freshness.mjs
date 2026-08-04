#!/usr/bin/env node
// Mechanically answers the one question `scripts/pipeline-contracts.mjs`'s `stampFreshness` exists to
// answer — "is this sidecar's `stamp` still current against the tree right now?" — for whichever stage
// needs it to decide whether to flag (every "trusted-fresh" input, per `.sdd/pipeline.md`'s "Staleness
// stamps" section) or refuse (`security`, and only `security`, on `review.json`). Committed as a script
// rather than an instruction to "compare it yourself" for the same reason `scripts/write-stamp.mjs`
// and `check-red-integrity.mjs` are: `stampFreshness` compares a recorded `treeHash` against
// `computeTreeHash()` computed *right now*, and an agent cannot reproduce that SHA-256 tree hash by
// reading a file.
//
// Usage:
//   node scripts/check-stamp-freshness.mjs <spec.json|red.json|changes.json|review.json|security.json>
//   node scripts/check-stamp-freshness.mjs <sidecar> --dir <path>
//   node scripts/check-stamp-freshness.mjs <sidecar> --cwd <path>
//
// `--dir` (same convention as `check-red-integrity.mjs`'s own `--dir`) points this at a directory
// other than `.pipeline/` to find `<sidecar>` in — e.g. a committed `.sdd/ledger/<run-id>/` copy.
// `--cwd` overrides the working tree the *current* tree hash is computed against (defaults to this
// script's own real repo root, exactly like `write-stamp.mjs`'s own `--cwd`) — kept independent of
// `--dir` on purpose: the sidecar can be read from an archived location while the freshness question
// it answers is still "relative to the live tree," which is what every real caller wants; a test
// fixture is the one case that wants both pointed at the same throwaway location (see
// scripts/check-stamp-freshness.test.mjs).
//
// Exit codes:
//   `0` — not stale. `status` is one of:
//     - `"fresh"` — the stamp's recorded `treeHash` matches the tree right now.
//     - `"unknown"` — the sidecar exists but has no `stamp` field at all (written before this contract
//       existed, or by a stage not yet wired to attach one). Never conflated with `"fresh"` — see
//       `pipeline-contracts.mjs`'s own `stampFreshness` comment for why "no signal" must not read as
//       "trustworthy" — but also not `"stale"`: there is nothing to compare, so nothing to refuse on.
//     - `"absent"` — `<sidecar>` does not exist in `<dir>` at all. A different question from
//       staleness (each stage's own "Required inputs" step already covers a missing artifact);
//       reported here rather than treated as an error so a caller can distinguish "checked, nothing to
//       report" from "the check itself failed."
//   `1` — `status` is `"stale"`: the stamp's recorded `treeHash` no longer matches the tree right now.
//     This is the one exit code `.sdd/stages/security.md`'s refusal is keyed off of.
//   `2` — the check could not be performed at all: an unrecognized sidecar name, an unrecognized flag,
//     `--dir`/`--cwd` with no value, or a sidecar that exists but fails its own strict JSON/shape
//     validation (`scripts/pipeline-contracts.mjs`) — a finding about the tooling or the invocation,
//     never silently folded into "0 = fine" or "1 = stale" (the same 1-is-a-finding/2-is-an-error split
//     `scripts/check-bounds.mjs`'s own header already documents).
//
// Output shape (stdout, JSON first, then a plain summary line — same convention as
// check-red-integrity.mjs): `{ "file": "review.json", "dir": ".pipeline", "status": "fresh" | "stale" | "unknown" | "absent" }`

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAMP_FRESH,
  STAMP_STALE,
  readChangesJson,
  readRedJson,
  readReviewJson,
  readSecurityJson,
  readSpecJson,
  stampFreshness,
} from './pipeline-contracts.mjs';

const scriptsDir = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(scriptsDir, '..');

/** One reader per sidecar this contract covers — deliberately the same five names
 * `.sdd/pipeline.md`'s "Staleness stamps" section lists, no more. `required: false` throughout: an
 * absent file is this script's own `"absent"` status, not a thrown error, and a `red.json`/
 * `changes.json` that legitimately doesn't exist yet (a ticket predating `red`, a re-invocation with
 * no dev pass yet) must read the same way. */
const READERS = {
  'spec.json': (dir) => readSpecJson(dir, { required: false }),
  'red.json': (dir) => readRedJson(dir, { required: false }),
  'changes.json': (dir) => readChangesJson(dir, { required: false }),
  'review.json': (dir) => readReviewJson(dir, { required: false }),
  'security.json': (dir) => readSecurityJson(dir, { required: false }),
};

function parseArgs(argv) {
  let file = null;
  let dir = null;
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir' || arg === '--cwd') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a path value (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}) — a typo'd flag must never look like it worked.`);
      }
      if (arg === '--dir') dir = value; else cwd = value;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unrecognized argument "${arg}" — known flags: --dir <path>, --cwd <path>. A typo'd flag must never look like it worked.`);
    }
    if (file !== null) {
      throw new Error(`unexpected extra argument "${arg}" — this script takes exactly one sidecar name plus optional --dir <path>/--cwd <path>.`);
    }
    file = arg;
  }
  if (!file) {
    throw new Error(`missing required argument: which sidecar to check — one of ${Object.keys(READERS).join(', ')}.`);
  }
  if (!READERS[file]) {
    throw new Error(`unrecognized sidecar "${file}" — known sidecars: ${Object.keys(READERS).join(', ')}.`);
  }
  return { file, dir, cwd };
}

function main() {
  const { file, dir, cwd } = parseArgs(process.argv.slice(2));
  const sidecarDir = dir ? resolve(repoRoot, dir) : join(repoRoot, '.pipeline');
  const dirLabel = dir ? dir.replace(/[/\\]+$/, '') : '.pipeline';
  const treeCwd = cwd ? resolve(cwd) : undefined;

  const sidecarPath = join(sidecarDir, file);
  if (!existsSync(sidecarPath)) {
    const report = { file, dir: dirLabel, status: 'absent' };
    console.log(JSON.stringify(report, null, 2));
    console.log(`check-stamp-freshness: ${dirLabel}/${file} does not exist — not a staleness question; see the stage's own Required inputs check.`);
    return;
  }

  const parsed = READERS[file](sidecarDir); // throws SidecarError on malformed JSON/shape — caught below, exit 2
  const status = stampFreshness(parsed.stamp, treeCwd);
  const report = { file, dir: dirLabel, status };
  console.log(JSON.stringify(report, null, 2));

  if (status === STAMP_STALE) {
    process.stderr.write(`check-stamp-freshness: ${dirLabel}/${file}'s stamp is STALE — the tree has moved on since it was written.\n`);
    process.exit(1);
  }
  const summary = status === STAMP_FRESH
    ? 'is fresh'
    : 'has no stamp (written before this contract existed, or by a stage not yet wired to attach one) — treated as not-stale, never as fresh';
  console.log(`check-stamp-freshness: ${dirLabel}/${file} ${summary}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`check-stamp-freshness: ${error.message}\n`);
    process.exit(2);
  }
}

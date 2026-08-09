#!/usr/bin/env node
// Attaches (or refreshes) the shared `stamp` field on an already-written `.pipeline/*.json` sidecar —
// PL-04 review pass 1 / Blocker 1: `scripts/pipeline-contracts.mjs` exported `buildStamp`/
// `stampFreshness` and every stage file's own "Exact shape" output contract promised a `stamp` field,
// but nothing in the repo ever called `buildStamp` outside a test. Every sidecar on disk therefore had
// no `stamp` key at all, `stampFreshness` could only ever return `STAMP_UNKNOWN`, and
// `.sdd/stages/security.md`'s "refuse on a stale `review.json`" promise — the one place
// `.sdd/pipeline.md`'s three-way staleness policy is supposed to produce a refusal rather than a flag —
// could never fire. Two independent groups each built one half (the reader, the consumption policy)
// and each assumed the other had built the producer; neither had.
//
// Usage:
//   node scripts/write-stamp.mjs <path-to-sidecar.json>
//   node scripts/write-stamp.mjs <path-to-sidecar.json> --cwd <path>
//
// Every stage that writes one of the five `.pipeline/*.json` sidecars (`spec.json`, `red.json`,
// `changes.json`, `review.json`, `security.json` — see `.sdd/pipeline.md`'s "Staleness stamps"
// section and each `.sdd/stages/*.md` file's own "Exact shape") writes every stage-specific field
// itself, then runs this script as its own last step for that file. This is deliberately a committed
// script rather than an instruction telling the stage to compute the stamp itself: `buildStamp`
// (`scripts/pipeline-contracts.mjs`) hashes `git diff HEAD` plus every untracked file's own bytes — an
// agent cannot reliably reproduce a SHA-256 digest of the current working tree by writing JSON, for
// exactly the same reason `check-red-integrity.mjs` exists as a committed script rather than an
// instruction to "rehash the file yourself."
//
// What this does: reads `<path>` (must already exist, and already be valid, strictly-parsed JSON — see
// `parseJsonOrThrow` — and a JSON object at the top level), computes a fresh `buildStamp()` against the
// current working tree, sets/overwrites the object's own `stamp` field with it, and writes the file
// back in place — parsed and re-serialized (two-space indent, trailing newline, matching every other
// JSON writer in this codebase), not text-patched, so every other field the stage already wrote is
// preserved exactly, and any pre-existing (stale) `stamp` is fully replaced rather than merged.
//
// `--cwd <path>` overrides the working tree `buildStamp` computes against — every real invocation
// omits it and gets this script's own real repo root (the default `scripts/pipeline-contracts.mjs`'s
// `buildStamp` already uses), the same tree the sidecar itself lives in. It exists so a test fixture
// (or, in principle, a caller running this script against a checkout other than the one it physically
// lives in) can point the tree-hash computation at a specific git working tree without moving the
// sidecar file itself — see scripts/write-stamp.test.mjs.
//
// Exit 0 on success, printing the sidecar path and a summary of the stamp just written. Exit 1 (a
// `write-stamp: <message>` line on stderr) if `<path>` is missing, unreadable, not valid JSON, not a
// JSON object at the top level, or argv doesn't parse to exactly one path plus an optional `--cwd
// <path>` — a typo'd invocation must never look like it silently did nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStamp, parseJsonOrThrow, requireObject } from './pipeline-contracts.mjs';

/** Reads, stamps, and rewrites the sidecar at `path` (an absolute or already-resolved path) in place.
 * Exported so scripts/write-stamp.test.mjs can call it directly, and so any future script that needs
 * "write a stamp onto this exact file" as a step of its own can reuse this rather than re-implementing
 * the read/merge/rewrite shape. Throws a plain `Error` (never calls `process.exit` itself) on any
 * failure, so a caller — this file's own `main()`, or a test — decides how to report it.
 *
 * @param {string} path
 * @param {{ cwd?: string }} [options] `cwd` is passed straight through to `buildStamp` — see this
 *   file's own header for `--cwd`'s reasoning. Annotated explicitly (matching every other
 *   destructuring-default options parameter in this codebase — see e.g. ledger-append.mjs's
 *   `assertKnownFlags`) because plain JS inference from a destructuring default with no default value
 *   for `cwd` itself would otherwise infer `{}`, not `{ cwd?: string }`, and flag every real caller
 *   that passes `{ cwd: ... }` as an unknown property. */
export function attachStamp(path, { cwd } = {}) {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist. The stage must write its sidecar's own fields first, then run this script as its last step for that file.`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = parseJsonOrThrow(raw, path); // throws on invalid/duplicate-key JSON — see pipeline-contracts.mjs
  const obj = requireObject(parsed, path); // throws if the sidecar's top level isn't a JSON object
  const stamp = buildStamp(cwd);
  obj.stamp = stamp;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return stamp;
}

/** PL-04 / item 2's "a typo'd flag must never look like it worked" invariant, applied here: anything
 * other than exactly one non-flag path argument, optionally followed by `--cwd <path>`, throws naming
 * itself, rather than silently taking the first token and ignoring the rest. */
function parseArgs(argv) {
  let path = null;
  let cwd = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--cwd requires a path value (got ${value === undefined ? '(nothing)' : JSON.stringify(value)}) — a typo'd flag must never look like it worked.`);
      }
      cwd = value;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unrecognized argument "${arg}" — known flags: --cwd <path>. A typo'd flag must never look like it worked.`);
    }
    if (path !== null) {
      throw new Error(`unexpected extra argument "${arg}" — this script takes exactly one path argument (the sidecar to stamp) plus an optional --cwd <path>.`);
    }
    path = arg;
  }
  if (!path) {
    throw new Error('missing required argument: the path to the .pipeline/*.json sidecar to stamp. Usage: node scripts/write-stamp.mjs <path-to-sidecar.json>');
  }
  return { path, cwd };
}

function main() {
  const { path, cwd } = parseArgs(process.argv.slice(2));
  const resolvedPath = resolve(path);
  const stamp = attachStamp(resolvedPath, { cwd: cwd ? resolve(cwd) : undefined });
  console.log(`write-stamp: wrote stamp to ${path} (treeHash ${stamp.treeHash.slice(0, 12)}…, headSha ${stamp.headSha}, dirty ${stamp.dirty}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // attachStamp/parseArgs throw a plain Error (or parseJsonOrThrow's SidecarError) on any failure —
    // this catch turns that into one clean, prefixed message and exit 1, instead of a raw Node stack
    // trace, matching every other CLI script in this directory.
    process.stderr.write(`write-stamp: ${error.message}\n`);
    process.exit(1);
  }
}

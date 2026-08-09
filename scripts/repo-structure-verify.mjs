#!/usr/bin/env node
// PL-15 (repo restructure) — the RED-DEFERRED half of the red suite.
//
// Authored by `red` from .pipeline/spec.md, alongside scripts/repo-structure.test.mjs. That file
// holds every spec item this checkout can assert cheaply and in-process. This file holds the items
// that are commands rather than assertions: a clean `npm ci`, the full AC-15 verification matrix,
// the cross-workspace turbo runs, and the two dashboard reads no repo diff can perform.
//
// WHY THIS IS NOT A *.test.mjs FILE. Two reasons, both structural:
//   1. scripts/sdd-completeness.test.mjs enumerates every scripts/*.test.mjs and requires each to
//      have a package.json "test:*" script AND a CI step. A clean `npm ci` plus a full matrix run
//      per CI job is precisely the duplication CI already performs natively, step by step — wiring
//      it as a suite would run everything twice.
//   2. Several items here have Executor: Human (AC-16, AC-17). A suite that can never pass
//      unattended is a suite people learn to ignore.
// So this is a runner a human or `tester` invokes deliberately:
//
//   node scripts/repo-structure-verify.mjs              # run the runnable matrix, report the rest
//   node scripts/repo-structure-verify.mjs --list       # print the matrix without running anything
//   node scripts/repo-structure-verify.mjs --skip-ci    # everything except the slow clean `npm ci`
//   node scripts/repo-structure-verify.mjs --only=site  # re-run just the items whose id matches
//
// Exit code: 0 when every RUNNABLE command passed, 1 when any failed or could not run. The MANUAL
// items never affect the exit code — they are reported, loudly, and must be recorded in the PR
// description per AC-16/AC-17. "Not run, with the reason" is a required outcome (AC-15), never
// silently folded into a pass.
//
// @spec AC-3 AC-14 AC-15 AC-16 AC-17 EC-1 EC-2 EC-3 EC-10 EC-23 EC-24

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const argv = process.argv.slice(2);
const args = new Set(argv);
const LIST_ONLY = args.has('--list');
const SKIP_CI = args.has('--skip-ci');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

/** @type {{ id: string, spec: string, argv: string[], note?: string, slow?: boolean }[]} */
const RUNNABLE = [
  // AC-3 / EC-1 — the lockfile must actually satisfy the split manifests. The static half of this
  // (the lockfile records `sayre`, has an apps/site entry, and its root entry declares no runtime
  // dependencies) is asserted in scripts/repo-structure.test.mjs; only a real clean install proves
  // it end to end, and only a real clean install reproduces CI's own first failure mode.
  { id: 'npm ci', spec: 'AC-3 EC-1 AC-15', argv: [NPM, 'ci'], slow: true },

  // AC-15 — every command CI runs, in CI's order.
  { id: 'check:secret-access', spec: 'AC-15 EC-11', argv: [NPM, 'run', 'check:secret-access'] },
  { id: 'test:secret-access', spec: 'AC-15', argv: [NPM, 'run', 'test:secret-access'] },
  { id: 'check:org-secret-access', spec: 'AC-15', argv: [NPM, 'run', 'check:org-secret-access'] },
  { id: 'test:org-secret-access', spec: 'AC-15', argv: [NPM, 'run', 'test:org-secret-access'] },
  { id: 'site build', spec: 'AC-4 AC-15', argv: [NPM, 'run', 'build', '--workspace', '@sayre/site'] },
  { id: 'check:agent-shims', spec: 'AC-15', argv: [NPM, 'run', 'check:agent-shims'] },
  { id: 'test:agent-shims', spec: 'AC-15', argv: [NPM, 'run', 'test:agent-shims'] },
  { id: 'test:sdd-completeness', spec: 'AC-15 EC-8', argv: [NPM, 'run', 'test:sdd-completeness'] },
  { id: 'check:agent-ignore', spec: 'AC-15', argv: [NPM, 'run', 'check:agent-ignore'] },
  { id: 'test:agent-ignore', spec: 'AC-15', argv: [NPM, 'run', 'test:agent-ignore'] },
  { id: 'check:ledger-index', spec: 'AC-15 EC-12', argv: [NPM, 'run', 'check:ledger-index'] },
  { id: 'test:ledger-index', spec: 'AC-15', argv: [NPM, 'run', 'test:ledger-index'] },
  { id: 'test:ledger-append', spec: 'AC-15', argv: [NPM, 'run', 'test:ledger-append'] },
  { id: 'test:red-integrity', spec: 'AC-15', argv: [NPM, 'run', 'test:red-integrity'] },
  { id: 'check:security-audit-agents', spec: 'AC-15', argv: [NPM, 'run', 'check:security-audit-agents'] },
  { id: 'test:security-audit-agents', spec: 'AC-15', argv: [NPM, 'run', 'test:security-audit-agents'] },
  { id: 'test:security-audit-run', spec: 'AC-15', argv: [NPM, 'run', 'test:security-audit-run'] },
  { id: 'test:pipeline-contracts', spec: 'AC-15', argv: [NPM, 'run', 'test:pipeline-contracts'] },
  { id: 'test:write-stamp', spec: 'AC-15', argv: [NPM, 'run', 'test:write-stamp'] },
  { id: 'test:stamp-freshness', spec: 'AC-15', argv: [NPM, 'run', 'test:stamp-freshness'] },
  { id: 'test:bounds', spec: 'AC-15 EC-13', argv: [NPM, 'run', 'test:bounds'] },
  { id: 'test:lite-eligible', spec: 'AC-15', argv: [NPM, 'run', 'test:lite-eligible'] },
  { id: 'test:readonly-guard', spec: 'AC-15 EC-9', argv: [NPM, 'run', 'test:readonly-guard'] },
  { id: 'test:dependency-baseline', spec: 'AC-15 EC-10', argv: [NPM, 'run', 'test:dependency-baseline'] },
  { id: 'test:dependency-install', spec: 'AC-15', argv: [NPM, 'run', 'test:dependency-install'], slow: true },
  { id: 'typecheck:scripts', spec: 'AC-15 AC-7', argv: [NPM, 'run', 'typecheck:scripts'] },
  { id: 'config typecheck', spec: 'AC-15', argv: [NPM, 'run', 'typecheck', '--workspace', '@sayre/config'] },
  { id: 'config test', spec: 'AC-15', argv: [NPM, 'test', '--workspace', '@sayre/config'] },
  { id: 'web lint', spec: 'AC-15 AC-18', argv: [NPX, 'turbo', 'run', 'lint', '--filter=@sayre/web'] },
  { id: 'web typecheck', spec: 'AC-15 AC-18', argv: [NPX, 'turbo', 'run', 'typecheck', '--filter=@sayre/web'] },
  { id: 'web test', spec: 'AC-15 AC-18', argv: [NPX, 'turbo', 'run', 'test', '--filter=@sayre/web'] },
  { id: 'gateway lint', spec: 'AC-15', argv: [NPX, 'turbo', 'run', 'lint', '--filter=@sayre/gateway'] },
  { id: 'gateway typecheck', spec: 'AC-15', argv: [NPX, 'turbo', 'run', 'typecheck', '--filter=@sayre/gateway'] },
  { id: 'gateway test', spec: 'AC-15', argv: [NPX, 'turbo', 'run', 'test', '--filter=@sayre/gateway'] },
  { id: 'core lint', spec: 'AC-15', argv: [NPX, 'turbo', 'run', 'lint', '--filter=@sayre/core'] },
  { id: 'core typecheck', spec: 'AC-15', argv: [NPX, 'turbo', 'run', 'typecheck', '--filter=@sayre/core'] },
  { id: 'root tsc --noEmit', spec: 'AC-15 AC-5', argv: [NPX, 'tsc', '--noEmit'] },

  // EC-23 — apps/site joins the apps/* glob, so these now sweep the new workspace too. @sayre/site
  // declares no lint or test script; turbo skips a missing task rather than failing, but that is the
  // claim under test, not an assumption.
  { id: 'test:workspaces', spec: 'EC-23', argv: [NPM, 'run', 'test:workspaces'], slow: true },
  { id: 'lint:workspaces', spec: 'EC-23', argv: [NPM, 'run', 'lint:workspaces'], slow: true },

  // EC-15 — `npm run workspace-pack` resolves vite-node purely by hoisting; removing vite from the
  // root devDependencies must not break it. Only that it STARTS is under test.
  { id: 'workspace-pack starts', spec: 'EC-15', argv: [NPM, 'run', 'workspace-pack', '--', '--help'] },

  // AC-14 / EC-10 — the declared red-test change. This is the committed tool that decides it; it
  // cannot pass until `dev` has written .pipeline/changes.json, which is why it is deferred here
  // rather than asserted in the test suite (and .pipeline/ is gitignored, so CI could never run it).
  { id: 'check:red-integrity', spec: 'AC-14 EC-10', argv: [NPM, 'run', 'check:red-integrity'] },
];

/** Items no command in this repository can settle. Reported, never counted as passing. */
const MANUAL = [
  {
    id: 'AC-16 / EC-2 / EC-24 — Cloudflare Pages dashboard',
    what: [
      'Cloudflare Pages -> account 9b15e5f5... -> project `sayre` -> Settings -> Builds & deployments.',
      'Record VERBATIM into the PR description: Root directory, Build command, Build output directory.',
      'Compatible with the PL-15 shim means: root directory `/` or empty; build command resolving to',
      'root `npm run build` (or `npm run build --workspace @sayre/site`); output directory `dist`.',
      'If any of the three is incompatible: DO NOT MERGE — extend the shim or change the dashboard in',
      'the same merge window, and say in the PR which was done (EC-2).',
      'Then: the `Cloudflare Pages` check on the PR is green, and after merge sayre.pages.dev serves',
      'the site INCLUDING /privacy (EC-16 is what makes that route resolve).',
      'While reading the build log, note any EBADENGINE warning from @sayre/site\'s',
      'engines.node ">=20 <21" — harmless without engine-strict, but record it (EC-24).',
      'Do NOT touch the separate Cloudflare Workers project on account 791596... — that is PL-09, and',
      'the GitHub App installation is shared with Pages.',
    ],
  },
  {
    id: 'AC-17 / EC-3 — Vercel dashboard',
    what: [
      'Determine whether a live Vercel project is connected to this repository.',
      'Record the answer in the PR description, and if one exists, its Root Directory setting.',
      'vercel.json is byte-unchanged by this ticket either way (asserted in repo-structure.test.mjs);',
      'if a live project has Root Directory `/`, vercel.json must stay at the repo root (EC-3).',
      'The answer feeds deferred item D3 in docs/repo-structure.md.',
    ],
  },
  {
    id: 'AC-15 — environment-gated CI jobs',
    what: [
      'These are part of CI but cannot run in a plain checkout; report them as NOT RUN with the reason,',
      'never as passing:',
      '  - `@sayre/core` test suites gated on Docker/Postgres/Redis (npm run test --workspace @sayre/core,',
      '    test:rls:ci, test:rls:acceptance:ci, test:rls:jira:ci, the messaging Redis-required step).',
      '  - the Python `workers` job (poetry run pytest from services/workers/), which needs the Poetry',
      '    environment: Python 3.12 plus Tree-sitter native grammars.',
    ],
  },
];

function line(char = '-') {
  return char.repeat(78);
}

function printMatrix() {
  console.log(line('='));
  console.log('PL-15 deferred verification matrix');
  console.log(line('='));
  for (const item of RUNNABLE) {
    console.log(`  [runnable${item.slow ? ', slow' : ''}] ${item.id}  (${item.spec})`);
    console.log(`      $ ${item.argv.join(' ')}`);
  }
  for (const item of MANUAL) {
    console.log(`  [MANUAL]   ${item.id}`);
    for (const l of item.what) console.log(`      ${l}`);
  }
}

function run(item) {
  const [command, ...rest] = item.argv;
  const started = Date.now();
  const r = spawnSync(command, rest, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (r.error) return { ok: false, seconds, detail: `could not run: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
    return { ok: false, seconds, detail: `exit ${r.status}\n${tail}` };
  }
  return { ok: true, seconds, detail: '' };
}

if (LIST_ONLY) {
  printMatrix();
  process.exit(0);
}

const failures = [];
const selected = ONLY ? RUNNABLE.filter((item) => item.id.includes(ONLY)) : RUNNABLE;
if (ONLY && selected.length === 0) {
  console.error(`--only=${ONLY} matched no item. Run with --list to see the matrix.`);
  process.exit(1);
}
for (const item of selected) {
  if (SKIP_CI && item.id === 'npm ci') {
    console.log(`SKIPPED  ${item.id} (--skip-ci) — NOT RUN, not passing`);
    continue;
  }
  process.stdout.write(`RUNNING  ${item.id} ... `);
  const result = run(item);
  console.log(result.ok ? `ok (${result.seconds}s)` : `FAILED (${result.seconds}s)`);
  if (!result.ok) failures.push(`${item.id} (${item.spec})\n${result.detail}`);
}

console.log(`\n${line('=')}`);
console.log('MANUAL items — no repo diff can settle these; record them in the PR description');
console.log(line('='));
for (const item of MANUAL) {
  console.log(`\n${item.id}`);
  for (const l of item.what) console.log(`  ${l}`);
}

console.log(`\n${line('=')}`);
if (failures.length > 0) {
  console.log(`${failures.length} runnable check(s) failed:\n`);
  for (const f of failures) console.log(`${f}\n${line()}`);
  process.exit(1);
}
console.log('All runnable checks passed. The MANUAL items above are still outstanding.');
process.exit(0);

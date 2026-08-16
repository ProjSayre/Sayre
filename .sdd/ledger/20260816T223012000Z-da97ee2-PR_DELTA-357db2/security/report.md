# Security audit report — PL-CI-QUAL

## Verdict

PASS

## Run and baseline

- **Run ID:** 20260816T223012000Z-da97ee2-PR_DELTA-357db2
- **Mode:** PR_DELTA
- **Commit:** da97ee2ed2b435e849fc407eb08d4be528eb8564 (dirty)
- **Branch:** pipeline-changes-quick-trim
- **Environment:** local-static-analysis
- **Milestone / phase:** pre-MVP / pipeline-methodology-refactor (`docs/product/Pipeline-Efficiency-Plan.md`)
- **Baseline:** 20260814T040900000Z-da97ee2-PR_DELTA-f1b0ef (PL-FIXBRIEF; comparable: false — dirty-delta / ticket-scope, same reasoning that run itself used against its own predecessor)
- **Artifacts:** `.pipeline/security-history/20260816T223012000Z-da97ee2-PR_DELTA-357db2/`
- **Ticket:** PL-CI-QUAL — the 4th and final ticket of the Pipeline Efficiency Plan (PL-TRIM, PL-INTEGRITY-TESTER, PL-FIXBRIEF already shipped on this branch). Meta-tooling only: a new red-test quality/anti-dupe gate (`scripts/check-red-quality.mjs`) wired into CI/tester, a JSON-sidecar `requiredNonEmpty` findings-enforcement fix, a `requireFindingId` message fix, a CI-breaking test-guard fix, and doc/prose corrections. No product code (`apps/**`, `services/**`) touched — confirmed by `git diff --stat` and `git status`.

## Scope framing

Per this ticket's own spec.md (Scope → Out) and the task brief: this diff never touches `org_id`,
tenant persistence, the Graph Query Service, RBAC, webhook receivers, ingestion scratch clones, or any
product/user-facing surface. Accordingly:

- **CORE-01 (tenant isolation)** and **CORE-02 (RBAC boundary)** — the two mandatory, always-blocking
  checks — are **NOT_APPLICABLE**: no executable boundary of either kind exists anywhere in this diff.
  Said explicitly per this stage's own instruction to state plainly when most of the standard
  attacker-brief surface doesn't apply, rather than forcing an irrelevant check.
- **CORE-04 (webhook trust)** and **CORE-05 (data ephemerality)** — also **NOT_APPLICABLE**, same reason.
- **CORE-03 (secrets)** and **CORE-06 (injection boundaries)** — genuinely relevant (this diff adds a
  script that shells out to `git` and parses file text, and a script that adds CI/npm wiring) — run in
  full, **PASS**.
- Two registry surfaces are triggered by path (`scripts/**`, `.github/**`, `package.json`):
  **secrets-audit-data-lifecycle** and **supply-chain-infrastructure** — run in full below.
- The other six registry surfaces (llm-rag, model-provider, mcp, websocket-realtime,
  ingestion-queue-webhook, web-api-client) are **not triggered** — no changed path matches their
  `trigger_paths`, and none is examined beyond that routing decision, per the audit contract's
  "selected check that cannot run is UNVERIFIED, not omitted" only applying to a *selected* check —
  these are correctly unselected, not silently skipped.

## Security trajectory

- New findings: none
- Regressed findings: none
- Persisting findings: none
- Resolved findings: none
- Risk-accepted findings: none

## Coverage trajectory

- All 34 selected checks observed (CORE-01..06, SEC-01..14, SC-01..14) — one observation row per
  selected checklist ID, none omitted.
- Transitions: NOT_COMPARABLE vs. baseline (same incompatible dirty-delta/ticket-scope reasoning the
  baseline run itself used).
- No LOST coverage on any CRITICAL/HIGH boundary — none of the 34 observations carries a HIGH/CRITICAL
  severity in either this run or the baseline.

## Findings

None.

## The three questions this ticket's task brief specifically asked

1. **Does `check-red-quality.mjs` (or its git invocation) execute anything from the file content it
   parses?** No. `computeGitContext()` (lines 269-279) calls
   `execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repoRoot, ... })` — a fixed
   argv array, never `shell: true`, never a string built from file content, CLI flags, or any other
   untrusted input. Every listed test file is read with `readFileSync(absolutePath, 'utf8')`
   (lines 304-324) and the resulting string is used only as data: `specSegments()` splits it on
   `\r?\n` and a fixed marker regex, and `ASSERTION_PATTERNS`/`TAUTOLOGY_PATTERNS` run `RegExp.test()`
   against it. There is no `eval`, `new Function`, `vm` module usage, `JSON.parse` of a file body as
   code, template-literal interpolation of file content into a shell command, or a second
   `child_process` call keyed off file content anywhere in the module. Read in full; confirmed by line
   number above. **PASS (CORE-06).**
2. **Does the `requiredNonEmpty` enforcement change in `pipeline-contracts.mjs` fail closed?** Yes.
   `parseFindingsArray(rawFindings, label, { requiredNonEmpty })` (diff lines ~466-481) calls `fail(...)`
   — which `throw`s a `SidecarError` (line ~115) — whenever `requiredNonEmpty` is true and `findings`
   is `undefined` or resolves to a `[]` array; there is no code path that logs-and-continues or
   defaults to an empty array in that case. `readReviewJson`/`readSecurityJson` now parse `verdict`
   *before* `findings` and pass `{ requiredNonEmpty: verdict !== 'PASS' }` (confirmed by reading the
   diff directly), so a `NEEDS_FIXES` `review.json` or `BLOCKED` `security.json` with missing/empty
   `findings` throws at the parser layer. Traced every caller of both functions
   (`write-fix-brief.mjs`, `check-stamp-freshness.mjs`, `ledger-append.mjs`): `write-fix-brief.mjs`
   catches `SidecarError` and converts it to `failRefuse` -> exit `1` (refuse to write a brief);
   `check-stamp-freshness.mjs`'s `main()` is wrapped in a top-level `try/catch` that converts any
   thrown error to exit `2` ("the check itself failed" — this stage's own contract already treats that
   as "cannot verify freshness, refuse rather than guess," not as a pass); `ledger-append.mjs` only
   calls either reader on an already-confirmed terminal `PASS` path, where `requiredNonEmpty` is always
   `false`, so the ledger's normal happy path is unaffected. No caller swallows the exception and
   proceeds as if `findings` were valid. **Fails closed, not open. PASS (folded into CORE-06/CORE-03 —
   see Limitations below for why this doesn't carry its own registry check_id).**
3. **Does the fix-loop `allowedPaths`/red-test carve-out create a scope-escape path?** No new one.
   `scripts/write-fix-brief.mjs`'s `allowedPaths` computation (`allowedPathsFrom(findings,
   affectedFiles)`, the intersection of finding paths and `spec.json`'s `affectedFiles`) is
   byte-for-byte unchanged by this diff — only a header comment was added, confirmed by reading the
   full file (it is untracked/new on this branch, so `git diff` shows nothing to diff against; read in
   full instead). The actual gate that would catch scope abuse — `scripts/check-red-integrity.mjs`'s
   hash-rehash loop, which treats a red-listed test file whose content changed with no matching
   `changes.json` `redTestChanges` declaration as a **blocking** violation
   (`check-red-integrity.mjs:217-220`, `isDeclaredInChanges`) — is a file this ticket does not touch at
   all (not in `changes.json`'s `filesChanged`, confirmed). `.sdd/stages/dev.md`'s diff (read in full)
   shows the carve-out text is reconciliation prose only: it names the existing `redTestChanges`
   declaration mechanism as the one legitimate route for a red-test edit outside `allowedPaths`, and
   explicitly restates that an *undeclared* edit still fails tester's integrity check exactly as
   before. This round's own fix-loop attempt used the carve-out live (three declared edits: two red
   test files' fixture-string fix, and `.pipeline/red.json`'s `duplicateOf`/`justification` addition —
   the latter flagged by `review.md`'s W1 as a legitimate-but-imprecisely-worded use, not blocking) —
   independently confirmed against `red-integrity.json`'s `judgments` array and `changes.json`'s
   `redTestChanges` reasons, which match the actual diff. **No escape path beyond what was already
   declared and gated by the pre-existing, unmodified integrity check. PASS (folded into CORE-06).**

## Verified-clean / applicable checks

- **CORE-03 PASS** — no hardcoded/logged secret, no direct `process.env` read, no alternate credential
  path in any file this ticket touches.
- **CORE-06 PASS** — `check-red-quality.mjs`'s git invocation is an argv array, never a shell string;
  file content is read only as regex-matched data, never executed; `pipeline-contracts.mjs`'s new
  validation code is pure value-checking, not string concatenation into an interpreter.
- **SEC-01/02/04/07/08 PASS** — no loader bypass, no hardcoded secret, no content-echoing log line
  beyond file paths/spec-ids/line numbers, no unexpected env/temp-file exposure in the new
  `execFileSync` call, no fork/PR secret exposure from the new CI steps.
- **SC-01/02/04/05/06 PASS** — `package.json` adds script entries only (no new dependency, no lockfile
  change); no install/build lifecycle hook added; `ci.yml`'s new steps add no trigger, permissions, or
  third-party-action change, and interpolate no untrusted event data into a shell command.
- 22 further checks (SEC-03/05/06/09-14, SC-03/07-14, CORE-01/02/04/05) are **NOT_APPLICABLE** with
  inventory evidence — see `results.json` for the full per-check table; every one names the concrete
  absence of the relevant surface in this diff, not a silent skip.

## Limitations

- Static analysis only; runtime tests not authorized (this is local pipeline tooling, not a deployed
  service — a dynamic test plan was never in scope for this class of change).
- Worktree is dirty (PL-TRIM + PL-INTEGRITY-TESTER + PL-FIXBRIEF + PL-CI-QUAL all uncommitted on this
  branch); analysis is against real working-tree file content for this ticket's own paths, cross-checked
  with `git diff --stat`/`git status` to confirm no product path is touched.
- Baseline (`20260814T040900000Z-da97ee2-PR_DELTA-f1b0ef`, PL-FIXBRIEF) is same branch/commit but
  dirty-delta/ticket-scope incompatible — every observation is `NOT_COMPARABLE` rather than a
  fabricated trend line.
- Non-triggered surfaces (llm-rag, model-provider, mcp, websocket-realtime, ingestion-queue-webhook,
  web-api-client) not examined beyond routing — no changed path implicates them.
- `review.json` stamp freshness verified **fresh** (`node scripts/check-stamp-freshness.mjs
  review.json`, exit `0`) before this run began, per this stage's trusted-fresh-refuse-on-stale rule.
- The task brief's second and third specific questions (`requiredNonEmpty` fail-closed behavior; the
  fix-loop carve-out's scope) don't map onto a dedicated registry `check_id` — the audit-results schema
  constrains `check_id` to `^(CORE|LLM|MP|MCPT|WS|ING|WEB|SEC|SC)-[0-9]{2}$`, with no `GAP-*` option,
  so (unlike the report table the audit contract describes) `results.json` cannot carry a `GAP-*` row
  without failing schema validation. Both were folded into the CORE-06/CORE-03 observations' evidence
  above and are additionally documented narratively in the numbered section above, at the level of
  rigor a dedicated finding would get, rather than invented into a nonexistent schema slot.
- `check-red-quality.mjs` (and the pre-existing `check-red-integrity.mjs` it shares a design with)
  reads file paths from `.pipeline/red.json`'s `path`/`extends` fields without path-traversal
  sanitization before `readFileSync`. This is an inherited, **unregressed** design — identical in
  `check-red-integrity.mjs`, which already shipped and was already covered by a prior security run —
  not something this ticket introduces. `.pipeline/red.json` is pipeline-internal state written by
  trusted `red`/`dev` stage invocations in this project's threat model, not external/attacker-facing
  input, so this is noted for completeness rather than raised as a finding or a regression.
- `check-red-quality.mjs`'s own documented false-positive/false-negative limitations (EC-5/EC-6: a
  plain-text scan, not an AST parse) are a test-quality property of the gate's *product* behavior, not
  a security boundary — out of this audit's scope beyond confirming the scan never executes the text
  it matches (covered under CORE-06 above).

## Cleanup

No throwaway fixtures created. Verification consisted of reading files already on disk, running the
project's own `npm run test:*`/`npm run check:*`/`npm run typecheck:scripts` commands against the real
working tree, and one direct `git diff`/`git status`/`grep` sweep — no `mkdtemp` scratch repo, no
mutated `.pipeline/` state, no network call. No repository file outside this run's own
`.pipeline/security-history/20260816T223012000Z-da97ee2-PR_DELTA-357db2/` artifacts was created,
modified, or left behind by this stage.

## Recheck scope

Re-run CORE-03, CORE-06, SEC-01/02/04/07/08, and SC-01/02/04/05/06 if `scripts/check-red-quality.mjs`,
`scripts/pipeline-contracts.mjs`, `scripts/write-fix-brief.mjs`, `package.json`, or
`.github/workflows/ci.yml` change again. Re-run CORE-01/02/04/05 (currently `NOT_APPLICABLE`) in full
if a future change to this ticket's scope touches `apps/**` or `services/**`.

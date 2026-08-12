# Security Audit Report — W0-04 gapfill (GAP-3a/4/4a/5)

Run ID: `20260810T040646000Z-ee496aa498-PR_DELTA-81b52d`
Mode: `PR_DELTA`
Verdict: **PASS**

## 1. Target and environment

- Repository: `projsayre/sayre`, working path `/Users/chiemeka/SayreProjects/Sayre`
- Commit: `ee496aa4985fc4145afbadf34c54de9cf3e9910a`, branch `feat/w0-04-sqs-bullmq-gapfill`, worktree dirty
- Dirty-tree contents re-verified directly (`git status --porcelain -uall`): exactly the 8 modified + 6
  untracked files review.md's re-run already scoped, plus one confirmed-unrelated, pre-existing
  untracked `Documents/PRD/` directory (not in `git diff`, not in `changed_paths`).
- Environment: local-dev checkout. Docker/LocalStack/Redis unreachable (`docker info` fails,
  `redis-cli ping` refused) — same constraint every upstream stage (dev, tester, both review passes)
  hit. No live CI run performed by this stage.
- `review.json` gate: verdict `PASS`, stamp freshness re-checked directly
  (`node scripts/check-stamp-freshness.mjs review.json` → `fresh`, exit 0) before any work began.

## 2. Baseline

No compatible baseline. All six prior runs under `.pipeline/security-history/` have commits that are
git-ancestors of this run's HEAD, but none audited this diff's actual target assets (the BullMQ
lane/priority mechanism, the two new cross-runtime `tsx` harnesses, `vitest.config.ts`'s
`fileParallelism` change, or the new CI messaging/cross-runtime steps). The nearest topically-related
prior observations (20260727 run's `ING-04/05/06` PASS rows against `publishInitialParseEvent`'s
webhook-triggered production path) are a different `target_asset` under the contract's stable-key
rule, so every observation in this run is `FIRST_OBSERVATION`. See `manifest.json`'s `baseline` block
for the full reasoning and the six runs considered.

## 3. Counts

- Results: 21 `PASS`, 0 `FAIL`, 0 `UNVERIFIED`, 40 `NOT_APPLICABLE` (61 total observations)
- Result transitions: 61 `FIRST_OBSERVATION`
- Coverage transitions: 21 `GAINED`, 40 `NOT_COMPARABLE`
- Surface readiness: 14/14 surfaces `IMPLEMENTED` (repo-wide state); this diff itself only touches a
  narrow slice of the `ingestion-queue-webhook` surface plus shared `CORE-*` controls
- Selected surfaces: `tenant-isolation`, `rbac-boundary`, `secret-handling`, `webhook-trust`,
  `ingestion-ephemerality`, `injection-boundaries` (mandatory CORE-01..06), `ingestion-queue-webhook`,
  `websocket-realtime`, `secrets-audit-data-lifecycle`, `supply-chain-infrastructure`
- Not selected (registry trigger matched by an over-broad glob, but no relevant code in this diff,
  confirmed by reading every touched file): `llm-rag`, `model-provider`. Not selected (no trigger
  match at all): `mcp`, `web-api-client`.

## 4. Findings

**None.** No `FAIL` observation in this run.

## 5. The two specifically-briefed focus items

**1. `SQS_ENDPOINT_URL` fail-closed guard (`services/core/test/cross-runtime/publishIngestion.ts`).**
Independently re-derived, not trusted from `changes.md`/`review.md`'s claim: read
`publishIngestion.ts:32-45` directly — `getConfig('SQS_ENDPOINT_URL')` is the first statement inside
`main()`, before `readStdin()` and before `publishInitialParseEvent()`; a caught `ConfigError` is
re-thrown as an explicit refusal, so no network call ever precedes the check. Then read
`packages/config/src/config.ts` directly (not just the harness's comment about it):
`SQS_ENDPOINT_URL` has no `DEFAULTS` entry (line 85), so `getOptionalConfig` returns `undefined` when
unset and `getConfig` throws `ConfigError('Configuration SQS_ENDPOINT_URL is missing.')`; an
explicitly-set-but-empty value also throws via `validateValue`'s blank-string check — both unset and
blank fail closed identically, with no fallback to a default endpoint. See `results.json`
`CORE-03 / sqs-endpoint-url-fail-closed-guard` (`PASS`, `STATIC`, `HIGH` confidence).

**2. BullMQ lane/priority mechanism — unvalidated-input-influenced ordering.** Traced every current
`enqueue()` call site (`githubWebhookService.ts:83`, `ticketSyncIngress.ts:23,25` — confirmed via
`grep` and confirmed all three have an empty `git diff` against this run) and confirmed none passes
`opts.lane`; there is no code path anywhere in the repo today that maps webhook/request/queue-message
input into `opts.lane`. `enqueue()` also explicitly rejects a raw `priority` key on `opts` at runtime
(`bullmq.ts:234-240`), which defeats the specific bypass of smuggling a numeric priority around the
validated `lane` enum. Independently verified the underlying BullMQ 5.28.2 scheduling mechanism this
whole design leans on, directly in the installed package (not just cited from `spec.md`):
`node_modules/bullmq/dist/cjs/classes/scripts.js:145` and
`node_modules/bullmq/dist/esm/commands/moveToActive-11.lua:70-87` confirm the `wait`-drains-first,
`prioritized`-only-if-`wait`-is-empty behavior the module header describes, and that both lanes
mapping to a non-zero priority (1/2) is the correct fix for it. See `results.json` `ING-04`
(`PASS`) and `ING-07` (`PASS`, with a forward-looking, non-blocking design note about the BullMQ lane
mechanism having no built-in fairness bound comparable to the SQS side's `priority_weight`, relevant
only once a future ticket assigns real traffic to the priority lane — `spec.md`'s Open Questions #3
already defers that policy decision).

**3. Cross-runtime `tsx` harness subprocess invocation — command-injection-adjacent pattern.** Read
both `subprocess.run`/`subprocess.Popen` call sites in `test_cross_runtime_roundtrip.py` directly:
both use list-argv form (`["npx", "tsx", *args]` / `["npx", "tsx", CONSUME_HARNESS, "--queue", ...]`),
never `shell=True`, never a string-concatenated command. Per-run-varying values
(`idempotency_key`, `org_id`) are passed as a single argv element or as JSON on stdin, never
interpolated into a shell command line a shell would re-parse. See `results.json` `CORE-06`
(`PASS`).

## 6. Verified clean (selected highlights — full list in `results.json`)

- `CORE-01` tenant isolation: `assertValidEnvelope` still gates every produce/consume path this diff
  touches or adds; re-ran `envelope.test.ts` directly (32/32 passed).
- `CORE-04` webhook trust: `githubWebhookService.ts` unedited; signature validation still precedes
  the one `enqueue()` call site.
- `ING-01/02/03` (webhook signature / replay-idempotency / installation binding): unaffected sibling
  paths, confirmed unchanged.
- `ING-04`/`ING-07` (forged envelope / priority starvation): see §5 above.
- `SEC-01/02` (loader bypass / hardcoded secrets): both new harnesses resolve config exclusively
  through `@sayre/config`; the only credential-shaped literal (`localstack-test`) is a pre-existing,
  non-secret LocalStack sentinel already used at `ci.yml:467-468` before this diff.
- `SC-04/05` (CI trigger/permission scope, workflow injection): no `on:`/`permissions:` change, no
  `${{ }}` expression in either new workflow step — both are 100% static literals.
- `SC-12` (fileParallelism availability tradeoff): re-ran the full `@sayre/core` suite directly
  (101 files, 1021 tests, 0 failures, 34.27s) — consistent with dev/tester/review's independent
  re-runs.
- Ran, directly and fresh, not copied from any prior stage's numbers:
  `npx vitest run src/queue/__tests__/{bullmq.lane,w0-04.acceptance-wiring,initialParse.fixture,envelope}.test.ts`
  (16 + 32 = 48 tests, all passed), `npm test --workspace @sayre/core -- --run` (101 files / 1021
  tests passed, 1 file / 14 tests skipped — broker-gated), `npx tsc --noEmit -p
  services/core/tsconfig.json` (clean), `poetry run pytest --collect-only -q` (777 collected, 0
  errors), `poetry run ruff check` on all four touched/created Python test files (clean).

## 7. Limitations

See `manifest.json`'s `limitations` array (reproduced): Docker/LocalStack/Redis unreachable in this
environment, so every live-broker-dependent behavior is backed by STATIC evidence (including direct
reading of the installed BullMQ package source) rather than this stage's own DYNAMIC run; this is a
coverage limitation carried forward from every upstream stage, not new here.
`spec.json`/`red.json`/`changes.json` staleness (tree-hash-only) noted per PL-04, not treated as a
control-input problem (required-inputs staleness policy: advisory, per `.sdd/stages/security.md`);
`review.json` itself (the one trusted-fresh-or-refuse input) was confirmed fresh before this run
began. `ING-07`'s lane-fairness design note is forward-looking, not a current finding.

## 8. Cleanup

No fixture, scratch repo, or `.pipeline/` tree was constructed by this run. No file outside
`.pipeline/security-history/20260810T040646000Z-ee496aa498-PR_DELTA-81b52d/` and
`.pipeline/security-report.md`/`.pipeline/security.json` was written by this stage. Nothing to clean
up.

## 9. Recheck scope

None required for this `PASS`. If a future stage revisits this diff (e.g. `REMEDIATION_RECHECK`),
the recheck scope is: re-run every `ING-*`/`CORE-*` observation above once Docker/LocalStack/Redis
are reachable, specifically to upgrade `ING-04`'s/`AC-2`/`AC-4`'s live-broker priority-drain evidence
and `AC-6`/`AC-7`'s cross-runtime delivery evidence from STATIC to DYNAMIC/BOTH.

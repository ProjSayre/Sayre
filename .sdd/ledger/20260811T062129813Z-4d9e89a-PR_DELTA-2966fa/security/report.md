# Security Audit Report — W1-06 gapfill

Run ID: `20260811T062129813Z-4d9e89a-PR_DELTA-2966fa`
Mode: `PR_DELTA`
Verdict: **PASS**

## 1. Target and environment

- Repository: `ProjSayre/Sayre`
- Target commit: `4d9e89a8dab9e1338a68ff023785d2631777f5fe`; branch
  `codex/w1-06-gapfill-on-w0-07`; dirty worktree containing the W1-06 delta under audit
- Milestone: W1-06, GitHub App install/uninstall lifecycle gapfill
- Scope: the BullMQ GitHub ownership-sync execution gate in
  `services/core/src/services/gitSyncService.ts`, its production resolver wiring in
  `services/core/src/integrations/git/worker.ts`, and focused tests
- Environment: disposable local worktree; localhost-only ephemeral HTTP listeners; no external
  service, production credential, tenant record, or persistent test fixture
- Immutable artifacts:
  `.pipeline/security-history/20260811T062129813Z-4d9e89a-PR_DELTA-2966fa/`
- The required `review.json` gate was fresh and `PASS` before this audit began.

## 2. Run and baseline

No compatible baseline exists. This worktree contains no earlier immutable run under
`.pipeline/security-history/`; committed ledger copies and sibling-worktree history are not eligible
baselines under the audit contract. Every result and readiness state is therefore
`FIRST_OBSERVATION`, with coverage marked `NOT_COMPARABLE` rather than presenting an invented trend.

## 3. Security trajectory

- New findings: 0
- Regressed findings: 0
- Persisting findings: 0
- Resolved findings: 0
- Risk-accepted findings: 0

There is no comparable prior run, so this report makes no directional security claim beyond the
current target. The run found no failing observation.

## 4. Coverage trajectory

- Gained: 0
- Lost: 0
- Unchanged: 0
- Non-comparable: 58
- Result totals: 28 `PASS`, 12 `UNVERIFIED`, 18 `NOT_APPLICABLE`, 0 `FAIL`
- Surface readiness: all 14 registered surfaces observed as `IMPLEMENTED` for this first observation

Mandatory CORE checks and the model-provider, ingestion/queue/webhook, web/API client, and
secrets/audit/data-lifecycle briefs were evaluated. Model-provider checks were retained because its
registry trigger broadly matches `services/core/**`; all twelve were correctly `NOT_APPLICABLE` to
this GitHub metadata worker.

## 5. Findings

**None.** There is no `FAIL` observation, remediation owner, due date, or finding-specific recheck.

No critical check relied on a single new control. Webhook admission still verifies HMAC and active
installation state; queued Node ownership work now independently re-resolves active installation
and organization ownership at execution; the Python ingestion worker already performs its own
active-binding check. The W1-06 gate is also covered by focused negative and positive tests.

## 6. Verified clean

- Inactive, unknown, invalid, and cross-organization GitHub installation IDs are ignored before
  provider construction, token minting, repository reads, or graph writes.
- A current active installation bound to the queued organization proceeds through the existing
  ownership-sync behavior.
- Non-GitHub providers bypass the GitHub installation resolver; resolver failures propagate so the
  queue can apply its retry policy rather than silently acknowledging work.
- Focused W1-06 Core suite: 132/132 tests passed, including all 13
  `gitSyncService.test.ts` cases.
- GitHub App HTTP route attacks: 25/25 passed using a localhost ephemeral listener, including
  signature rejection and lifecycle admission behavior.
- Security-focused suite: 11 files / 143 tests passed. Agent-ignore checks passed (15/15), the
  dependency baseline passed (11/11), and the secret-loader gate passed (40/40).
- Shared-types build, Core TypeScript typecheck, Core lint, SDD completeness (58/58), repository
  structure (34/34), security-audit-agent registry validation (8 briefs / 108 checks / 2 schemas),
  and the current-diff credential-pattern scan all passed.
- The graph write remains parameterized and organization-scoped; the changed worker introduces no
  clone, parser, scratch-file, model-provider, HTML-rendering, export, or support-tool boundary.

## 7. Limitations

Every unverified or not-applicable boundary is explicit in `results.json`.

Unverified checks:

- `ING-06`: no live Redis/production queue proved bounded retry, DLQ, and partial-write behavior.
- `ING-07`: no authorized live Redis load fixture proved per-tenant quota or starvation behavior.
- `ING-11`: no live Neo4j/Redis interruption fixture proved replay across graph write and queue ack.
- `WEB-05`: local route tests do not establish deployed proxy/TLS or browser security headers.
- `WEB-07`: no dedicated duplicate-parameter/content-type ambiguity suite exists for callback query
  parsing.
- `WEB-10`: no deployed intermediary/cache fixture proved non-caching behavior.
- `SEC-02`: current-diff scans are clean, but gitleaks or an equivalent history-aware scanner is not
  installed, so reachable-history breadth remains unproved.
- `SEC-09`: no live Postgres fixture proved attributable, durable lifecycle audit events.
- `SEC-10`: no live audit store proved update/delete resistance and commit ordering.
- `SEC-11`: admission, Node execution, and Python ingestion gates were verified, but no complete
  offboarding fixture covered every data store, queue, cache, DLQ, and session.
- `SEC-12`: no backup environment or policy evidence proved encrypted, isolated backup/restore and
  deletion behavior.
- `SEC-14`: no deployed alerting/metrics sink proved actionable delivery for high-risk failures.

Not-applicable checks comprise `CORE-05`, all `MP-01` through `MP-12`, `ING-08` through `ING-10`,
`WEB-03`, and `SEC-13`. The target performs metadata-to-graph synchronization only: it does not
clone or parse source, create scratch paths, invoke models, render browser content, or expose export
and support-tool surfaces.

The repository has no root `npm test` script. The Turbo aggregate is blocked locally by the macOS
keychain environment, the full Core run requires unavailable Postgres/Redis services for unrelated
suites, and Python `pytest` is not installed in this worktree. The changed Core suite and the
relevant direct gates nevertheless passed as listed above.

## 8. Reproduction and cleanup

Tests used only in-memory synthetic fixtures and localhost ephemeral servers. The exact HTTP
servers were closed by their test harnesses. No tenant, provider, database, queue, graph, credential,
or external side effect was created, and there is no manual fixture to remove. Immutable run
artifacts are intentionally retained for the ledger.

## 9. Recheck scope

No remediation recheck is required for this `PASS`. GitHub CI must repeat the clean-checkout build,
lint, typecheck, and test gates, and the ticket's required Pair/human signoff remains a merge gate.
To upgrade the twelve `UNVERIFIED` observations, use authorized disposable Postgres, Redis, Neo4j,
proxy/cache, audit/alerting, backup/restore, full offboarding, and history-aware secret-scanning
fixtures scoped exactly to the checks listed in section 7.

# Security audit report — CH-04 (Worker agent loop: MCP-client chat consumer)

## Verdict: PASS

Run `20260811T010720502Z-25988f3-PR_DELTA-3a73ea`, mode `PR_DELTA`, first run for this repository
(no prior `.pipeline/security-history/` entries exist — every observation below is
`FIRST_OBSERVATION`, every coverage transition `NOT_COMPARABLE`; no trend claim is made).

## 1. Target commit and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre.git`)
- Working path: `C:/Users/splat/OneDrive/Desktop/Sayre/.claude/worktrees/agent-a5212a58710c1e0d7`
- Commit: `25988f3e048ff3fd58336b4d9869c6fa8f0249b1` (branch `ticket/ch-04-worker-agent-loop`, dirty
  — the entire CH-04 change is uncommitted working-tree state, per the caller's instruction: base
  for the diff is `origin/ticket/ch-03-chat-persistence-turn-api` @ `25988f3`, this branch's `HEAD`)
- Environment: local worktree, static/read-only review. No live Postgres/Redis/Core-MCP-gateway/
  ModelProvider was authorized or exercised against a real network target. Two existing unit suites
  were independently re-run against their own in-process fakes/fixtures (no external network calls)
  to obtain first-party dynamic evidence rather than relying solely on `review.md`'s reported counts:
  `poetry run pytest -q tests/test_chat_mcp_client.py tests/test_chat_boundaries.py
  tests/test_chat_events.py` → **62 passed**; `npx vitest run src/security/
  ch04ChatCredentialFkMigration.test.ts src/services/chatService.test.ts` → **60 passed**.
  `review.json`'s freshness stamp was confirmed `fresh` both before and after these runs
  (`node scripts/check-stamp-freshness.mjs review.json`), and `git status --short` was identical
  before and after — nothing on disk moved.
- Changed paths: 31 (12 modified, 19 new) — see `manifest.json.target.changed_paths` for the exact
  list. Re-derived directly via `git diff HEAD` + `git status --short` +
  `git ls-files --others --exclude-standard`, not taken from `changes.md`'s self-report.

## 2. Baseline

No baseline. Per `audit-contract.md` section 2, baseline order step 4: "No baseline. Mark every
observation `FIRST_OBSERVATION`; do not invent progress." `.pipeline/security-history/` contained no
other run directories at the start of this run.

## 3. Counts

**By result** (108 total, one per registered checklist ID — `npm run check:security-audit-agents`
independently confirms the registry itself defines exactly 108 unique checks across 8 briefs + the
6 mandatory `CORE-*` checks):

| Result | Count |
| --- | --- |
| PASS | 46 |
| NOT_APPLICABLE | 47 |
| UNVERIFIED | 14 |
| FAIL | 1 |

**By result transition:** `FIRST_OBSERVATION` — 108 (no baseline exists).

**By coverage transition (Coverage trajectory):** `NOT_COMPARABLE` — 108. No `GAINED`/`LOST`/
`UNCHANGED` transitions exist because there is no prior run to compare coverage against; this is
itself recorded rather than silently treated as a gain.

**By finding status:** `OPEN` — 1 (`FND-477e4cbf5856`, LLM-09).

**By surface readiness (14 registered surfaces: 6 mandatory `CORE-*` + 8 attacker-brief surfaces):**
`IMPLEMENTED` — 12, `PARTIAL` — 2 (`websocket-realtime` — publish side implemented, subscribe side
CH-05 not yet built; `secrets-audit-data-lifecycle` — static DDL implemented, live-database
enforcement unverified).

**By readiness transition:** `FIRST_OBSERVATION` — 14 (no baseline exists).

## 4. Security trajectory: new, regressed, persisting, resolved, and risk-accepted findings

- **New:** 1 — `FND-477e4cbf5856` (LLM-09, MEDIUM, OPEN). See section 5.
- **Regressed:** 0 (no baseline; nothing to regress against).
- **Persisting:** 0 (no baseline).
- **Resolved:** 0 (no baseline).
- **Risk-accepted:** 0.

## 5. Findings

### FND-477e4cbf5856 — LLM-09 — Unbounded decision-generation calls in the chat agent loop

- **Severity:** MEDIUM. **Confidence:** HIGH. **Status:** OPEN. **Single point of failure:** No.
- **Surface / target asset:** `llm-rag` / `chat-agent-loop:decide-generation-budget`.
- **What was found:** `services/workers/sayre_workers/chat/agent.py`'s `decide`↔`act` LangGraph loop
  bounds `tools/call` invocations reaching the MCP gateway to `CHAT_MAX_TOOL_CALLS` (8) via
  `state["calls_made"]`, incremented only in `act_node` on an actual (non-cached) tool call
  (`agent.py:413-414`). A cache hit on an already-invoked `(tool, arguments)` pair
  (`agent.py:405-410`) correctly serves from `state["cache"]` with **no** second HTTP call and **no**
  budget decrement — this is exactly spec loop-contract #4 / EC-14 and is not itself a deviation.
  However, every non-first `decide` step unconditionally calls
  `provider.generate_structured(...)` (`agent.py:359-367`), and nothing decrements any budget when
  `act_node` routes back to `"decide"` on a cache hit. The **only** remaining ceiling on total
  `decide`↔`act` steps is LangGraph's own `recursion_limit: 200` (`agent.py:620`) and the
  `CHAT_TURN_DEADLINE_SECONDS = 240` wall-clock timeout (`models.py:19`). A degenerate model —
  including one steered by injected content surviving the prompt-injection containment in
  `prompt.py` closely enough to alternate between two or more already-cached `(tool, arguments)`
  pairs — can drive on the order of 100 extra `generate_structured` calls (roughly half of the 200
  recursion steps, alternating `decide`/`act`) before the loop terminates via `GraphRecursionError`
  (→ `chat.internal`) or the 240 s deadline (→ `chat.timeout`). This is a genuine, roughly
  12×+ paid-provider cost amplification over the intended 8-call budget for a single turn, of exactly
  the kind D5's own rationale ("retrying an AI answer rarely helps and can cost real money in a
  loop") exists to avoid for the tool-call side — but no equivalent ceiling exists for the
  generation-call side.
- **Why not blocking:** it self-terminates (bounded by `recursion_limit`/deadline, no infinite loop);
  it is scoped to a single turn (no retry/redelivery — D5's terminal-not-redelivered posture applies
  regardless of how the turn ends); it crosses no tenant boundary and leaks no data; and
  `services/core/src/mcp/rateLimit.ts`'s per-key rate limiter (unchanged, unrelated to this finding)
  independently bounds the `tools/call` side regardless. None of `.sdd/stages/security.md`'s automatic
  `BLOCKED` triggers (tenant-isolation/RBAC failure, CRITICAL/HIGH failure or regression, lost
  CRITICAL/HIGH coverage, missing/invalid run data, an unauthorized-dynamic-evidence `PASS` claim on a
  runtime-critical boundary) apply.
- **Independently corroborates:** `review.md`'s own Warning 2, reached by a different reviewer via
  the same code; this audit reached the same conclusion independently through the cold-attack-model
  process (code read before test read) rather than by trusting that prior note.
- **Evidence type:** STATIC. **Reproduction:** not dynamically reproduced this run — a genuine
  reproduction would script a `ScriptedProvider` fake in `tests/test_chat_agent_loop.py` that
  alternates two already-cached `(tool, arguments)` decisions and asserts
  `provider.generate_structured` call count independently of `CHAT_MAX_TOOL_CALLS`. The static trace
  of `decide_node`/`act_node`/`build_chat_agent_graph` is conclusive on its own: no code path
  decrements a decision-call budget. No fixture was created in this pass; nothing to clean up.
- **Code references:** `services/workers/sayre_workers/chat/agent.py:338-475`,
  `services/workers/sayre_workers/chat/agent.py:585-624`,
  `services/workers/sayre_workers/chat/models.py:18-24`.
- **Owner / due date:** unassigned (`null`/`null`) — recommend routing to a follow-up ticket, not a
  fix-now blocker.
- **Remediation reference / recheck scope:** add a `CHAT_MAX_DECISIONS`-style ceiling on
  `decide_node` generation calls, independent of `CHAT_MAX_TOOL_CALLS` (e.g. increment a
  `decisions_made` counter on every `decide_node` invocation past the first, terminate into
  synthesis when it is reached, exactly mirroring the existing `CHAT_MAX_MALFORMED_DECISIONS`/
  `CHAT_MAX_TOOL_CALLS` shape). Recheck scope for a future `REMEDIATION_RECHECK`: re-run LLM-09
  specifically, plus its sibling paths MP-09/MCPT-08 (response-size bounding, same "is every resource
  dimension of this loop bounded" question) and SC-12 (availability/recovery), against a test that
  scripts a repeated-cache-hit decision sequence.

## 6. Verified clean (PASS, with evidence)

Grouped by control family; full per-check evidence, attempt description, and code references live in
`results.json` (one observation per row) — this section summarizes rather than repeats verbatim.

- **Tenant isolation (CORE-01, LLM-03, ING-04, WS-07, MP-05).** `org_id` is stamped server-side at
  every hop of the new data flow: `chatService.postTurn`'s `owner = ownerFrom(userCtx)` (never
  `req.body`) → the SQS envelope's top-level `org_id` → `parse_chat_turn_envelope`'s
  `envelope.org_id` (payload's own `orgId` checked for equality only, never trusted — EC-3/AC-9) →
  every `ChatTurnStore` call and `org_scoped_connection` (RLS) → the Redis channel name and every
  published event's top-level `org_id` → the provider/baseline scope used for the 70x KPI. No path
  accepts a client-supplied `org_id`.
- **RBAC boundary (CORE-02, LLM-08).** The worker never imports `neo4j` (static AST test,
  independently confirmed by a second static import scan in this pass); all ten advertised MCP tools
  are read-only (`find*`/`get*`/`traverse*`/`check*`, confirmed by listing every handler under
  `services/core/src/mcp/handlers/`); the model's chosen tool/arguments are allowlisted against the
  server-returned `tools/list` and the tool's own required-argument schema before ever reaching the
  gateway, but the actual authorization decision remains entirely server-side, independent of the
  model.
- **Credential handling (CORE-03, MCPT-02, MCPT-09..11, SEC-01..08).** The ephemeral MCP credential
  is `repr=False`, excluded from every `__repr__`/log/persisted row (behaviorally proven — 62
  independently re-run pytest cases, including the AST walk over every logging call site in the
  package and the dedicated `test_a_wrong_bearer_is_rejected_by_the_gateway_and_becomes_an_
  unauthorized_turn` end-to-end fixture); every JSON-RPC POST including the notification carries the
  bearer header; a 401 anywhere raises `McpUnauthorizedError` and maps to a clean
  `chat.mcp_unauthorized` terminal state (no crash loop, no redelivery — the message is deleted per
  D5); TTL (300 s default) is enforced by the unchanged `resolveMcpCredential`, and the loop's own
  240 s deadline is deliberately shorter so it never straddles expiry mid-call.
- **Privilege ceiling (MCPT-10).** `chatService.postTurn` mints via
  `mint(conversationId, userCtx)` → `mintEphemeralMcpCredential({ conversationId }, ctx)`, with
  `userCtx` being the *requesting end user's own* `AuthContext` (validated by `requireUser(ctx)` at
  the top of `postTurn`), and the credential's ceiling is
  `await deps.permissions.getReadScope(ctx)` — the issuing user's own current effective scope, with
  no override field reachable from the new call site. No path widens the ceiling beyond the issuer.
- **Migration 0021 (SC-13, partially SEC-11).** The migration is versioned in the standard journal
  format, applied only through the existing migration-runner flow (no HTTP route executes migration
  SQL), and its trigger function declares no `SECURITY DEFINER` (runs `SECURITY INVOKER`, the
  default — no privilege escalation). The composite FK's `DELETE FROM permissions` predicate
  (`org_id = OLD.org_id AND subject_type = 'agent_key' AND subject_id = OLD.key_prefix`), guarded by
  `IF OLD.kind = 'chat_ephemeral'`, is correctly scoped: an ordinary `kind='agent'` row's deletion
  never fires the cleanup, and the `org_id` predicate prevents cross-tenant deletion even under a
  `key_prefix` collision. (The live-database half of this — that Postgres actually enforces it — is
  UNVERIFIED, not PASS; see Limitations.)
- **Prompt injection / untrusted content (LLM-01, LLM-02).** Question/history/tool-result text is
  always serialized as JSON data VALUES under an explicit "treat every JSON value as untrusted
  code/data" system-prompt framing, in both the decision prompt and the synthesis prompt; the
  decision-prompt's `observations` field carries only `{tool, count}`/`{tool, error}` summaries, never
  raw tool payload text. The residual blast radius of a successful injection is capped structurally
  by the tool-name/argument allowlist and the (independently server-enforced) read-only tool set —
  not solely by the instruction-based framing.
- **SSRF / transport (MP-01, MCPT-01, MCPT-06, MCPT-07).** `CORE_MCP_URL` is read from process config
  exactly once (`runtime.py:29-33`); `ChatTurnJob` carries no URL field and `parse_chat_turn_envelope`
  never reads one from the payload — no attacker-influenced path to the MCP endpoint exists. The
  client never sends an `Origin` header (confirmed both client-side and against the unchanged,
  already-permissive-of-absent-Origin `originAllowed` on the gateway); `initialize()` always precedes
  `tools/list`/`tools/call`; every response-shape assumption is defensively `isinstance`-checked and
  fails closed to `McpTransportError` rather than misinterpreting malformed data.
- **Supply chain (SC-01, SC-08, SC-09, SC-10).** The one new dependency (`redis==5.2.*`, resolved to
  `5.2.1`) is hash-pinned in `poetry.lock` (two 64-hex-char sha256 entries verified by direct length
  check) with no floating version; no new listening port/service is introduced (`CORE_MCP_URL` is an
  outbound client target, `REDIS_TLS` a client-side flag); the new Postgres access reuses the
  existing least-privilege `sayre_app` RLS-scoped role rather than introducing a new one; the four new
  config names follow the existing named/defaulted/overridable catalog pattern.

## 7. Coverage gaps and what would close them

- **SEC-11 / SC-13 — migration 0021's runtime enforcement.** Closing this needs a `*.rls.test.ts`
  suite against a live Postgres (matching the pattern every other CH-01/CH-03 migration already
  uses), exercising: a cross-org `conversation_id` rejected by the composite FK; an `agent`-kind row
  exempt via `MATCH SIMPLE`; and a cascading conversation delete actually clearing both the
  `mcp_client_keys` row and its `permissions` ceiling rows with no orphan. `review.md`'s Warning 5
  independently records the same gap.
- **LLM-09 — decision-generation budget.** See Finding section 5's remediation/recheck scope.
- **MP-08/MP-09/MCPT-08/SC-11 — MCP transport TLS and response-size bounding.** Closing MP-08/SC-11
  needs a deployed-target check (production `CORE_MCP_URL` scheme/certificate posture, out of a local
  worktree's reach). Closing MP-09/MCPT-08 needs either an explicit response-size cap added to
  `StreamableHttpMcpClient` or an accepted-risk note that the MCP endpoint is first-party/trusted
  infrastructure, not a customer-configurable target, which is why this run treated it as LOW/
  UNVERIFIED rather than a blocking gap.
- **SC-02/SC-03 — dependency install-script and vulnerability-scan visibility.** Needs the project's
  CI-integrated SBOM/vulnerability scanner output, not available to inspect in this read-only pass.
- **SEC-09/SEC-14 — audit-log completeness and detection/response for the new mint-on-every-dispatch
  call pattern and the two new log lines.** Needs access to the actual audit-log store / alerting
  pipeline configuration, out of this diff's code and this run's authorization.

## 8. Cleanup

No fixture, scratch repository, `.pipeline/` tree, or any other throwaway artifact was created
outside `.pipeline/security-history/20260811T010720502Z-25988f3-PR_DELTA-3a73ea/` and
`.pipeline/security-report.md`/`.pipeline/security.json` (both required deliverables of this stage).
The two independently re-run test suites (`poetry run pytest`, `npx vitest run`) executed entirely
against their own existing in-process fakes/fixtures and left no residue — confirmed by an identical
`git status --short` before and after. No repository file outside this run's own required artifacts
was created, modified, or left behind.

## Limitations

Every unverified, not-applicable, or incompatible boundary from this run, in one place:

- **No live runtime available/authorized.** No Postgres, Redis, or Core MCP gateway was exercised
  against a real network target. Every observation that depends on live-database or live-network
  behavior is `UNVERIFIED`, never converted to `PASS` on static evidence alone (per
  `audit-contract.md` section 6): `SEC-11`/`SC-13` (migration 0021's live FK/trigger enforcement),
  `MP-08`/`SC-11` (production TLS posture for `CORE_MCP_URL`), `MP-09`/`MCPT-08` (MCP transport
  response-size bounding), `MP-02`/`MP-11` (redirect-following default and provider-config race),
  `SEC-09`/`SEC-14` (audit-log/alerting pipeline visibility), `SC-02`/`SC-03` (dependency
  install-script execution and vulnerability-scan tooling), `LLM-11` (narrative-claim safety, which
  needs an authorized live-model run with adversarial questions).
- **CH-05 (the WebSocket gateway subscriber) does not exist yet.** `WS-01..06` and `WS-08..12` are
  `NOT_APPLICABLE` because that half of the realtime surface is genuinely `ABSENT` in the pinned
  target (`spec.md`'s own Scope "Out" list confirms `services/gateway/**` is untouched), not because
  they were skipped. `WS-07` (Redis/channel tenant-scoping, the half CH-04 actually owns) is `PASS`.
- **This is a first-ever run.** No `.pipeline/security-history/` entries existed before this run;
  every `result_transition`/`coverage_transition`/`readiness_transition` is `FIRST_OBSERVATION`. No
  trend, regression, or improvement claim is made anywhere in this report — there is nothing to
  compare against yet.
- **Unchanged, out-of-diff controls cited for mandatory-check completeness only.**
  `ephemeralMcpCredentialService.ts` (`MCPT-09`), the GitHub webhook signature validator (`CORE-04`),
  and the ingestion scratch-clone cleanup (`CORE-05`) are all byte-identical to the pre-CH-04 tree
  (confirmed via `git diff`); they were spot-checked for continued presence, not independently
  re-derived line-by-line as a full re-audit would.
- **One MEDIUM, non-blocking finding remains open:** `FND-477e4cbf5856` (LLM-09) — see section 5.
  Everything else in this run is either affirmatively verified clean (46 `PASS`) or genuinely not
  applicable to this diff's surface (47 `NOT_APPLICABLE`).

## Reviewer references

`.pipeline/spec.md`, `.pipeline/changes.md`, `.pipeline/review.md` (verdict `PASS`, stamp confirmed
`fresh` against the current tree before this run began and re-confirmed after), and
`.claude/rules/security-multitenancy.md` were all read as required inputs. Full per-check attempt
descriptions, evidence, and code references are in the co-located `results.json`; this file is the
human-readable summary the audit contract requires alongside it.

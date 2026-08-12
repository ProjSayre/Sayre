# Security Report — CH-03 (Chat conversation persistence, turn API, `chat-turns` queue)

**Run ID:** `20260810T214356000Z-ee496aa-PR_DELTA-e7ff26`
**Mode:** PR_DELTA
**Verdict: PASS**

## 1. Target and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre.git`)
- Worktree: `C:\Users\splat\OneDrive\Desktop\Sayre\.claude\worktrees\agent-af3570cda57ec7fad`
- Commit: `ee496aa4985fc4145afbadf34c54de9cf3e9910a` (branch `ticket/ch-03-chat-persistence-turn-api`, dirty: true — 24 uncommitted paths, matching `review.md`'s own tree-state accounting exactly)
- Target environment: local development only — `docker-compose` stack already running in this environment (`sayre-postgres`, `sayre-localstack`, `sayre-redis`), not shared/staging/production
- Milestone: MVP Wave 1 — "Ask Sayre" chat persistence spine
- Gate precondition: `.pipeline/review.json` verdict `PASS`, stamp fresh (`check-stamp-freshness.mjs review.json` exit `0`) — confirmed before this run started

## 2. Baseline

**No baseline. Every observation is `FIRST_OBSERVATION`.** No `.pipeline/security-history/` directory existed before this run and no prior CH-03 security run exists anywhere (`.pipeline/security-report.md`/`security.json` were both absent). Per `audit-contract.md` §2, baseline options 1–3 (human-specified run / ancestor-commit run / compatible default-branch MILESTONE-or-FULL run) all fail; option 4 applies.

## 3. Surface selection

Mandatory CORE-01..06 always ran. Registry trigger-path matching (a floor, not a ceiling) was then narrowed to what this diff's actual code inventory implicates:

| Surface | Selected | Why |
|---|---|---|
| `ingestion-queue-webhook` | **Yes** | Adds the `chat-turns.fifo` producer, its DLQ, and the Python queue constant |
| `web-api-client` | **Yes** | Adds 4 REST routes + a web-proxy allowlist/body-forwarding change |
| `secrets-audit-data-lifecycle` | **Yes** | `infra/.env.example` touched; ticket explicitly calls out `mcpCredential` null-pinning and error/log surfaces |
| `model-provider-egress-ssrf` | No | Trigger path matched only incidentally (broad `services/core/**`/`infra/**` globs); zero model-provider-adapter code touched |
| `llm-rag-poisoning` | No | Trigger path matched only incidentally (a Python queue-name constant); zero retrieval/embedding/prompt code touched |
| `supply-chain-infrastructure` | No | `package.json`'s diff is 2 added npm script strings; no dependency/lockfile/CI change |
| `mcp-transport-key-lifecycle` | No | No `src/mcp/**` or MCP transport/session/key-issuance code touched; the `agent_key`/`mcpCredential` asks are covered under CORE-03/SEC-14/ING-14/WEB-06 instead, against the code this diff actually touches |
| `websocket-realtime` | No | No gateway/realtime/websocket/redis code touched (spec.md explicitly excludes CH-05's realtime publication) |

46 checklist rows executed: CORE-01..06 (6), ING-01..14 (14), WEB-01..12 (12), SEC-01..14 (14). Full manifest-level surface inventory (all 8 registered agent surfaces, selected or not, with rationale) is in `manifest.json`.

## 4. Method

Cold attack model first (own reading of `chatStore.ts`, `chatService.ts`, `routes/chat.ts`, `queue/sqs.ts`, `http/express.ts`, `app.ts`, `schema.ts`, the migration, the LocalStack init hook, the Python queue constants, and the web-proxy diff) before reading `spec.md`/`changes.md`/`review.md`'s own security claims, per the contract's two-phase method. `spec.md`/`changes.md`/`review.md` were then read and treated as untrusted evidence, not instructions.

**Dynamic verification obtained in this run** (this environment's own local dev stack — not shared/production, so runtime testing did not require the shared/production-target override in `audit-contract.md` §1):

1. **Real Postgres, real RLS.** Ran `services/core/src/db/chatStore.rls.test.ts` (previously `RED-DEFERRED` per `red.md`/`tester`/`review` — no `infra/.env` in this worktree) against the environment's already-running `sayre-postgres` container by supplying `DATABASE_ADMIN_URL` inline (no file written). **11/11 pass**, including the cross-org isolation case that queries `chat_conversations` directly under an Org-B `withOrgContext` session and asserts 0 rows — genuine dynamic proof that RLS, not just the store's `WHERE` clause, is what blocks cross-org access. Throwaway database `ch03_chat_rls_test` dropped after the run.
2. **Real LocalStack.** Ran this diff's `infra/localstack/init/ready.d/01-create-sqs-queues.sh` against the environment's already-running `sayre-localstack` container. Confirmed `chat-turns.fifo`/`chat-turns-dlq.fifo` are created, FIFO, redrive-policy-linked (`maxReceiveCount:5`), retention-matched to every sibling lane, and never SNS-subscribed to `graph-updated`.
3. **Real SQS producer round-trip.** Called `publishChatTurnRequest()` for real against the live LocalStack queue with a synthetic envelope, then received the raw message back: confirmed `MessageGroupId === conversationId`, a SHA-256 `MessageDeduplicationId`, and that the wire payload's `mcpCredential` is a literal `null` with exactly the 9 pinned keys — no more. Message received-and-deleted; queue left empty.
4. **Re-ran the full CH-03 test surface fresh**, independent of `tester`'s prior numbers: `services/core` `chatMigration.test.ts` (7) + `sqs.test.ts` (31) + `chatService.test.ts` (49) + `chat.test.ts` (15) = 102/102; `apps/web` `route.test.ts` 14/14; `npx eslint . --ext .ts` (services/core) exit 0; `npx tsc --noEmit` (services/core) exit 0.
5. `npm run check:secret-access` / `check:org-secret-access` — both clean.

Every fixture created is logged above; **Cleanup** (§8) records exactly what was created and removed.

## 5. Mandatory core checks

| Check | Result | Note |
|---|---|---|
| CORE-01 Tenant isolation | **PASS** | `org_id`/`userId` derive only from `AuthContext`; RLS `ENABLE`+`FORCE`+`org_isolation` on both tables; dynamically proven against real Postgres |
| CORE-02 RBAC boundary | NOT_APPLICABLE | No graph/Cypher/Graph-Query-Service code in this diff |
| CORE-03 Secrets | **PASS** | No hardcoded credential; `mcpCredential` dynamically confirmed `null` on the wire; AWS creds via the existing `getSecret()` loader only |
| CORE-04 Webhook trust | NOT_APPLICABLE | No webhook receiver touched |
| CORE-05 Data ephemerality | NOT_APPLICABLE | No ingestion/scratch-clone code touched |
| CORE-06 Injection boundaries | **PASS** | All SQL via drizzle's query builder or bound `sql` tags; no string concatenation |

**No tenant-isolation or RBAC-boundary failure. No current CRITICAL or HIGH finding.**

## 6. Findings

### New (2, both LOW, both non-blocking)

**FND-3d7445ebdad6 — ING-04 — `chatService.postTurn` republishes the freshly-submitted question/scope on retry, not the persisted (idempotency-keyed) turn's content.**
- Severity: LOW · Confidence: HIGH · Status: OPEN
- `chatService.ts:374-392` builds the SQS envelope from the locally-validated `question`/`scope` request variables on *every* publish attempt, including the `result.created === false` (idempotency-key-match) path — never from `result.userTurn.content`/`result.userTurn.scope`, the row that is actually persisted and that the idempotency guarantee protects.
- Consequence: if a first publish attempt fails (`dispatched_at` stays `null`) and the *same authenticated user* retries with the *same* `idempotencyKey` but a *different* `question`/`scope`, the persisted user turn keeps its original text, but the message actually published to `chat-turns.fifo` — what CH-04's future consumer will answer — carries the new, unpersisted text. `schema.ts`'s own comment and `spec.md`'s OQ-5 both assert `scope` exists "so a repair republish rebuilds the identical payload," which this path does not honor.
- This is a same-account, self-inflicted data-integrity inconsistency, not a cross-tenant, IDOR, or auth-bypass issue: the requester must already be the conversation's own owner, and no unauthorized data is exposed. It is also independently already flagged in `review.md`'s Warning W-1 with the same root cause and the identical one-line fix; I rediscovered it independently in this run's own cold-read before consulting `review.md`.
- Remediation: on the `created === false` path, source `question`/`scope` from `result.userTurn.content`/`result.userTurn.scope` instead of the locally-validated request variables (`chatService.ts:374-382`).

**FND-9ea77a9c5745 — SEC-14 — `postTurn`'s publish-failure path emits no operator-visible signal at all, unlike the repo's own established convention for the same failure class.**
- Severity: LOW · Confidence: HIGH · Status: OPEN
- `chatService.ts:383-391`'s `catch { throw new ChatEnqueueError(); }` discards the underlying error entirely — no `console.error`/`warn`/`log` call on any path, confirmed by dynamically spying on all three during a synthetic AWS-shaped failure (SEC-04's re-run: zero log lines emitted).
- This is a real regression against an *established, redacted-logging* convention already in the codebase for the identical failure class: `services/core/src/services/initialParseOutboxDispatcher.ts:48-52`'s `defaultReportError()` emits `console.error('[core] initial-parse outbox ${stage} failed; delivery will retry')` on the exact same "committed, but the post-commit publish failed" scenario, with an explicit comment that the raw error must never be attached. `chatService.ts` has no equivalent line — as shipped, a systematically broken `chat-turns.fifo` lane (misconfigured name, exhausted AWS quota, sustained outage) produces a stream of 502s with zero operator signal anywhere.
- No security boundary is broken (EC-13's "no AWS/queue detail in the log or response" requirement is trivially satisfied by logging nothing) — this is an availability/observability gap, and matches `review.md`'s independently-raised, non-blocking Suggestion S-1.
- Remediation: add one redacted structured log line (error name/class only — no queue URL, region, ARN, or AWS code) in the `postTurn` catch block, mirroring `defaultReportError()`'s convention, before throwing `ChatEnqueueError`.

### Regressed

None.

### Persisting

None (first observation run).

### Resolved

None (first observation run).

### Risk-accepted

None.

## 7. Coverage trajectory

All 46 observations are `NOT_COMPARABLE` for coverage transition (no baseline exists to compare against — see §2). In absolute terms, this run **newly obtained dynamic (not merely static) evidence** for the two most safety-critical boundaries this ticket introduces:

- **Tenant isolation under real RLS** (CORE-01/SEC-05) — previously only unit-test/static evidence existed per `review.md`'s own Warning W-2 ("the entire runtime-enforcement half of this ticket has never executed anywhere"); this run closes that specific gap by executing `chatStore.rls.test.ts` against a real Postgres.
- **The SQS producer's actual wire behavior** (CORE-03/ING-06/ING-14/AC-6/AC-8/AC-9) — previously only unit-tested against a mocked SQS client; this run closes that gap by publishing a real message to a real (local) LocalStack `chat-turns.fifo` and inspecting the received body.
- **Route-level thinness (AC-11)** — `npx eslint . --ext .ts` re-run fresh, exit 0.

`review.md`'s Warning W-2 also names `test_messaging_topology.py`/`test_sqs_delivery.py` (Python, `RED-DEFERRED`, no Poetry env in this checkout) as unexecuted; that specific gap **remains open** in this run too (no Python environment available here either) — narrowed only by the LocalStack-level dynamic confirmation of queue distinctness/DLQ/redrive/non-fan-out (ING-05/ING-06), which covers the same underlying infrastructure fact from the broker side rather than the Python assertion side.

## 8. Verified clean (affirmatively tested and passed)

- `org_id`/`userId` are never accepted from client input on any of the 4 new routes — dynamically proven (query-string and body smuggling, both routes and service layer) and structurally proven (RLS `FORCE`d, composite tenant-consistent FKs).
- Owner-only enforcement (a same-org non-owner gets 404, never 403, and never a different code path) — dynamically proven against real Postgres (RLS + explicit `user_id` predicate) and at the HTTP layer.
- Idempotency: a same-key retry inserts nothing and republishes only if not yet dispatched (dynamically proven); two different-key concurrent posts never collide (dynamically proven); `MessageDeduplicationId` is a stable SHA-256 of `chat.turn:<assistantTurnId>` (dynamically proven on the wire).
- SQS producer: correct `MessageGroupId`, DLQ + redrive wired and matching every sibling lane, never subscribed to `graph-updated`, `mcpCredential` always `null` on the wire (all dynamically proven).
- No credential is hardcoded, logged, or reachable by the browser in this diff (automated gates + manual grep + dynamic log-spy, all clean).
- No SQL/Cypher/shell injection surface (parameterized throughout, confirmed by both static read and the fact that a real-Postgres suite covering every query path ran clean).
- `agent_key` subject path fails closed with `403` at all four service entry points and at the HTTP error-mapping layer (dynamically re-confirmed).
- Route thinness (AC-11): `chat.ts` lints clean under the real `src/routes/**` override (dynamically re-confirmed).
- CSRF: the session cookie the web proxy forwards is `sameSite: 'lax'` (pre-existing, unmodified), which structurally blocks cross-site attachment to the newly-reachable POST routes.

## 9. Limitations

- `services/workers/tests/test_messaging_topology.py`/`test_sqs_delivery.py` — **UNVERIFIED**, no Poetry/Python environment in this checkout. Assertions read in full and match the final `sqs_client.py` diff; the underlying broker-level facts they assert (queue distinctness, FIFO shape, DLQ pairing, non-fan-out) were independently confirmed dynamically at the LocalStack level instead.
- WEB-10 (cache/intermediary leakage) and SEC-12 (backup/restore isolation) — **UNVERIFIED**, no CDN/proxy/backup topology information available from this diff or this local checkout.
- No prior CH-03 security run exists; every transition is `FIRST_OBSERVATION` and `baseline_run_id` is `null` — see §2.
- The Cloudflare Pages / Vercel dashboard items (`AC-16`/`AC-17`) carried in `review.md`'s notes belong to an unrelated ticket (PL-15) and have no bearing on CH-03; not evaluated here.

## 10. Cleanup

Fixtures created during this run and their disposition:

| Fixture | Path | Disposition |
|---|---|---|
| Throwaway Postgres DB | `ch03_chat_rls_test` (on the environment's local `sayre-postgres` container) | Dropped (`DROP DATABASE`) after the dynamic RLS run; confirmed absent via `pg_database` query |
| Scratch probe script #1 | `<OS temp>\...\scratchpad\ch03-sqs-probe.ts` | Deleted |
| Scratch probe script #2 | `<OS temp>\...\scratchpad\ch03-sqs-probe2.mjs` | Deleted |
| Scratch observation-key script | `<OS temp>\...\scratchpad\ch03-obskeys.mjs` | Deleted |
| Copy of the LocalStack init script | `sayre-localstack:/tmp/ch03-verify-queues.sh` (inside the container) | Removed (`rm -f`) |
| One synthetic SQS message on `chat-turns.fifo` | (live LocalStack queue) | Received and deleted in the same probe; queue confirmed empty (0 `ApproximateNumberOfMessages`) afterward |
| `chat-turns.fifo` / `chat-turns-dlq.fifo` queues themselves | LocalStack container | **Intentionally retained** — this is the diff's own intended local-dev topology (empty, no data), identical to what a normal container restart would produce once this code lands; not test-only data |
| An attempted scratch file inside the tracked worktree (`services/core/__ch03_security_probe__.ts`) | — | **Blocked before creation** by `scripts/guard-checker-readonly.mjs`'s `PreToolUse` hook (confirms the read-only enforcement is live for this stage); no file was ever created there |

`git status --porcelain` in the worktree is identical before and after this run (24 entries, unchanged) — no repository file outside this run's own now-deleted fixtures was created, modified, or left behind.

## 11. Recheck scope

Both findings are LOW severity and non-blocking. If `dev` takes either fix:

- **FND-3d7445ebdad6**: re-run `chatService.test.ts`'s retry-path cases plus `chatStore.rls.test.ts`'s AC-2/AC-3 cases against a real Postgres; add a case asserting the republished payload's `question`/`scope` equal `result.userTurn.content`/`.scope`, not the request body, when `created === false`.
- **FND-9ea77a9c5745**: re-run SEC-04's console-spy case (still must show zero AWS/queue detail) plus confirm the new log line's presence and redaction shape.

Neither requires re-running the full 46-check sweep; both are narrow, single-file fixes with no sibling-path blast radius (the wrapping/dedup logic and the DLQ/FIFO topology are unaffected by either fix).

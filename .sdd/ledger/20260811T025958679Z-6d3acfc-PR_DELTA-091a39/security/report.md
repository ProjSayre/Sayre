# Security Audit Report — CH-05 Gateway realtime chat events

**Run ID:** `20260811T025958679Z-6d3acfc-PR_DELTA-091a39`
**Verdict:** PASS

## 1. Target commit and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre.git`)
- Working path: `C:\Users\splat\OneDrive\Desktop\Sayre\.claude\worktrees\agent-a22bee051f95621bd`
- Commit: `6d3acfce2d978ca4177038186e80b9c0ac96abe7` (`origin/ticket/ch-04-worker-agent-loop`, diff base for this ticket)
- Branch: `ticket/ch-05-gateway-chat-events`; working tree dirty (17 modified tracked files, 9 new untracked files — the CH-05 diff itself)
- Mode: `PR_DELTA`
- Environment: local checkout only. No live Redis/Postgres/Core process was started; all dynamic verification used each surface's own existing in-process test-double convention (`FakeRedis`, `FakeSocket`, `vi.fn()` Core-authorization stubs).
- Milestone/phase: CH wave (realtime chat), MVP / pre-external-customer per `.claude/rules/security-multitenancy.md`'s phased secrets posture.

## 2. Baseline

No baseline. `.pipeline/security-history/` did not exist in this worktree before this run. Every observation below is `FIRST_OBSERVATION`; every coverage transition is `NOT_COMPARABLE`. See `manifest.json`'s `baseline` object.

## 3. Gate verification (before the full check ran)

Per `.sdd/stages/security.md`, this stage refuses rather than runs a full check if `review.json`'s stamp is stale. This was independently verified, not assumed from the calling agent's claim:

- `node scripts/check-stamp-freshness.mjs review.json` (run from this worktree's own root) → `{"file":"review.json","dir":".pipeline","status":"fresh"}`, exit `0`.
- `.pipeline/review.json`: `{"verdict":"PASS", "stamp": {"headSha":"6d3acfce2d978ca4177038186e80b9c0ac96abe7", ...}}`.
- `.pipeline/review.md`, `spec.md`, and `changes.md` in this worktree are genuinely about CH-05 (confirmed by reading all three in full) and match the diff on disk.

**Note on a red herring:** the outer repository root (`C:\Users\splat\OneDrive\Desktop\Sayre\.pipeline\`, *outside* this worktree) contains an entirely unrelated-ticket `.pipeline/` tree (PL-15, "Repo restructure," on branch `refactor/repo-restructure`) with its own `review.json` that reads `STALE` against that other location. This run correctly used the worktree-local `.pipeline/` the coordinator's own working directory points at, not the outer repo root's. Recorded here only so a later reader is not confused by the coincidental existence of that other directory; it had no effect on this run's gate decision, which is entirely about the worktree's own, genuinely-fresh, genuinely-CH-05 `review.json`.

`spec.json`/`red.json` read `STALE` (expected, per review.md's own Warning 1 and this stage's "Staleness of required inputs" section — both are advisory, not trusted-fresh). `changes.json` reads fresh. None of this affected the gate decision.

**Verdict: full check authorized. Proceeding.**

## 4. Surface selection

Mandatory `CORE-01`..`CORE-06` run every mode. Registry trigger-path routing (`agent-registry.json`) plus a read of every file in the actual diff selected two additional briefs:

- **`websocket-realtime`** — direct match (`services/gateway/**`, `services/core/**/*realtime*`, `*redis*`); this ticket's primary surface.
- **`web-api-client`** — direct match (`services/core/src/routes/**`, `services/core/src/http/**`): the one new internal route and its request parser.

**`model-provider-egress-ssrf`** was deselected despite a literal trigger-path match (`services/core/**` is broad enough to match almost any Core change). Code-inventory inspection found zero Model Provider Adapter, provider-settings, or customer-configurable-endpoint code anywhere in this diff — the only new outbound call (`fetchChatPushAuthorization`) targets Core's own static internal base URL, the same pattern the pre-existing `fetchAuthorizedDelta` already uses. Recorded with evidence in `manifest.json`'s `surface_inventory`, not silently dropped. The other five registered surfaces (`llm-rag`, `mcp`, `ingestion-queue-webhook`, `secrets-audit-data-lifecycle`, `supply-chain-infrastructure`) had no trigger-path match at all and are inventoried at a lightweight file-existence level only.

30 checklist rows were executed: `CORE-01`..`06` (6), `WS-01`..`12` (12), `WEB-01`..`12` (12).

## 5. Results summary

| Result | Count |
| --- | --- |
| PASS | 22 |
| FAIL | 1 |
| UNVERIFIED | 2 |
| NOT_APPLICABLE | 5 |

All 30 transitions are `FIRST_OBSERVATION` / coverage `NOT_COMPARABLE` (no baseline exists). See `results.json` for the full row-by-row detail (observation key, evidence, code references).

## 6. Findings

### FND-2c0a6d36bdc4 — WS-11 — Missing rate limit on the gateway's chat-subscribe -> Core-authorization path (MEDIUM, OPEN)

**What:** every inbound `{type:'subscribe', channel:'chat', conversationId}` WS frame — including a *repeat* subscribe to a conversation the same connection already holds, and a subscribe attempt for a conversation the caller does *not* own — unconditionally triggers one full, awaited round trip through `deps.authorizeChatSubscription` (an HTTP POST to Core's `/internal/realtime/chat-authorization`, plus one scoped Postgres query inside `realtimeChatService`'s `store.getConversation`) *before* the "already subscribed" check is ever consulted (`services/gateway/src/ws/connection.ts:164-198`). Each inbound WS message is also dispatched as its own independent, unqueued async task (`services/gateway/src/ws/connection.ts:285-327`), so a burst of frames on one connection fires that many concurrent authorization round trips. A grep of the whole gateway (`rate.?limit|throttle|maxPayload|debounce`, excluding tests) found zero matches — no bound exists anywhere between an inbound WS frame and an outbound Core HTTP call.

**Why this is new, not pre-existing:** the older repo-scoped `handleSubscribe` (`ws/connection.ts:115-125`) is fully synchronous and makes zero network calls at subscribe time. CH-05's chat-subscribe path is the first inbound WS frame type in this codebase whose per-occurrence handling is gated on an awaited Core round trip, including on *repeats*.

**Why it is not blocking:** this is not a tenant-isolation or RBAC-boundary failure — no cross-org or cross-user data is ever exposed by this path, and every authorization check the flood would trigger still correctly enforces ownership (see `WS-04`/`WS-05` above, both PASS). It is a resource-exhaustion/DoS-adjacent gap: any single authenticated connection, with no additional privilege, can force an unbounded number of Core HTTP calls + Postgres queries with no server-side throttle. Severity `MEDIUM`, confidence `HIGH` (fully evidenced statically; no dynamic flood test was run against a live server since it is unnecessary to prove the absence of a code-level bound).

**Cross-reference:** `WEB-08` (Core's own `/internal/realtime/chat-authorization` route also has no request-rate bound) is recorded `UNVERIFIED` rather than as a second `FAIL` for the same root cause — its actual exploitability from outside the gateway depends on a network-layer firewall this repo cannot verify (the route's own code comment already discloses this as a known, pre-existing architectural assumption shared with the sibling `/internal/realtime/graph-delta` route).

**Remediation:** add a per-connection rate limit / in-flight cap on chat-subscribe processing (and ideally on inbound WS message handling generally) before merge-blocking severity is warranted, or track as a fast follow. No fix was applied by this stage (security is attack-and-report only, per `audit-contract.md` §10).

**Reproduction:** static code read only (see code references above); no fixture was created, nothing to clean up.

## 7. Verified clean (highlights; full detail in `results.json`)

- **Tenant isolation (`CORE-01`, `WS-04`, `WS-07`, `AC-2`/`AC-8`):** `org_id` is server-derived at every layer of the new path (WS connection identity -> Redis channel/envelope agreement -> Core `AuthContext` -> Cypher `$org_id` parameter); never accepted from a client field. Dynamically re-proven this run (`chatE2e.test.ts`'s AC-2/AC-8 tests, `realtimeChatService.test.ts`'s AC-8/AC-11 tests — all independently re-run, all passing).
- **RBAC boundary (`CORE-02`):** node-level authorization exists only inside `RbacGraphQueryService.getAuthorizedNodeIds`; the gateway's `chatFanout.ts` only intersects ids Core already returned — no traversal/scope logic client-side.
- **Per-push re-filter, never a subscribe-time cache (`WS-05`, `AC-4`/`AC-9`):** dynamically proven — `authorizePush` is called once per event per connection (verified: 2 events -> exactly 2 calls), and a scope narrowed between two pushes drops the citation from the very next frame, not the current one.
- **Injection (`CORE-06`, `WEB-02`):** the one new Cypher query is fully parameterized (`$org_id`/`$node_ids`/`$allow_rules`/`$deny_rules`); no string concatenation from request input anywhere in the new code.
- **Information leak via the relay (`WS-08`, `WS-12`, `AC-6`):** every client-facing push is rebuilt field-by-field from validated inputs (never spread from a raw payload), so a stray/attacker-or-worker-controlled key cannot reach the wire — dynamically re-proven with a test that seeds `internalPromptText`/`internalScore`/a stray `seq` onto a `chat.turn.completed` payload and asserts none of it appears in the decoded push. Citation filtering checks *both* identifiers a citation carries (`nodeId` and `resolvedNodeId`), not just a top-level id.
- **Subscription lifecycle / revocation (`WS-06`, `AC-5`, `EC-9`..`EC-14`, `EC-21`..`EC-22`):** duplicate/racing subscribes acquire the Redis channel exactly once; unsubscribe/close/revocation each release exactly once; a 401 mid-turn closes the connection and sends nothing further; a 403/404 mid-turn sends exactly one generic error frame and revokes the subscription — all dynamically re-proven this run.
- **Secrets (`CORE-03`, `WS-03`):** no hardcoded secret in the diff; every `console.error` call logs only a channel name, fixed reason string, or connection id — never the bearer token or raw payload content; a dedicated test (`EC-12`) dynamically proves the token never reaches an error message or a log call.
- **Existence non-disclosure (`WS-10`, `WEB-11`, `EC-8`):** a nonexistent conversation and one owned by a different same-org user produce the byte-identical rejection (frame, HTTP status, and error body) at every layer.
- **Independently re-run this session (not taken from `review.md`'s or `test-results.md`'s self-report):** `services/gateway` — `npx vitest run` -> 14 files / 193 passed, 0 failed. `services/core` — `npx vitest run` -> 112 files / 1217 passed / 7 pre-existing skips, 0 failed. `npx tsc --noEmit` clean in both workspaces. `node scripts/check-red-integrity.mjs` -> exit 0, clean, 11 test paths checked, zero violations (the one declared red-test hash change, `chatE2e.test.ts`, matches `changes.json`'s declaration exactly).

## 8. Limitations (UNVERIFIED / NOT_APPLICABLE / not independently dynamically reproduced)

- **`WEB-08`** (Core route's own rate bound) and **`WEB-10`** (explicit `Cache-Control` on the new route) are `UNVERIFIED` — the former depends on a network-layer firewall this repo cannot inspect (see Finding above); the latter was not checked against a live running instance this run (low priority: POST responses are not cached by default HTTP semantics, and the route is internal-only).
- **`WS-01`** (Origin/CSWSH) and **`WS-09`**'s ioredis-reconnect half (`EC-24`) are `PASS` on strong static evidence (no cookie-based ambient credential exists anywhere in the gateway for `WS-01`; the ordering-chain logic itself is dynamically proven for `WS-09`) but were not reproduced against a real browser / a real dropped-and-restored Redis connection this run — confidence marked `MEDIUM`, not `HIGH`, on both rows, and `EC-24`'s live-Redis gap was already disclosed by `red`/`tester` before this stage ran, not newly discovered here.
- **`CORE-04`/`CORE-05`** (webhook trust, ingestion ephemerality) are `NOT_APPLICABLE` — this diff touches no webhook receiver or ingestion-worker file. Both remain `IMPLEMENTED` elsewhere in the codebase, unaudited by this `PR_DELTA` run.
- **`WEB-03`/`WEB-05`/`WEB-12`** (XSS/clickjacking/redirects) are `NOT_APPLICABLE` — `apps/web` is untouched (`git diff 6d3acfc -- apps/web` independently confirmed empty this run) and this diff adds only a JSON API + a WS relay, no HTML rendering surface. Flagged for CH-06 (the actual rendering surface, out of scope here) to apply its own output encoding to `answer`/citation `label` when it lands.
- Six of the eight registered attacker briefs (`llm-rag`, `model-provider-egress-ssrf`, `mcp-transport-key-lifecycle`, `ingestion-queue-webhook`, `secrets-audit-data-lifecycle`, `supply-chain-infrastructure`) were inventoried at a lightweight file-existence level only and not executed against this diff — each has a documented, evidenced deselection reason in `manifest.json`. A `MILESTONE`/`FULL`-mode run is required for full coverage of those six.
- `spec.json`/`red.json` staleness (both `STALE` per `check-stamp-freshness.mjs`) is a disclosed, non-blocking condition per this stage's own "Staleness of required inputs" section — both are advisory inputs; nothing in this run relied on either sidecar's freshness. `review.json` (the one trusted-fresh input for this stage) is fresh — see §3.

## 9. Cleanup

No fixture, scratch repository, or throwaway `.pipeline/` tree was created during this run. All verification was read-only source inspection plus this session's own `npx vitest run` / `npx tsc --noEmit` / `node scripts/check-red-integrity.mjs` invocations against the existing test suites (no new files written by those commands beyond normal Vitest/TS build caches already gitignored). Nothing to clean up.

## 10. Recheck scope

For a future `REMEDIATION_RECHECK` against `FND-2c0a6d36bdc4`: re-verify that a rate limit / in-flight cap now bounds `handleChatSubscribe`'s `authorizeChatSubscription` calls per connection (and, if fixed at the message-handler level, that repo-scoped subscribe/unsubscribe frames remain unaffected — `AC-10`'s back-compat guarantee), plus re-run `WEB-08` to confirm whether the same fix (or a network-layer control) also closes the identical gap on Core's own route.

# Security Audit Report — CH-05 Gateway realtime chat events (`/re-gate` run)

**Run ID:** `20260811T071754377Z-21d34a2-PR_DELTA-7029e6`
**Verdict:** PASS

## 1. Target commit and environment

- Repository: `projsayre/sayre` (`https://github.com/ProjSayre/Sayre.git`)
- Working path: `C:\Users\splat\OneDrive\Desktop\Sayre\.claude\worktrees\agent-a22bee051f95621bd`
- Commit: `21d34a26936ac2b14690ee83a2ab04b67454cda9` (`ticket/ch-05-gateway-chat-events`, committed head), tree dirty — one uncommitted working-tree change: `apps/web/app/workspace/state/realtime.tsx`.
- Mode: `PR_DELTA`. **This is a `/re-gate` run** after a hand-edit made outside `dev`'s loop, per the coordinator's explicit instructions.
- Environment: local checkout only. No live Redis/Postgres/Core process was started; dynamic verification used each surface's own existing in-process test-double convention plus this run's own re-execution of the full `services/gateway`, `services/core`, and `apps/web` test suites and `tsc --noEmit` in all three workspaces.
- Milestone/phase: CH wave (realtime chat), MVP / pre-external-customer.

## 2. Gate verification (before the full check ran)

Independently re-verified this run, not assumed from the coordinator's claim:

- `node scripts/check-stamp-freshness.mjs review.json` → `{"file":"review.json","dir":".pipeline","status":"fresh"}`, exit `0`.
- `.pipeline/review.json`: `{"verdict":"PASS","stamp":{"headSha":"21d34a26936ac2b14690ee83a2ab04b67454cda9","dirty":true,...}}` — the stamp's `headSha` matches this run's own `git rev-parse HEAD`, and `dirty:true` matches this run's own `git status --porcelain` (exactly one entry: ` M apps/web/app/workspace/state/realtime.tsx`), confirming `review.json` was stamped against the tree exactly as it stands for this run, hand-edit included.
- `spec.json`/`red.json`/`changes.json` all read `STALE` (`headSha: 6d3acfc`, pre-rebase). **Per `.sdd/stages/security.md`'s own "Staleness of required inputs" section, read directly this run rather than taken on anyone's paraphrase: `review.json`'s verdict is the ONLY trusted-fresh input this stage refuses on. `spec.md`/`spec.json` are explicitly advisory** ("Required inputs item 3 above already treats all of this as untrusted evidence... staleness is simply one more reason it was never trusted as a control input in the first place"). `review.md`'s own Warning 2 — "`security` refuses on a stale trusted-fresh `spec.json`" — is **incorrect** and was not followed. This is flagged in Limitations below, per the coordinator's instruction, but is explicitly **not** a refusal condition and did not block this run.
- `changes.md`/`changes.json` describe the tree BEFORE the hand-edit (correctly disclosed by both `review.md` and the coordinator). This run never relied on either for "what changed" — see §4 below, which re-derives the diff from `git diff`/`git status` directly, per this stage's own "re-derived" contract for that input.

**Verdict: full check authorized. Proceeding.**

## 3. Baseline

**Selected:** `20260811T025958679Z-6d3acfc-PR_DELTA-091a39` (PASS, 30 observations, one open MEDIUM finding `FND-2c0a6d36bdc4`), per the coordinator's explicit instruction to select a baseline and report transitions against it.

This is a **human-specified baseline** (audit-contract.md Section 2's order-1 baseline), which is why it was accepted despite `git merge-base --is-ancestor 6d3acfce2d978ca4177038186e80b9c0ac96abe7 HEAD` independently returning `NOT_ANCESTOR` (re-run this session) — the branch was **rebased** from CH-04's old ledger commit (`6d3acfc`) onto CH-04's settled ledger commit (`934a5ae`) between the two runs, which is exactly the "cross-branch"/history-rewrite case the contract's ancestor check carves an exception for when the human directs the comparison.

Rather than treating the human directive as a substitute for verifying comparability, this run independently re-derived it:

- **Checklist identity**: all seven required agent-content hashes (contract, registry, orchestrator, stage definition, checker shim, `websocket-realtime` brief, `web-api-client` brief) recomputed this run and found byte-identical to baseline's `manifest.json.agent_versions`.
- **Environment/fixtures identity**: identical (`local-checkout...`, same synthetic-fixture convention).
- **Code identity**: every gateway/core file baseline's `results.json` cites as evidence was re-read this run at the exact same line ranges baseline cited, and found byte-identical (see §5's observation table; e.g. `services/gateway/src/ws/connection.ts:164-198,285-327`, `services/core/src/graph-query/index.ts:906-949,2676-2700`, `services/core/src/routes/realtimeInternal.ts:47-60`).
- **Behavioral identity**: this run's own full re-execution of `services/gateway` (14 files / 193 passing), `services/core` (115 files / 1236 passing / 7 pre-existing skips — 3 files / 19 tests more than baseline's 112/1217/7, all unrelated base-drift content the rebase brought in underneath CH-05, zero CH-05 regressions), and `apps/web` (60 files / 349 passing) test suites, plus `tsc --noEmit` clean in all three workspaces.

`comparable: true`; no incompatible dimensions.

## 4. Surface selection

Mandatory `CORE-01`..`CORE-06` run every mode. Both briefs selected at baseline remain selected, for the same trigger-path reasons plus one addition:

- **`websocket-realtime`** — direct match, carried from CH-05's original diff. The hand-edit itself is a WebSocket-message-consumer change; per `.sdd/stages/security.md`'s "add every shared control and sibling path implicated by the change," this run explicitly extends this surface's audited target assets to include `apps/web/app/workspace/state/realtime.tsx` and its `parseGatewayMessage` dependency, even though `apps/web/**` is not itself one of this surface's registry `trigger_paths`.
- **`web-api-client`** — direct match on **two** independent grounds now: `services/core/src/routes/**`/`services/core/src/http/**` (carried, unchanged) **and** `apps/web/**` (the registry's own literal trigger path for this surface), newly matched by the hand-edit.

The other six registered surfaces remain deselected for the same evidenced reasons as baseline (no trigger-path match, and the hand-edit — a pure client-side type guard — introduces no LLM/provider/MCP/queue/secrets/supply-chain surface of any kind). See `manifest.json`'s `surface_inventory` for the full, evidenced accounting.

**32 checklist rows executed** (30 carried from the mandatory `CORE-01..06` + `WS-01..12` + `WEB-01..12` set, plus **2 new** — `WS-04` and `WS-05` each re-executed a second time against a new target asset, `apps/web`'s hand-edited message handler, to directly answer the coordinator's two named probes).

## 5. Results summary

| Result | Count |
| --- | --- |
| PASS | 24 |
| FAIL | 1 |
| UNVERIFIED | 2 |
| NOT_APPLICABLE | 5 |

| Result transition | Count |
| --- | --- |
| UNCHANGED | 30 |
| FIRST_OBSERVATION | 2 |

| Coverage transition | Count |
| --- | --- |
| UNCHANGED | 30 |
| NOT_COMPARABLE | 2 |

No `REGRESSED`, no `NEW`, no `RESOLVED`, no `LOST` coverage. Every one of the 30 carried-forward checks produced the identical result to baseline on independently re-verified evidence (not merely copied forward) — see `results.json` for the full row-by-row detail, including this run's own re-derived code references and re-run test/typecheck output for every row.

## 6. Findings

### FND-2c0a6d36bdc4 — WS-11 — Missing rate limit on the gateway's chat-subscribe → Core-authorization path (MEDIUM, OPEN, **persisting, unchanged**)

Unresolved since the baseline run. Re-verified this run at the identical code (`services/gateway/src/ws/connection.ts:164-198,285-327`, byte-identical to baseline) and the identical `grep -rniE 'rate.?limit|throttle|maxPayload|debounce' services/gateway/src` (excluding tests) — zero matches, unchanged. **The hand-edit under re-gate does not touch this code path at all** (it is entirely inside `apps/web`, a browser-side file; this finding's root cause is server-side gateway code). Not blocking for the same reasons as baseline: not a tenant-isolation/RBAC-boundary failure, MEDIUM severity, no regression. `last_seen_run_id`/`last_seen_commit` updated to this run/commit; `first_seen_run_id`/`first_seen_commit` preserved from baseline per the finding-lifecycle contract.

**No new finding was opened by this run.** The two new observations (`WS-04`/`WS-05` against the `apps/web` target asset) both resolved `PASS` — see §7.

## 7. The coordinator's two specific probes on the hand-edit, answered

**Probe 1 — does `'repoId' in message` change which messages the workspace acts on, or could it let the client treat a chat-channel ack as a repo-subscription confirmation?**

No, on both counts. `apps/web/app/workspace/realtime.ts:22-35`'s `parseGatewayMessage` was read end to end this run (not inferred): for `type === 'subscribed'` it has exactly one branch, which always reads `repoId` and returns `null` if absent — there is no code path anywhere in that function that reads a `channel`/`conversationId` field or constructs the chat `subscribed` variant. It is therefore **structurally incapable today** of returning anything but the repo variant (or `null`) for this `type`. Given that, `'repoId' in message` is `true` on every currently-reachable path — a runtime no-op, load-bearing only for `tsc`'s static narrowing over the now-two-variant `GatewayToClientMessage['subscribed']` union. And even in the hypothetical future where `parseGatewayMessage` is widened to decode the chat variant, the guard as written is **correct-by-construction** against exactly this probe: the chat variant carries no `repoId` key, so `'repoId' in message` would correctly evaluate `false` for it, and a chat ack could never reach the `.repoId` equality comparison. Full detail and code references: `results.json`'s `WS-04|...|apps-web-subscribed-confirmation-narrowing` observation.

**Probe 2 — does the guard weaken the existing `message.repoId === repositoryId` scoping check?**

No. `git diff apps/web/app/workspace/state/realtime.tsx` (re-run this session) shows the diff is a single added conjunct AND-ed ahead of the pre-existing, byte-identical `message.repoId === repositoryId` check — the equality check itself was not touched, reordered, or negated. A conjunction can only narrow the set of inputs that satisfy the whole expression, never widen it. Separately, and more fundamentally: this client-side comparison was never the actual security boundary in the first place — that lives entirely server-side (CORE-01/CORE-02, WS-04/WS-05's gateway-side rows), and this UI-local check only routes state over data the gateway has already restricted to this connection's own authorized subscription, per `.claude/rules/security-multitenancy.md`'s "client-side code may filter/route on data the server already authorized; it may not enforce access control" posture. Full detail: `results.json`'s `WS-05|...|apps-web-repo-scoping-guard-hand-edit` observation.

Both probes are answered with `PASS`, `HIGH` confidence, `BOTH` (static + dynamic) evidence, and no single point of failure (the client-side check is defense-in-depth on data already authorized server-side, not itself the boundary).

## 8. `check-red-integrity.mjs` — independently re-confirmed, not re-litigated

Re-run this session: exit `1`, `status: "violations-found"`, the identical 4 violations `review.md` diagnosed (`ws/chatEvents.test.ts`, `redis/chatPubsub.test.ts`, `fanout/chatFanout.test.ts`, `realtimeChatService.test.ts`) plus the identical 1 declared note (`chatE2e.test.ts`).

**Independently re-verified the diagnosis (not taken on `review`'s word) with fresh commands this run:**

- `git ls-files --eol` on all four flagged files → `i/lf w/crlf attr/` for every one (confirmed this run's own `core.autocrlf` reads `true`).
- `git cat-file -p HEAD:<path> | sha256sum` on all four, this run, matches `red.json`'s recorded hash **exactly**:
  - `ws/chatEvents.test.ts` → `7f1e9b732a4b8fa8b8516bd8cf633b1248055bf86a10b3b81cca3135076f6542`
  - `redis/chatPubsub.test.ts` → `1d785b8c1ed3188e58f4789007a58cdb26d57182c4e1398424dd213b70735e7e`
  - `fanout/chatFanout.test.ts` → `8fe7e1bcee1763dc27ebf38e34bdf957486a8214d2f0a8452e01ab2b3cb10898`
  - `realtimeChatService.test.ts` → `a946ccd2303c2ac1b93790951e18591151f505b0457952eae7903f47faa0acb7`

This is cryptographic, not heuristic, confirmation: a rebase-introduced CRLF/LF working-tree artifact, zero test content changed, not a new occurrence since the baseline run (which reached the identical conclusion about the identical four files). Non-blocking; not treated as a finding, consistent with baseline and with `review`'s own ruling.

## 9. Verified clean (highlights; full detail in `results.json`)

- **Tenant isolation / RBAC boundary (`CORE-01`/`CORE-02`)**: every code path re-read this run at baseline's cited line numbers, byte-identical. The hand-edit adds no `org_id`/scope logic of any kind.
- **Per-push re-filter, per-connection subscription IDOR (`WS-04`/`WS-05`, gateway-side)**: unchanged, re-verified against this run's own full test-suite execution.
- **Injection (`CORE-06`/`WEB-02`)**: the one Cypher query remains fully parameterized, re-read byte-identical this run.
- **Secrets (`CORE-03`/`WS-03`)**: no hardcoded secret; the hand-edited file has zero `console.*` calls and reads no token.
- **The hand-edit itself (`WS-04`/`WS-05` new rows)**: forced, minimal, behaviour-preserving, non-feature — independently re-derived this run, not accepted from `review.md`'s characterization. `npx tsc --noEmit` clean in `apps/web`/`services/gateway`/`services/core`; `npx vitest run` — `apps/web` 60/349, `services/gateway` 14/193, `services/core` 115/1236 (7 pre-existing skips) — all passing, zero regressions.
- **`check-red-integrity.mjs`'s 4 violations**: independently re-hashed and reconfirmed EOL-only (see §8).

## 10. Limitations (UNVERIFIED / NOT_APPLICABLE / not independently dynamically reproduced)

- **`WEB-08`/`WEB-10`** remain `UNVERIFIED`, unchanged from baseline (network-layer firewall assumption; low-priority cache-header check).
- **`WS-01`/`WS-09`'s ioredis-reconnect half** remain `PASS` on static-only/`MEDIUM`-confidence evidence, unchanged from baseline (no live browser/Redis this run either).
- Six of the eight registered attacker briefs remain unselected/lightweight-inventoried only, unchanged from baseline; a `MILESTONE`/`FULL`-mode run is still required for full coverage of those six.
- **`review.md`'s Warning 2** ("`security` refuses on a stale trusted-fresh `spec.json`") is factually incorrect against this stage's own contract (`spec.json` is advisory, never trusted-fresh) and was not followed. Recorded here as a documentation-accuracy note for whoever next edits `review.md`'s template, not as a condition that affected this run's verdict.
- `spec.md`'s `apps/web` exclusion sentence is now literally false for this branch (review's own Warning 4, re-confirmed). Bookkeeping, not a security-relevant drift — recorded in `manifest.json`'s `product_progress.documentation_code_drift`.
- `FND-2c0a6d36bdc4` (WS-11, MEDIUM, OPEN) persists, unaffected by this hand-edit. Recheck scope unchanged from baseline (§11 below).

## 11. Cleanup

No fixture, scratch repository, or throwaway `.pipeline/` tree was created during this run. All verification was read-only source inspection plus this session's own `npx vitest run` / `npx tsc --noEmit` / `node scripts/check-red-integrity.mjs` / `git diff` / `git status` / `git ls-files --eol` / `git cat-file` / `git merge-base --is-ancestor` invocations against the existing repository and test suites. Nothing to clean up.

## 12. Recheck scope

Unchanged from baseline for `FND-2c0a6d36bdc4`: for a future `REMEDIATION_RECHECK`, re-verify that a rate limit / in-flight cap now bounds `handleChatSubscribe`'s `authorizeChatSubscription` calls per connection (and that repo-scoped subscribe/unsubscribe frames remain unaffected — `AC-10`'s back-compat guarantee), plus re-run `WEB-08` to confirm whether the same fix (or a network-layer control) also closes the identical gap on Core's own route. No new recheck scope was opened by this run — both new observations (`WS-04`/`WS-05` against `apps/web`) resolved clean.

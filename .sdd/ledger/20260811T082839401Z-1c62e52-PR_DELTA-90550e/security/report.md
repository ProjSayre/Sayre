# Security Audit Report — CH-06 Ask Sayre panel UI (`/re-gate` verification run)

**Run ID:** `20260811T082839401Z-1c62e52-PR_DELTA-90550e`
**Verdict:** `PASS`
**Mode:** `PR_DELTA`
**Target commit:** `1c62e52fc483d1d8ecfcaf4abd45a101fe3b9ee4` (branch `ticket/ch-06-ask-sayre-panel`, dirty working tree — 2 modified + 1 untracked file under `apps/web/app/workspace/chat/`, fix round 2)
**Environment:** Local git worktree, no live deployment. Static source analysis plus local `vitest`/`tsc`/`next lint` execution — this round additionally builds `services/core` (`npx tsc -p tsconfig.json`, producing the gitignored `dist/` the gateway's own test suite resolves `@sayre/core` against) and independently re-runs `services/gateway`'s and `services/core`'s full test suites, neither of which the baseline run could do (CH-05's gateway did not exist in that run's base commit).
**Milestone:** Wave CH (Ask Sayre chat), ticket CH-06, re-gated against CH-05's now-real, committed gateway. MVP / pre-external-customer secrets posture.
**Baseline:** `20260811T045119987Z-6d3acfc-PR_DELTA-e8d162` (PASS, 30 observations: 18 PASS / 11 UNVERIFIED / 1 FAIL). Comparable — see `manifest.json`'s `baseline.selection_reason` for the full ancestry/hash/environment verification.
**Artifact path:** `.pipeline/security-history/20260811T082839401Z-1c62e52-PR_DELTA-90550e/`

---

## 1. The point of this run

The baseline run was executed on a base commit (`6d3acfc`) that predated CH-05's gateway entirely — CH-06 was built and security-checked against a pinned, mocked WS contract. CH-05's real implementation (`services/gateway/**`, `services/core/src/services/realtimeChatService.ts`) is now committed beneath this branch (`402400b`/`21d34a2`/`2d35da6`/`1eca8fd` in the stack), and `dev` has landed a fix (this round's C-1) correcting the client's outbound subscribe/unsubscribe frame shape to match CH-05's real, ratified `ClientToGatewayMessage` contract. `review.json` is a fresh `PASS` (stamp verified via `node scripts/check-stamp-freshness.mjs review.json` → `fresh`, exit 0) on this exact tree.

This run's job: resolve as many of baseline's 11 `UNVERIFIED` observations as the now-assembled tree allows, independently verify the fix and the ack-handling, and independently judge review.md's W-2 (the `chat_forbidden` swallow) rather than deferring to its ruling.

## 2. The 11 previously-UNVERIFIED items — resolved

**10 of 11 resolved to `PASS`, all via newly-available `BOTH` (static read + independently re-run test suite) or `STATIC` evidence. 1 of 11 (`WEB-10`) remains genuinely `UNVERIFIED`, for a stated, non-code-resolvable reason.**

| Check | Baseline | This run | How |
|---|---|---|---|
| CORE-04 (webhook-trust) | UNVERIFIED | **PASS** | Read `githubSignature.ts` + `githubWebhookService.ts` end to end: signature verified *before* any parse/publish to SQS/BullMQ. `services/core` suite (115/1236) re-run. |
| CORE-05 (ingestion-ephemerality) | UNVERIFIED | **PASS** | Read `repository.py`'s `checkout()`: `tempfile.TemporaryDirectory` + `try/finally: temporary.cleanup()`. STATIC only — Python suite could not run (pre-existing Poetry/pydantic tooling failure, same as `tester`'s this-round Impact map). |
| WEB-06 (mass assignment, server half) | UNVERIFIED | **PASS** | Read `services/core/src/services/chatService.ts`'s `postTurn`: named-field-only destructuring, no spread, owner derived from `AuthContext` never the body. `services/core` suite re-run. |
| WEB-10 (cache headers) | UNVERIFIED | **UNVERIFIED (unchanged)** | Genuinely unresolved — unchanged proxy code, no `Cache-Control` anywhere, and actual CDN/deployment caching behavior isn't evaluable from source; no live/authorized deployment target this run. Stated limitation, not a silent carry-forward. |
| WS-01 (cross-origin hijack) | UNVERIFIED | **PASS** (MEDIUM confidence) | Gateway has no Origin allowlist (`server.ts`'s `WebSocketServer` has no `verifyClient`), but auth is never ambient (Bearer header or post-open frame only, token from `localStorage`) — classic CSWH doesn't apply. `services/gateway` suite (14/193) re-run. |
| WS-02 (handshake bypass) | UNVERIFIED | **PASS** | `auth.ts`/`connection.ts` read end to end: uniform failure, generic 4401 close, dev-bypass fails closed outside dev/test. |
| WS-04 (subscription IDOR, server half) | UNVERIFIED | **PASS** | `handleChatSubscribe` → `authorizeChatSubscription` → Core's `authorizeRealtimeChatPush` re-derives ownership server-side every subscribe; existence non-disclosure via one generic `chat_forbidden` reply. |
| WS-05 (per-message authorization, server half) | UNVERIFIED | **PASS** | `relayChatEvent`/`pushToConnection` re-asks Core on *every* push (not cached from subscribe); Core re-derives `authorizedNodeIds` fresh every call. |
| WS-07 (Redis/channel tenant confusion) | UNVERIFIED | **PASS** | `decodeChatEvent` cross-checks channel org/conversation segments against the envelope four independent ways before constructing a push. |
| WS-10 (side-channel/enumeration) | UNVERIFIED | **PASS** (MEDIUM confidence) | Uniform `chat_forbidden` reply for both "not found" and "not owned"; uniform auth-failure close code. Response-*timing* uniformity not dynamically probed (still needs a live target). |
| WS-12 (property minimization, server half) | UNVERIFIED | **PASS** | `filterCitations` keeps only authorized node ids, applied per-push; `decodeCitation` reads only 4 named fields. |

Full evidence, code references, and confidence per row: `results.json`.

## 3. C-1's fix — verified independently

Re-read `ChatProvider.tsx:233-238,272-277` myself: both outbound frames are now `const ...: ClientToGatewayMessage = { type: 'subscribe'|'unsubscribe', channel: 'chat', conversationId }`, exactly the shape `packages/shared-types/src/index.ts:284-285` declares and `services/gateway/src/ws/protocol.ts:60-83`'s `decodeClientMessage` accepts (independently traced the `case 'subscribe'`/`'unsubscribe'` branches — the old `'chat.subscribe'` literal would have hit `default: throw new ProtocolError`). `npx tsc --noEmit` (apps/web) clean. This closes the class of bug structurally (a literal that doesn't satisfy the union fails its own project's compile), not just at the two literal sites.

**Field-for-field wire-shape check (gap (a), independently re-derived):** the server's `ChatTurnProgressPush`/`ChatTurnCompletedPush`/`ChatTurnErrorPush` (`shared-types/src/index.ts:234-262`, sent verbatim by `relayChatEvent`'s `sendSafe`) match `chatContract.ts`'s `parseChatGatewayMessage` field-for-field: `type`, `conversationId`, `turnId`, `seq`/`kind`/`tool`/`detail`/`ts` for progress; `answer`/`citations`/`metrics`/`ts` for completed; `code`/`message`/`ts` for error. Terminal frames carry no `seq`, matching EC-7's pin. **The canvas-rule citation-kind closure (AC-6/EC-13) is defended at all three layers, not just the client**: the Python worker's own `CitationKind = Literal["file","folder","feature","ticket"]` (`sayre_workers/chat/models.py:35`) is the identical closed set the gateway's `decodeCitation` (`chatEvents.ts:29-34`) and the client's `CHAT_DRAWABLE_CITATION_KINDS` both mirror — a `'function'`/`'class'` citation cannot originate from the worker's own type system, is rejected by the gateway if it somehow did, and is bucketed to `'unknown'`/non-selectable at the client as a final backstop. I checked this is real defense in depth, not merely the client's own claim.

**Confirmed, independently, this is *not* merely "the same mock, self-consistently checked"**: `services/gateway/src/chatE2e.test.ts` drives a real `ws` client against the real gateway server code (`attachConnectionLifecycle`, `handleChatSubscribe`, `relayChatEvent`) with a fake Redis/Core — 13 tests covering AC-1,2,4,5,6,7,9,12 and EC-8,11,12,13,14,20,21 — re-run this round as part of the 14-file/193-test gateway suite, all green. This is the closest to end-to-end evidence available without a live network target.

**Residual, honestly bounded (unchanged from `tester`'s own characterization, independently re-confirmed):** `apps/web` and `services/gateway` remain two separate `tsc` projects; no single test in this run feeds `ChatProvider.tsx`'s literally-constructed frame object through `services/gateway`'s literal `decodeClientMessage` function in one process. The type-level guarantee holds only for "both projects currently build against the same `@sayre/shared-types` install." `review.md`'s S-1 (a cross-workspace contract test) remains the correct, non-blocking follow-up — it requires either a new top-level test project or a `services/**` change, both outside CH-06's `apps/web/`-only lane.

## 4. The `{type:'subscribed', channel:'chat', conversationId}` ack — independently re-verified against a *hostile*, not just well-formed, frame

Confirmed the double-discard mechanism by reading both parsers myself, not accepting `changes.md`'s/`review.md`'s claim:

- `apps/web/app/workspace/realtime.ts:32-34` `parseGatewayMessage`: for `type === 'subscribed'`, unconditionally requires a non-empty `repoId` field and returns `null` if absent. The chat ack has no `repoId` — this function cannot construct the chat `subscribed` variant under any input, by inspection of every branch (there is no code path anywhere in the function that reads `value.channel` or `value.conversationId`).
- `apps/web/app/workspace/chat/chatContract.ts:169-182` `parseChatGatewayMessage`: closed match over exactly `chat.turn.progress`/`.completed`/`.error`; any other `type` (including `'subscribed'`) returns `null`.
- `ChatProvider.tsx:228-251` `handleMessage`: tries `parseGatewayMessage` first (returns `null` for the chat ack per above) then `parseChatGatewayMessage` (also `null`) — `if (chatMessage === null) return;` — no `setTranscript` call, no state touched.

**Hostility check, beyond the well-formed case `chatAckContract.test.tsx` exercises:** I traced what happens if an attacker (or a compromised/misconfigured intermediary) sends a *spoofed* ack for a foreign `conversationId`, a `subscribed` frame with extra/malicious fields (`__proto__`, oversized strings, nested objects), or a `subscribed` frame missing `channel`/carrying `channel: 'chat'` but a non-string `conversationId`. In every case: `parseGatewayMessage`'s `type==='subscribed'` branch only ever reads `repoId` (never `channel`/`conversationId`, so no field-confusion is possible there) and returns `null` for any of these since none carry a valid `repoId`; `parseChatGatewayMessage` rejects on `type` alone before touching any other field. **Neither parser destructures/spreads the raw payload into any live object** — both do explicit named-field reads — so there is no prototype-pollution or property-injection vector even in a maximally hostile payload. The mutation-testing `tester` performed (verified independently by re-reading the diff of that probe in `test-results.md`, not re-run by me) demonstrated the ack-discard path has real teeth against a mishandling regression; my own trace confirms it also has no gap against a hostile *variant* of the same frame `type`, not just the exact well-formed one the test pins.

**Verdict on this item: safe.** No plausible spoofed/malformed variant of this ack can reach `setTranscript`, `busy`, or `live`.

## 5. This round's fixed Critical — checked for completeness, not just the reported instance

Independently enumerated **every** outbound `socket.send(...)` call site in `ChatProvider.tsx` (there are exactly three: `auth` at connect, `subscribe` at `ready`, `unsubscribe` at teardown) to check whether the fix's discipline (explicit `ClientToGatewayMessage` typing) was applied uniformly or only to the two reported sites.

- **`subscribe`/`unsubscribe` (lines 233-238, 272-277):** explicitly typed `const ...Frame: ClientToGatewayMessage = {...}` this round. A future shape drift here is a compile error.
- **`auth` (line 225):** `socket.send(JSON.stringify({ type: 'auth', token }))` — **not** given the same explicit `ClientToGatewayMessage` type annotation. It currently satisfies `{ type: 'auth'; token: string }` structurally (confirmed: `token` is narrowed to `string` by the preceding `if (token !== null)` guard, matching `decodeClientMessage`'s `case 'auth': requires nonEmptyString(candidate.token)`), so there is no live defect. But nothing here is compile-checked the way the other two sends now are — a future refactor of this one literal could silently drift from `ClientToGatewayMessage` without `tsc` catching it, the exact same failure class C-1 was.

This is a real, if narrow, residual risk exactly of the kind the coordinator asked me to hunt for. **Rated a non-blocking Suggestion (S-4 in this report), not a finding** — the object is a two-key literal with a stable shape and low drift likelihood, unlike the subscribe/unsubscribe frames which had already drifted once. Recommend: type it the same way as the other two sends in a follow-up touch of this file.

No other outbound frame or assumption was found to diverge. Confirmed via direct read that these are the *only* three `socket.send` call sites in the file (no other WebSocket write path exists in `apps/web/app/workspace/chat/`).

## 6. W-2, independently re-judged (not deferred to review.md's ruling)

**My ruling: this is a real, currently-reachable security-adjacent finding — a client-side availability/resilience gap, not a confidentiality/integrity/authorization breach — rated `FAIL`, severity `MEDIUM`, filed as a `GAP-1` row under `WS-06` in `results.json` (a second row, distinct target asset from the carried WS-06 client-latch observation).**

I independently re-traced the branch sequence in `ChatProvider.tsx:228-251` (not accepting `review.md`'s five-step trace as evidence — re-derived it myself against the current file): `parseGatewayMessage` parses a `{type:'error',code:'chat_forbidden',message:'Conversation not found.'}` frame successfully; the only `code`-testing branch checks `=== 'unauthenticated'`; `chat_forbidden` falls through to a bare `return;`; no other branch in the function reads `generic.code`. Consequences, independently derived: `chatSubscriptions` never populated server-side → no `chat.turn.*` ever arrives; the socket stays open (no `close` event) → `live` never leaves `'connected'`; the degraded-poll effect's `live !== 'degraded'` guard never passes → no REST fallback arms; the turn stays `pending` forever, `busy` stays `true`, composer stays disabled, with **no visible explanation to the user**.

**Why I rate this real and reachable, not hypothetical:** `services/gateway/src/ws/connection.ts:179` fails closed with exactly this `chat_forbidden` reply when the gateway is deployed *without chat deps wired* — a realistic day-one deployment/configuration state affecting every user, not merely an edge-case authorization denial. `chatE2e.test.ts`'s own `EC-20` test (re-run this round, part of the green 14/193 gateway suite) confirms this is deliberate, correct, *tested* server behavior — the server side is not at fault.

**Why `MEDIUM` and not `HIGH`/`CRITICAL` (independent judgment, not adopting review's Warning label uncritically):**
1. It is not a tenant-isolation or RBAC-boundary failure — the mandatory-blocking categories under this stage's gate rules. The server's denial is *correct*; no unauthorized data is exposed at any point on this path.
2. It calibrates to this exact codebase's own established precedent for a real, non-breach availability/reliability gap: `WEB-05` (missing clickjacking headers, reachable on literally every page load) is `MEDIUM`; CH-05's own persisting `FND-2c0a6d36bdc4` (missing rate limit on the same chat-subscribe path, a DoS-adjacent gap) is `MEDIUM`. This finding is the same class — real, reachable, user-facing-degraded, not a breach.
3. Unlike `WEB-05` (a pure code-config gap with an obvious fix), the *correct* per-code client behavior here is a genuine design decision (`unauthenticated` vs `chat_forbidden` vs `bad_frame` plausibly want three different responses, and `reconcileNow` swallowing non-401 GET failures means "always degrade to REST" isn't obviously right for a true denial either) — consistent with why `review.md` declined to call it Critical and route it through a fix-list item rather than a spec amendment.

I explicitly did **not** use the "the shape is right now so it can't happen" argument `review.md` was told to avoid — I went and confirmed the trigger is real, tested, and server-deliberate, then decided severity on the merits above. Full evidence and remediation/recheck scope: `results.json`'s `WS-06` GAP-1 row.

## 7. Standing CH-06 threat surface — re-confirmed

- **No client-supplied identity:** `Object.keys(body)` is exactly `['idempotencyKey','question','scope']` (`chatClient.ts`); **newly confirmed server-side this round** — `chatService.ts:363-388`'s `postTurn` reads only `body.idempotencyKey`/`body.question`/`body.scope` by name, `owner` derived exclusively from `AuthContext`, never the body.
- **No client-side RBAC/traversal:** re-grepped the whole `chat/` directory — zero source hits for `orgId|rbac|isAuthorized|canAccess|hasPermission|authorize`, zero `graphology|sigma|canvas` imports. `chatSafetyGuards.test.ts` (3/3) re-run.
- **XSS (AC-17 absolute):** re-grepped for `dangerouslySetInnerHTML|href=|createElement\(.a.\)|innerHTML` across `apps/web/app/workspace/chat/` (excluding tests) — zero source hits. `ChatTranscriptList.tsx:134-136` renders only `turn.error.message` as a plain React text-node child.
- **Untrusted frames:** `parseChatGatewayMessage` re-confirmed as the trust boundary — closed match, `null` on anything else, never throws.
- **Secrets in `chat.mcp_unauthorized`:** only `turn.error.message` is ever rendered; `turn.error.code` never rendered; EC-16 test re-run.
- **Canvas rule:** closed at all three layers this round (worker `Literal`, gateway `CHAT_CITATION_KINDS`, client `CHAT_DRAWABLE_CITATION_KINDS`) — see §3.
- **Degraded REST polling:** `sessionExpiredRef` checked at every reconcile/poll/socket-action call site; bounded to `CHAT_DEGRADED_POLL_MAX_ATTEMPTS`; `chatDegradedRecovery.test.tsx` (7/7) re-run.

## 8. Mechanical verification — independently re-run this round

| Check | Result |
|---|---|
| `apps/web` `npx tsc --noEmit` | clean, exit 0 |
| `apps/web` `npx vitest run` | **70 files / 436 tests passing**, exit 0 |
| `apps/web` `npx next lint` | "No ESLint warnings or errors" |
| `services/core` `npx tsc -p tsconfig.json` (build, produces `dist/` — gitignored, not a source edit) | exit 0 |
| `services/gateway` `npx tsc --noEmit` | clean, exit 0 |
| `services/gateway` `npx vitest run` | **14 files / 193 tests passing**, exit 0 (matches CH-05's own security run's reported number exactly) |
| `services/core` `npx vitest run` | **115 files / 1236 passing / 7 pre-existing skips**, exit 0 (matches CH-05's own security run's reported number exactly) |
| `npm run check:secret-access` | **PASS**, zero findings (baseline's one inherited CH-01 finding is now fixed upstream, independently re-confirmed) |
| `npm run check:org-secret-access` | PASS |
| `npm run check:agent-shims` | PASS, 8/8 |
| `npm run check:agent-ignore` | PASS |
| `npm run check:ledger-index` | PASS, 548 files / 24 runs |
| `npm run check:security-audit-agents` | PASS, 8 briefs / 108 checks / 2 schemas |
| `node scripts/check-red-integrity.mjs` | exit 1 — 7 CRLF false positives, independently re-disproven below; 1 declared, legitimate change |

### Red-test integrity — independently re-verified, not accepted from `review.md`/`test-results.md`

Computed SHA-256 three ways (raw working-tree bytes, CRLF→LF-normalized, `git show HEAD:<path>`) for all 8 `red.json`-listed files myself:

- **7 files** (`chatContract.test.ts`, `answerMarkdown.test.ts`, `citationTarget.test.ts`, `chatClient.test.ts`, `chatTranscript.test.ts`, `chatSafetyGuards.test.ts`, `askSayreRegistry.test.ts`): raw hash mismatches `red.json`, but **both** the LF-normalized hash **and** the `HEAD` blob hash match `red.json` exactly — pure CRLF-materialization artifact (`core.autocrlf=true`), zero real content change. Two independent proofs per file, computed by me, not read off a prior stage's table.
- **`AskSayrePanel.test.tsx`**: `HEAD` blob hash matches `red.json` (unedited at the graded commit); LF-normalized working-tree hash does **not** match — a real, uncommitted edit. `git diff HEAD` confirms exactly the two declared lines (the `chat.subscribe`/`chat.unsubscribe` → `subscribe`/`unsubscribe` + `channel:'chat'` assertion corrections) and nothing else — both changes are strict *additions* of a conjunct (two-clause checks became three-clause checks), never a weakening. Declared in `changes.json`'s `redTestChanges` with an accurate reason. Judged legitimate.

## 9. Lane bounds — confirmed

`git diff 21d34a2..HEAD --stat -- services/` → empty. **`services/gateway`, `services/core`, and `services/workers` are byte-identical to CH-05's own terminal-PASS security run's commit** (`21d34a26936ac2b14690ee83a2ab04b67454cda9`) — everything I read and verified this round in those trees is exactly what CH-05's own independent security run already audited and passed (`.sdd/ledger/20260811T071754377Z-21d34a2-PR_DELTA-7029e6/security/`), corroborating rather than substituting for my own independent reads above. `git diff 1eca8fd..HEAD --name-only` (CH-05's ledger commit to now): 24 files under `apps/web/` + 1 untracked (`chatAckContract.test.tsx`) + `.sdd/ledger/**` bookkeeping — nothing outside those. `git status --porcelain`: exactly the 3 entries `changes.md` and `test-results.md` both report.

## 10. Verified clean (beyond §§2-7)

- **CORE-01/02/06:** re-confirmed PASS, unchanged.
- **WEB-01,02,03,04,07,08,09,11,12:** re-confirmed PASS, unchanged, via re-run tests.
- **WS-03,06(client latch),08,09,11:** re-confirmed PASS, unchanged, via re-run tests.

## 11. Findings

### FAIL — WEB-05 (persisting, unchanged) — MEDIUM — `FND-0c66db8d4fe3`
No `X-Frame-Options`/CSP/`frame-ancestors` anywhere in `apps/web`; no `headers()` in `next.config.mjs`; no `middleware.ts`. Pre-existing, sitewide, not introduced or regressed by CH-06. Re-grepped this round, unchanged. Not blocking (MEDIUM, not tenant/RBAC).

### FAIL — WS-06 GAP-1 (new) — MEDIUM — `FND-cf90dad546e9`
The `chat_forbidden`-swallow finding, §6 above. Not blocking (MEDIUM, not tenant/RBAC). Owner/due date/remediation reference: none assigned (no human approver in this run); recommend filing the follow-up ticket `review.md` already calls for, specifying per-error-code client behavior (`unauthenticated` / `chat_forbidden` / `bad_frame`).

**No CRITICAL or HIGH finding. No tenant-isolation or RBAC-boundary failure. No regression from baseline's `PASS` observations.**

## 12. Coverage and progress trajectory

- **Result transitions:** 20 `UNCHANGED`, 10 `CHANGED` (all `UNVERIFIED`→`PASS`), 1 `FIRST_OBSERVATION` (the new GAP-1 row).
- **Coverage transitions:** 20 `UNCHANGED`, 10 `GAINED`, 1 `NOT_COMPARABLE` (the new row).
- **No `REGRESSED`, no coverage `LOST`.**
- **Surface readiness:** `websocket-realtime` advanced `PARTIAL` → `IMPLEMENTED` (CH-05's server half is now genuinely present and independently verified, not merely pinned/mocked). All 13 other surfaces `UNCHANGED`.
- **Findings:** 1 persisting (`WEB-05`), 1 new (`WS-06` GAP-1). 0 resolved, 0 regressed, 0 risk-accepted.

## 13. Suggestions (non-blocking)

- **S-4 (new):** type the `auth` frame send (`ChatProvider.tsx:225`) against `ClientToGatewayMessage` the same way `subscribe`/`unsubscribe` were typed this round (§5).
- **S-1 (carried, review.md):** a cross-workspace contract test feeding `ChatProvider`'s constructed frames through `services/gateway`'s real `decodeClientMessage`. Out of CH-06's lane.
- **S-2 (carried, review.md):** reject an empty-string conversation `id` in `parseConversation` (`chatClient.ts`) — a one-condition change, folds into the WS-06 GAP-1 follow-up.

## 14. Limitations

See `manifest.json`'s `limitations` array — summarized: no live networked target this run (STATIC/BOTH only, never DYNAMIC-against-network); `CORE-05` STATIC-only (Python suite unrunnable, pre-existing tooling gap); `WEB-10` genuinely unresolved (deployment-layer); `WS-01`/`WS-10` MEDIUM-confidence (Origin-allowlist absence and timing-side-channel not dynamically probed); the new `WS-06` GAP-1 finding; CH-05's own persisting `FND-2c0a6d36bdc4` (different target asset, not duplicated here).

## 15. Cleanup

No fixture, scratch repository, or throwaway directory was created during this run beyond the immutable run directory itself. `services/core`'s `dist/` build output is gitignored (`services/core/.gitignore:2`) and not a source-tree edit — it was produced only to let `services/gateway`'s own test suite resolve its `@sayre/core` workspace dependency, mirroring how `npm run build:workspaces` would already have primed it in CI. No repository file outside `.pipeline/security-history/20260811T082839401Z-1c62e52-PR_DELTA-90550e/`, `.pipeline/security-report.md`, and `.pipeline/security.json` was created or modified by this stage.

## 16. Recheck scope

- **`WEB-05` (MEDIUM, open):** unchanged from baseline — re-run the header grep and, once a live target is authorized, a clickjacking probe, after a `headers()`/`middleware.ts` fix lands.
- **`WS-06` GAP-1 (MEDIUM, open, new):** re-check after a follow-up ticket specifies and implements per-error-code client behavior (`unauthenticated`/`chat_forbidden`/`bad_frame`); recheck scope is re-tracing `handleMessage`'s branches plus, ideally, a new behavioral regression test exercising a real `chat_forbidden` frame end to end.
- **`WEB-10` (LOW, open, unchanged):** recheck once either an explicit `Cache-Control` header lands in code or a live/authorized deployment target exists to test actual CDN/intermediary caching behavior.
- **`CORE-05`:** recheck with `STATIC` evidence upgraded to `BOTH` once the `services/workers` Poetry/pydantic environment is fixed in this worktree (or CI, which presumably already has it working) and its test suite can actually run.

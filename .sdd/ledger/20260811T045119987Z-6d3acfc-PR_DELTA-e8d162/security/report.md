# Security Audit Report — CH-06 Ask Sayre panel UI

**Run ID:** `20260811T045119987Z-6d3acfc-PR_DELTA-e8d162`
**Verdict:** `PASS`
**Mode:** `PR_DELTA`
**Target commit:** `6d3acfce2d978ca4177038186e80b9c0ac96abe7` (branch `ticket/ch-06-ask-sayre-panel`, dirty working tree — the CH-06 diff itself)
**Environment:** Local git worktree, no live deployment. Static source analysis plus local `vitest`/`tsc`/`next lint` execution against the repo's own mocked/in-memory test backends. No `services/core`, `services/gateway`, or database process was running or authorized this run.
**Milestone:** Wave CH (Ask Sayre chat), ticket CH-06 of CH-01..CH-06. MVP / pre-external-customer secrets posture.
**Baseline:** None. `.pipeline/security-history/` did not exist before this run; every observation is `FIRST_OBSERVATION`.
**Artifact path:** `.pipeline/security-history/20260811T045119987Z-6d3acfc-PR_DELTA-e8d162/`

---

## 1. Target and environment

CH-06 adds a real, collapsible "Ask Sayre" chat panel across the Technical/Product/Onboarding workspace views. The entire diff is confined to `apps/web/`: 5 modified tracked files (`apps/web/app/mock/README.md`, `apps/web/app/workspace/components/AskSayrePanel.tsx`, `apps/web/app/workspace/state/WorkspaceProvider.tsx`, `apps/web/app/workspace/views/LegacyWorkspaceView.tsx`, `apps/web/app/workspace/workspace.css`) and a new `apps/web/app/workspace/chat/` directory plus `apps/web/app/workspace/askSayreRegistry.ts` (source + tests). Verified independently via `git -c core.autocrlf=true diff --numstat`: **5 files, 266 insertions, 36 deletions**, all under `apps/web/`. `packages/workspace-packs/src/bin.mjs` shows as modified in `git status` but is a byte-identical line-ending phantom (`git rev-parse HEAD:...` and `git hash-object ...` both `4b47eb16...`) — confirmed, not staged, not part of this diff.

## 2. Gate precondition and stamp verification

`review.json` reads `{"verdict":"PASS"}`. `node scripts/check-stamp-freshness.mjs review.json` → `fresh`, exit `0`.

**`core.autocrlf` re-stamp, independently verified:** mid-run, this worktree's `.git/config` had `core.autocrlf` flipped `true → false` by an unidentified process, which (against an LF index checked out under `autocrlf=true`) made the working tree read as uniformly CRLF and inflated the visible diff, made `bin.mjs` look like a real change, and made `changes.json`'s stamp read stale. The coordinator restored `core.autocrlf=true` and re-ran `write-stamp.mjs` on `review.json` (verdict content untouched, only the stamp recomputed). I independently confirmed `git config core.autocrlf` is `true` in both the global gitconfig and this repo's `.git/config`, and independently recomputed `computeTreeHash()` (imported `scripts/pipeline-contracts.mjs` directly and called it, not trusted from any report) — result: `820917bb4107303c09cd5c35ad713030620b4e90e6b342576c1311f2e9adc4da`, byte-identical to both `changes.json`'s and `review.json`'s recorded `stamp.treeHash`. **Conclusion: the re-stamp is legitimate, not a laundered stale gate — the tree has not moved since `dev` wrote `changes.json`, under the correct `autocrlf=true` config the diff is genuinely 5 files/266/36, and `review`'s PASS verdict was computed against exactly the tree on disk now.**

## 3. Inherited CH-01 finding — ruling

`npm run check:secret-access` flags exactly one line: `services/core/src/db/ephemeralMcpCredentials.rls.test.ts:39` (`const TEST_DB_NAME = process.env.CH01_TEST_DB_NAME ?? "ch01_ephemeral_rls_test";` — a test-database name override, not a credential value). `git log --oneline -1` on that file resolves to `079ad62` (CH-01), which predates and is outside CH-06's `apps/web/` lane, and is not present in `changes.json`'s `filesChanged`. **Ruling: not blocking for CH-06.** No CH-06-authored file is flagged by this or any other secret-access gate; `test:secret-access` (39/39), `check:org-secret-access`, and `test:org-secret-access` (8/8) all independently re-run clean. The coordinator is fixing the CH-01 file upstream; that is out of this stage's remit to fix (read-only).

## 4. Mandatory core checks (CORE-01..06)

| Check | Surface | Result | Notes |
|---|---|---|---|
| CORE-01 | tenant-isolation | **PASS** | `PostTurnBody` is exactly `{question, scope, idempotencyKey}`; no org/user/repo id ever enters a client-originated body. |
| CORE-02 | rbac-boundary | **PASS** | No client-side traversal/node-stripping/permission predicate anywhere in `apps/web/app/workspace/chat/`; enforced by `chatSafetyGuards.test.ts` and independently re-grepped. |
| CORE-03 | secret-handling | **PASS** (for CH-06) | See §3. One inherited, non-CH-06 finding, not blocking. |
| CORE-04 | webhook-trust | **UNVERIFIED** | Zero changed paths under `services/`; surface exists elsewhere in the target but wasn't re-examined this run. |
| CORE-05 | ingestion-ephemerality | **UNVERIFIED** | Zero changed paths under `services/workers/`; same reasoning. |
| CORE-06 | injection-boundaries | **PASS** | No SQL/Cypher/shell/queue string construction anywhere in the diff; every request is a typed object serialized once via `JSON.stringify`. |

No tenant-isolation or RBAC-boundary failure. No CRITICAL/HIGH failure among the CORE checks.

## 5. Surface selection

Selected (beyond mandatory CORE): **web-api-client-attacker** (registry trigger `apps/web/**` matches directly — this is the ticket's entire diff) and **websocket-realtime-attacker** (CH-06 adds a second, dedicated client `WebSocket` consuming untrusted `chat.turn.*` frames — a direct sibling attack path to the existing realtime channel, and the task's own briefing specifically named this trust boundary).

Considered and explicitly **not** selected, with reasoning recorded in `manifest.json`'s `surface_inventory`:
- **mcp-transport-key-lifecycle-attacker** — no changed path matches `services/core/src/mcp/**`, `**/*mcp*`, or `**/*api-key*`. CH-06 only renders a server-supplied `chat.mcp_unauthorized` error message; that client-side rendering obligation is a `WEB-11` (error/enumeration leaks) property, not an MCP transport/session/key-issuance property, and is covered there instead (see §6, WEB-11).
- **model-provider-egress-ssrf-attacker** — `ChatProvider.tsx`'s filename coincidentally contains "provider" (a React context provider, not an AI/model provider adapter). Considered deliberately rather than silently skipped, per the orchestrator's "floor, not boundary" guidance: `chatClient.ts` calls only the already-allowlisted internal core-proxy route, never an external model-provider endpoint directly, so no egress/SSRF surface exists in this diff.
- **llm-rag-poisoning-attacker**, **ingestion-queue-webhook-attacker**, **secrets-audit-data-lifecycle-attacker**, **supply-chain-infrastructure-attacker** — no changed path matches any of their trigger globs; CH-06 touches none of `services/workers/**`, `.github/**`, `infra/**`, `scripts/**`, or any dependency manifest.

`npm run check:security-audit-agents` → `Security audit agent validation passed: 8 surface briefs, 108 unique checks, 2 schemas.` (registry itself is not broken).

## 6. Findings from selected briefs (WEB-01..12, WS-01..12)

30 observations total (6 CORE + 12 WEB + 12 WS), one per selected checklist ID, all in `results.json`. Full evidence, attempt, and reproduction/cleanup text per observation is there; summarized here:

**PASS (18):** CORE-01, CORE-02, CORE-03, CORE-06, WEB-01 (no new HTTP surface — the core-proxy allowlist is byte-unchanged), WEB-02 (no injection construction, extremes tested), WEB-03 (XSS — independently re-ran the hostile-payload test: `<script>`, `javascript:` URL, `onerror` attribute all render as literal text, zero `<a>` nodes, zero `href` props, zero `dangerouslySetInnerHTML`), WEB-04 (CSRF — `sayre_session` cookie is `SameSite=Lax`; primary auth is a `localStorage`-sourced Bearer header never auto-attached cross-site), WEB-07 (input ambiguity — structural parsers, no prototype-pollution vector, NaN/Infinity/wrong-type all rejected), WEB-08 (resource consumption — degraded poll bounded to 20 attempts/turn, 64KB/10MB/15s caps on the unchanged proxy, 8000-char input cap), WEB-09 (concurrent-`ask()` dedup — exactly one `POST /chat/conversations` for two concurrent asks), WEB-11 (error leaks — EC-16 test independently re-run: rendered text for a `chat.mcp_unauthorized` frame excludes credential/secret/token/api-key/queue/backlog/sqs vocabulary), WEB-12 (no URL/anchor ever constructed from citation/tool/detail/answer text), WS-03 (token sent as a post-connect message payload, never in the WS URL), WS-06 (`sessionExpiredRef` latch — independently re-ran every EC-24/C2 regression test, 9 files/86 tests green), WS-08 (malformed-frame handling — 20-variant + live-fake-socket tests independently re-run), WS-09 (ordering/idempotency/terminal-precedence — 15/15 independently re-run), WS-11 (no reconnect-storm/leak — single connection attempt per effect run, bounded degraded poll, latch-stopped on session expiry).

**FAIL (1):**
- **WEB-05 — Clickjacking/CSP, MEDIUM, `FND-` (see `results.json` for the exact id).** No `X-Frame-Options`, `Content-Security-Policy`, or `frame-ancestors` anywhere in `apps/web` (grepped the whole app); `next.config.mjs` has no `headers()` key and there is no `middleware.ts`. **Pre-existing, sitewide gap — not introduced or regressed by CH-06**, which adds no headers/middleware config of its own either. Not blocking per the gate rules (MEDIUM, not CRITICAL/HIGH, and not a tenant/RBAC failure). Remediation: add a Next.js `headers()` block or `middleware.ts` setting `X-Frame-Options: DENY` / `frame-ancestors 'none'` and a baseline CSP; recheck by re-running the same grep and, once runtime testing is authorized, a live clickjacking probe.

**UNVERIFIED (11):** CORE-04, CORE-05 (server-side surfaces untouched by this diff, not re-examined), WEB-06 (mass assignment — client constructs no smuggling vector, but server-side field rejection wasn't runtime-tested), WEB-10 (cache headers — unchanged proxy code, deployment-level caching not evaluated), WS-01, WS-02, WS-04, WS-05, WS-07, WS-10, WS-12 (all gateway/server-side halves of the websocket-realtime surface — CH-05 is a parallel, pinned-and-mocked lane not present in this worktree's base commit, so no live gateway existed to test against this run).

**NOT_APPLICABLE:** none. Every selected check produced a definite PASS/FAIL/UNVERIFIED row rather than being marked not-applicable, since the underlying mechanisms genuinely exist somewhere in the pinned target even where this specific diff doesn't touch or exercise them.

## 7. Specific items the coordinator asked to verify

- **No client-supplied identity in the postTurn body:** confirmed. `Object.keys(body).sort()` is exactly `['idempotencyKey','question','scope']`; `JSON.stringify(body)` never matches `/org|repositoryId|userId|repoId/i`. Independently re-ran the test (`AskSayrePanel.test.tsx:582-601`).
- **No client-side RBAC/traversal:** confirmed via `chatSafetyGuards.test.ts` (independently re-run, 3/3) plus my own grep across `chat/`, `askSayreRegistry.ts`, and `components/AskSayrePanel.tsx` — zero source hits for `orgId|org_id|rbac|isAuthorized|canAccess|hasPermission|authorize`, zero `graphology|sigma|/canvas` imports.
- **XSS / injection (AC-17 absolute):** confirmed. Zero `dangerouslySetInnerHTML` under `apps/web/app/workspace/chat/`; zero anchor/`href` construction from server-supplied content anywhere in the diff. The hostile-payload test (`<script>`, `javascript:` URL, `onerror`) independently re-run and passing.
- **Untrusted WebSocket frames (`parseChatGatewayMessage`):** confirmed as the trust boundary. Malformed/hostile frames return `null` without throwing (20 variants tested); a frame for a foreign `conversationId` or unknown `turnId` is discarded with the state reference unchanged (`toBe(state)` — EC-5/EC-6, independently re-run).
- **Secrets in the `chat.mcp_unauthorized` path (EC-16):** confirmed. The client renders only `turn.error.message` as plain text; `turn.error.code` is never rendered. Independently re-ran the test asserting the rendered text excludes credential/queue vocabulary.
- **Canvas rule (no Function/Class node selection):** confirmed. `CHAT_DRAWABLE_CITATION_KINDS` is the frozen `['file','folder','feature','ticket']`; anything else (including `'function'`/`'class'`) maps to `'unknown'`, which `citationTarget` can only resolve to `'none'`. Independently verified via `AskSayrePanel.test.tsx`'s dedicated test pushing `function`/`class`/unmapped `feature`/`ticket` citations and asserting all four render as inert `<span>` chips with zero buttons and zero selection dispatch.
- **Degraded-poll / session-expiry loop hygiene (round-1 Critical C2):** confirmed the `sessionExpiredRef` latch genuinely holds. Read the three check sites (`reconcileNow`, `tick`'s pre-request and post-reconcile guards, `handleClose`'s pre-4401 check) and independently re-ran every regression test in `chatDegradedRecovery.test.tsx` (7/7) plus `AskSayrePanel.test.tsx`'s EC-24 tests — all green, 9 files/86 tests in the chat directory, 435/435 for the full `apps/web` suite.

## 8. Mechanical verification (independently re-run, not read off prior stage reports)

- `npx vitest run` (from `apps/web`): **69 files / 435 tests passing**, exit 0.
- `npx vitest run app/workspace/chat/ app/workspace/askSayreRegistry.test.ts`: **9 files / 86 tests passing**, exit 0.
- `npx tsc --noEmit` (from `apps/web`): clean, exit 0.
- `npx next lint` (from `apps/web`): "No ESLint warnings or errors", exit 0.
- `npm run check:secret-access`: exit 1, exactly one flagged line (§3, not CH-06).
- `npm run test:secret-access`: 39/39 pass.
- `npm run check:org-secret-access` / `npm run test:org-secret-access`: pass, 8/8.
- `npm run check:security-audit-agents`: `8 surface briefs, 108 unique checks, 2 schemas` — registry validated.

## 9. Coverage trajectory

`FIRST_OBSERVATION` for all 30 observations (no baseline). Coverage transition `NOT_COMPARABLE` for all 30 (no baseline to compare against).

## 10. Single points of failure

None identified among PASS observations. WS-06 (session-expiry latch) is backed by three independent check sites (`reconcileNow`, `tick`'s guards, `handleClose`), not a single choke point — consistent with `review.md`'s own mutation analysis (removing either the latch or the `stillActive` refactor alone still holds the EC-24 guarantee on the paths tested; only removing both breaks it).

## 11. Cleanup

No fixture, scratch repo, `.pipeline/` construction, or throwaway directory was created during this run beyond the immutable run directory itself and the scratch script used to generate `manifest.json`/`results.json` (session scratchpad, outside the repository). No repository file outside `.pipeline/security-history/20260811T045119987Z-6d3acfc-PR_DELTA-e8d162/`, `.pipeline/security-report.md`, and `.pipeline/security.json` was created, modified, or left behind by this stage.

## 12. Recheck scope

- **WEB-05 (MEDIUM, open):** re-run the header grep and, once a live target is authorized, a clickjacking probe, after a `headers()`/`middleware.ts` fix lands (any ticket touching `apps/web/next.config.mjs` or adding `middleware.ts` should close this).
- **The 11 UNVERIFIED observations tied to CH-05's server/gateway half** (WS-01, WS-02, WS-04, WS-05, WS-07, WS-10, WS-12) and to untouched server surfaces (CORE-04, CORE-05, WEB-06, WEB-10): recheck once CH-05 is merged into this lineage and a live gateway/core instance is available and runtime-testing is authorized — a `REMEDIATION_RECHECK` or the next `MILESTONE`/`FULL` run should pick these up rather than leaving them permanently unexercised.

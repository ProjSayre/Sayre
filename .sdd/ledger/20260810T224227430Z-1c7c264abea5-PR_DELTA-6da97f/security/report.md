# Security Audit Report -- CH-02 (getReadyTickets service function + get_ready_tickets MCP tool) -- re-gate

**Run ID:** `20260810T224227430Z-1c7c264abea5-PR_DELTA-6da97f`
**Verdict:** **PASS**
**Mode:** `PR_DELTA`
**Target commit:** `1c7c264abea51d7ab8de447c5442dc3dd1942551` (branch `ticket/ch-02-get-ready-tickets`, dirty -- one uncommitted hand-edit is the change under audit beyond the committed CH-02 diff)
**Environment:** local dev worktree, no live Neo4j/Postgres, `node_modules` installed
**Baseline:** `20260810T213122828Z-ee496aa4985f-PR_DELTA-1a11c5` (this same ticket's own prior PASS run)

This is **step 4 of `/re-gate`**, not a fresh pipeline run. `.pipeline/review.json`'s verdict is `PASS`; `node scripts/check-stamp-freshness.mjs review.json` independently re-run by this stage returns `"status": "fresh"`, exit `0` -- safe to proceed. `.pipeline/spec.md`/`changes.md`/`review.md` were read per this stage's Required Inputs; `changes.md`'s narrative was treated as advisory (it describes the tree before the rebase and before the hand-edit), per this stage's own "Staleness of required inputs" contract -- every fact below was re-derived from my own `git diff`/`git show`/hash computation/test runs, not taken from any prior stage's self-report.

## 1. Target and environment

Repository `projsayre/sayre`, working path `C:\Users\splat\OneDrive\Desktop\Sayre\.claude\worktrees\agent-adeaa049fb5ae5378`. CH-02's own diff (re-derived, not taken from `changes.json`) = `git diff 7ba3067` (commits `c6b9616` feat + `1c7c264` ledger-chore) **plus** the one uncommitted working-tree edit to `services/core/src/services/ticketReadinessService.ts`. 17 code/doc paths changed (see `manifest.json`'s `target.changed_paths`); this re-gate's diff is one file larger than baseline's (16) because `services/core/src/security/ch01UnmodifiedSurfaces.test.ts` is now in scope -- a file that did not exist at baseline's audited commit at all (CH-01 postdates it in this worktree's history).

`spec.json`/`red.json`/`changes.json` report `"stale"` -- expected for a re-gate (the rebase + hand-edit moved the tree past every one of those stamps); all three are advisory/re-derived per this stage's contract, so this is a Limitations note, not a refusal. `review.json` is the one trusted-fresh input and was independently re-verified fresh before this run began.

## 2. Baseline

`20260810T213122828Z-ee496aa4985f-PR_DELTA-1a11c5` -- this exact ticket's own prior `PASS` run, selected per `audit-contract.md`'s baseline order item 1/2. Ancestry independently verified: `git merge-base --is-ancestor ee496aa4985fc4145afbadf34c54de9cf3e9910a HEAD` exits `0` (ee496aa is four commits behind current HEAD: `ee496aa` -> `079ad62` CH-01 feat -> `7ba3067` CH-01 ledger -> `c6b9616` CH-02 feat -> `1c7c264` CH-02 ledger). Environment string and tenant-fixture list are copied verbatim from the baseline manifest (required for `comparable: true`); `incompatible_dimensions` is empty.

**What is genuinely new since that baseline and could not have been seen by it:** the entire CH-01 codebase (ephemeral scoped MCP credentials) is now the base this branch is stacked on. The baseline run's own target commit, `ee496aa`, is the commit immediately *before* CH-01 existed in this worktree -- so no baseline observation, however worded, ever actually exercised "an ephemeral `chat_ephemeral` credential calling `get_ready_tickets`." This run closes that gap explicitly (see Sections 6/7 below) rather than silently inheriting baseline's `PASS` for a combination it never tested.

## 3. Surface selection

Unchanged from baseline: **CORE-01..CORE-06** (mandatory) and **mcp-transport-key-lifecycle-attacker** (`services/core/src/mcp/**` directly matched). The newly-in-scope `services/core/src/security/ch01UnmodifiedSurfaces.test.ts` was checked against every registry trigger path by filename substring and does not match any additional surface (no `secret`/`audit`/`backup`/`delet` substring, no `mcp`/`api-key` substring in its own path). No surface selection changed from baseline.

## 4. What changed since the baseline audit (re-derived, not taken from any prior report)

Two things, and only two things, changed in CH-02's own code/tests since the commit baseline actually audited:

1. **`services/core/src/services/ticketReadinessService.ts`, `featureGroupKey` -- the hand-edit.** A literal NUL byte (0x00), used as the composite grouping-key separator inside a template literal, was replaced with the six-character JavaScript escape sequence for the same code point. I did **not** take this at face value. Independently reconstructed: `git show HEAD:<path>` is 6291 bytes with exactly one `0x00` at offset 5030; the working-tree file is 6296 bytes with zero `0x00` bytes; replacing that single byte in the HEAD blob with the literal 6-byte sequence (backslash, u, 0, 0, 0, 0) and concatenating around it reproduces the working-tree file **exactly** (`Buffer.compare === 0`); the bytes before and after the substitution point are independently byte-identical between HEAD and the working tree. This is provably nothing but that one substitution -- a separator-encoding fix with zero semantic effect (the escape sequence inside a template literal *is* U+0000), and `featureGroupKey`'s return value is used only as an in-memory JS comparison/grouping key inside this same file, never concatenated into Cypher, SQL, a shell command, or a queue payload -- so it has no bearing on CORE-01/02/06.
2. **`services/core/src/security/ch01UnmodifiedSurfaces.test.ts` -- the CH-01/CH-02 restack resolution.** See Section 7.

Nothing else in CH-02's own file set differs in substance from what the baseline run already deeply audited (Cypher text, mapper, service function, MCP handler/registration are all byte-identical to what baseline reviewed -- confirmed by `git diff 7ba3067` showing no hunks in those files beyond the initial CH-02 feature commit itself, which is the same commit baseline's own dirty-diff became).

## 5. Mandatory core checks (CORE-01..06)

| Check | Surface | Result | Severity | vs. baseline |
|---|---|---|---|---|
| CORE-01 Tenant isolation | tenant-isolation | **PASS** (v1 carried forward + **v2 new**) | NONE | UNCHANGED / FIRST_OBSERVATION |
| CORE-02 RBAC boundary | rbac-boundary | **PASS** (v1 carried forward + **v2 new**) | NONE | UNCHANGED / FIRST_OBSERVATION |
| CORE-03 Secrets | secret-handling | **PASS** | NONE | UNCHANGED |
| CORE-04 Webhook trust | webhook-trust | NOT_APPLICABLE | NONE | UNCHANGED |
| CORE-05 Data ephemerality | ingestion-ephemerality | NOT_APPLICABLE | NONE | UNCHANGED |
| CORE-06 Injection boundaries | injection-boundaries | **PASS** | NONE | UNCHANGED |

CORE-01 and CORE-02 each carry two observations this run: the `v1` row is the baseline finding, re-verified and confirmed unchanged (both the hand-edit and the test-pin change are independently proven not to affect it); the `v2` row is a genuinely new observation, with no baseline counterpart, covering the CH-01xCH-02 interaction specifically (see Section 6).

## 6. The CH-01 x CH-02 interaction (the thing the baseline run structurally could not have tested)

Static architectural proof first (Phase A, cold-model style, before building any dynamic reproduction): I read `gateway.ts`'s `createServer` end to end. All 10 `registerTool` calls, including the new `get_ready_tickets`, dispatch through the identical pattern: `execute(tool, () => handler(credential.context, deps.services))`. `toolExecution.ts`'s `executeMcpTool` is likewise credential-kind-blind -- its only kind-sensitive field is `credential.meteringSubject`, used solely for rate-limit/metrics bucketing, never for authorization. The **only** place `credential.kind` is ever inspected in the entire MCP surface is inside `resolveMcpCredential`'s pre-dispatch rejection disjunction (`mcpKeyService.ts`) -- which runs identically, before any tool (including `get_ready_tickets`) is even selected. There is zero per-tool conditional branching on credential kind anywhere in the dispatch path, by direct source read, not by inference.

I then closed the gap with real dynamic evidence rather than resting on the static argument alone. Built a throwaway reproduction driving the **real, unmodified** `createMcpGatewayRouter`, the **real** `resolveMcpCredential`, and the **real** `mintEphemeralMcpCredential` end to end over real HTTP via the official MCP SDK client, with only the store/permissions/graph-query boundary faked (the same substitution convention `gateway.test.ts`, CH-01's own `ephemeralMcpGateway.test.ts`, and the baseline run's own dynamic probes already use). Minted a `chat_ephemeral` credential with a deliberately **narrow** mint-time ceiling (one repository-root allow rule), then called `get_ready_tickets` twice: once cleanly, once with a smuggled `org_id`/`orgId`/`__proto__` argument set.

**All 9 assertions passed:**

- The tool call succeeds and returns the fixture's ORG_A ticket.
- The fake graph-query double received `ctx.orgId === ORG_A` -- the credential's own org -- on both calls; the smuggled `org_id`/`orgId` (a different org) never reached it.
- The handler received `{ subjectType: 'agent_key', agentKeyId: <mc_chat_... prefix>, orgId, roles: ['member'] }` -- the identical shape CH-01's own `ephemeralMcpGateway.test.ts` already proved for `get_node_context`/`find_relevant_nodes`, now confirmed for the new tenth tool specifically.
- The metering/rate-limit bucket recorded was `chat:<issuing user id>` -- CH-01's AC-9 semantics extend to `get_ready_tickets` with zero code change, by construction (no tool-name branch exists in that bucketing logic).
- The smuggled-argument call's response was **byte-identical** (`JSON.stringify` equality) to the clean call's response.
- `Object.prototype.polluted` was `undefined` after the `__proto__`-keyed call -- no prototype pollution.

This closes the specific gap the coordinator asked me to form my own view on: an ephemeral chat credential authorizing the new tool behaves exactly like an agent key authorizing it, provably so, both statically (no branch exists to make it behave otherwise) and dynamically (it did not, in a live reproduction against real production code).

**One honest, non-blocking gap noted rather than glossed over:** CH-01's own `ephemeralMcpGateway.test.ts` fixture's `McpToolServices` object does **not** include a `getReadyTickets` entry at all -- it predates CH-02 and was never updated, because `services/core/tsconfig.json` excludes `*.test.ts` from typechecking (the same exclusion `spec.md`'s own "bounded incidental fix" narrative documents for `gateway.test.ts`'s `checkLiveness` gap), so nothing caught the omission mechanically. This is a **test-fixture completeness gap in a CH-01-owned file CH-02 never touches** (confirmed: absent from `git diff 7ba3067 --name-only`), not a production gap -- the real `mcpToolServices` singleton (`toolServices.ts`) does include `getReadyTickets`, confirmed by direct read and by this run's own dynamic probe succeeding against the real gateway. Recorded in Limitations; not a finding.

## 7. `ch01UnmodifiedSurfaces.test.ts` -- independent adjudication

This is a security-assertion file, and "a later lane edits an earlier lane's security pin" is exactly the pattern worth attacking, so I re-derived every claim myself rather than accepting review's account.

- **`git diff 7ba3067 -- services/core/src/security/ch01UnmodifiedSurfaces.test.ts`** shows exactly two changes: the `mcp/gateway.ts` digest value (plus an attached explanatory comment naming CH-02) and `'getReadyTickets.ts'` added to the expected handler-file list (plus an attached comment). Nothing else in the file's diff -- no assertion softened in form: both `it(...)` bodies still use exact `toEqual` over a full digest map / a full sorted file list; no `.toContain`, `.skip`, or conditional appeared anywhere in the diff.
- **Is the new digest real?** Independently recomputed this run (not copied from `review.md`): LF-normalized SHA-256 of the current `services/core/src/mcp/gateway.ts` is `345714cbab7ae1ac94bbfdd2f2fcd23fb370ad35b29a820d8840c4e2dd72bf92` -- an exact match to the recorded pin.
- **Are the untouched pins actually untouched?** Independently recomputed: `graph-query/permissions.ts` -> `9214393292ab24cb90eaf26278b19ba9cadc626d43590d07b3f3c33d9a86ce69` and `auth/context.ts` -> `c4d3003a7b4861b233a4e9a4c50886b20e67a14bf25583c2bf48720ef9063163`, both exact matches to the pins the diff leaves unchanged -- the two most security-load-bearing files this test pins are provably still byte-identical to CH-01's original commit, not merely "not present in the diff hunk."
- **Is the change that forced the digest update itself small and reviewed?** `git diff ee496aa..7ba3067 -- services/core/src/mcp/gateway.ts` is empty -- CH-01 itself left `gateway.ts` untouched, confirming the file's own header claim independently. The current digest change is entirely attributable to CH-02's own `get_ready_tickets` registration, which I read in full (Sections 5/6 above): read-only annotations, no `inputSchema`, delegates through the existing `execute(...)` wrapper.

**Judgment:** honest, correctly executed, and it does not weaken the CH-01 security invariant this test exists to protect. Agreeing with review's independent conclusion, but reached by re-deriving every load-bearing number myself rather than trusting its account.

## 8. Verification re-run independently (not accepted from any prior report)

- `npx tsc --noEmit` (root): exit `0`.
- `npx eslint . --ext .ts` (services/core): exit `0`.
- `npx vitest run` on the 7 directly implicated test files: **7 files / 56 tests passed / 0 failed.**
- `npx vitest run` (full `services/core` suite): **107 files / 1100 passed / 7 skipped / 0 failed** -- exact match to the numbers `changes.md`/`review.md` report.
- `node scripts/check-red-integrity.mjs`: exit `1`, 2 violations, 1 note -- independently re-adjudicated as CRLF-only false positives (see Section 9), not re-inherited from review's account.

## 9. `check-red-integrity.mjs`'s 2 violations -- independently re-confirmed as CRLF artifacts

For both flagged files, I recomputed the raw committed-blob SHA-256 myself (`git show HEAD:<path>` piped directly into `createHash('sha256')`, no normalization applied) and compared against `red.json`'s recorded value:

| File | raw committed SHA-256 (this run) | `red.json` recorded SHA-256 | Match | CRLF in committed blob? |
|---|---|---|---|---|
| `services/core/src/services/ticketReadinessService.test.ts` | `778772f6e174490d03dd2b1856f4faeefb34a5c8243bb4d854781bbe3e15adf3` | `778772f6e174490d03dd2b1856f4faeefb34a5c8243bb4d854781bbe3e15adf3` | **exact** | no |
| `services/core/src/graph-query/ticketReadiness.test.ts` | `4d9038f4b4936c439c7922ae865c75965bc9477f4df6995770af2956177f77a9` | `4d9038f4b4936c439c7922ae865c75965bc9477f4df6995770af2956177f77a9` | **exact** | no |

The committed repository content is byte-identical to what `red` hashed, with **no normalization applied at all** in this comparison. `check-red-integrity.mjs`'s violation is against the *working-tree* read, which this checkout's `core.autocrlf=true` materializes with CRLF. This is a Windows-checkout artifact, not an undeclared red-test change -- independently reconfirmed, not inherited.

## 10. Findings

**None.** Zero `FAIL` observations across all 20 selected checks (18 carried forward, 2 new).

## 11. Security trajectory vs. baseline

- **New:** 0 findings.
- **Regressed:** 0.
- **Persisting:** 0 (baseline had 0 findings).
- **Resolved:** 0.
- **Risk-accepted:** 0.
- **New coverage (not a finding, an added observation):** CORE-01 v2 and CORE-02 v2 -- the CH-01xCH-02 interaction, `FIRST_OBSERVATION` (no baseline counterpart existed for this attack path).

## 12. Coverage trajectory vs. baseline

18 of 18 baseline observations: **UNCHANGED** coverage (same evidence quality -- PASS/NOT_APPLICABLE/UNVERIFIED results reproduce identically, all independently re-verified rather than copy-forwarded). 2 new observations (CORE-01/CORE-02 v2): **NOT_COMPARABLE** (no baseline counterpart to compare against -- by construction, since the attack path itself is new).

## 13. Verified clean

CORE-01, CORE-02 (both v1 re-confirmed and v2 newly proven), CORE-03, CORE-06, MCPT-01, MCPT-02, MCPT-06 (with baseline's stated caveat carried forward), MCPT-07, MCPT-12 -- all affirmatively re-tested this run with static and/or fresh dynamic evidence, not copy-forwarded from baseline's prose.

## 14. Limitations

- No live Neo4j/Postgres in this environment (unchanged from baseline).
- MCPT-09/10/11 remain `UNVERIFIED` in this run's own scope (CH-02's diff doesn't touch key-lifecycle code, no live Postgres here) -- but CH-01's own already-`PASS`ed security run independently exercised this surface against real Postgres; not re-litigated here.
- `check-red-integrity.mjs`'s 2 violations are CRLF checkout artifacts, independently reconfirmed (Section 9), already adjudicated by tester/review -- judged, not rediscovered, per the coordinator's own framing.
- `spec.json`/`red.json`/`changes.json` are `"stale"` -- advisory, expected for a re-gate.
- CH-01's `ephemeralMcpGateway.test.ts` fixture omits `getReadyTickets` from its `McpToolServices` double -- a pre-existing, out-of-CH-02's-scope test-completeness gap, not a production gap (Section 6).
- Surfaces `llm-rag`, `model-provider`, `websocket-realtime`, `ingestion-queue-webhook`, `web-api-client`, `secrets-audit-data-lifecycle`, `supply-chain-infrastructure` remain inventoried, not audited -- unchanged from baseline.
- This run's dynamic ephemeral-credential probe used fully-faked store/permissions/graph-query doubles (this environment has no live Postgres); it proves the dispatch/authorization plumbing is credential-kind-agnostic, not a live-database re-proof of CH-01's own ceiling-intersection arithmetic (already independently proven against real Postgres in CH-01's own security run).

## 15. Cleanup

Two throwaway scripts were created and deleted this run:

1. A one-line module-resolution smoke test, created under the OS temp scratchpad directory, deleted immediately after use.
2. The dynamic CH-01xCH-02 reproduction (Section 6), created under `.pipeline/security-scratch-msnt92jn-o5mzun/` (a security-checker-writable location per `scripts/guard-checker-readonly.mjs`'s allowlist), run via `npx tsx`, deleted immediately after use together with its containing directory.

`git status --porcelain` before and after this entire run is identical: exactly one dirty path, `services/core/src/services/ticketReadinessService.ts` (the pre-existing hand-edit under re-gate). No repository file was created, modified, or left behind by this stage beyond the required `.pipeline/security-history/<run-id>/` artifact directory itself.

## 16. Recheck scope (if this ever needs re-running)

- If `mcpKeyService.ts`/`ephemeralMcpCredentialService.ts` are ever touched by a future ticket, re-run MCPT-09/10/11 with a live Postgres available (same scope CH-01's own report already names).
- If CH-01's `ephemeralMcpGateway.test.ts` is ever updated to add a `getReadyTickets` fixture entry, no re-check of this run's findings is needed -- this run's dynamic probe already independently proves the same property production-side.
- If `featureGroupKey`/the ESC-spelling convention changes again, re-verify byte-exactness against the committed blob the same way this run did (Section 4), not by trusting a prose description of the change.

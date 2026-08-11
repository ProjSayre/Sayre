# Security Audit Report — CH-04 (Worker agent loop: MCP-client chat consumer) — /re-gate

**Run ID:** `20260811T093143000Z-934a5ae-REMEDIATION_RECHECK-36b26b`
**Mode:** REMEDIATION_RECHECK
**Verdict:** **PASS**

## 1. Target and environment

- Repository: `projsayre/sayre`, working path `C:/Users/splat/OneDrive/Desktop/Sayre/.claude/worktrees/agent-a5212a58710c1e0d7`
- Commit: `934a5ae00c4eec0e477bcdf2f33b171f79f81b71` (branch `ticket/ch-04-worker-agent-loop`), dirty: true
- The dirty delta is exactly one file: `services/core/src/db/ephemeralMcpCredentials.rls.test.ts` (+62/-9), a fixture repair for migration 0021's new composite FK. `git status --porcelain --untracked-files=all` shows no other change.
- The committed CH-04 implementation itself (`git diff 25f60fa..HEAD`, 31 files excluding `.pipeline`/`.sdd/ledger`) is confirmed **byte-identical** this run to what `review.json` PASSed (2026-08-11T01:02:12Z) and what the baseline security run below PASSed -- independently re-diffed this pass, not assumed.
- Environment: local worktree; this REMEDIATION_RECHECK is authorized for, and uses, dynamic verification against the local Docker Postgres instance (`pgvector/pgvector:pg16`, container `sayre-postgres`). No live Redis, Core MCP gateway, or ModelProvider runtime was authorized or exercised against a network target.
- Gate precondition: `.pipeline/review.json` verdict `PASS`, stamp confirmed **fresh** (`node scripts/check-stamp-freshness.mjs review.json` -> `status: fresh`, exit 0) both before and after this run.

## 2. Baseline and comparability

**Baseline:** `20260811T010720502Z-25988f3-PR_DELTA-3a73ea` (this ticket's own prior, terminal-PASS security run).

**Marked `comparable: false`, deliberately.** Two dimensions are materially incompatible, per `audit-contract.md` section 2:

1. **Commit ancestry.** The baseline's `target.commit_sha` (`25988f3e...`) is not an ancestor of the current commit -- the branch was rebased onto a new CH-03 base between that run and this one. Content-identity of the *unchanged* CH-04 implementation was independently re-verified instead, by diffing against the correct, stable CH-03 base (`25f60fa`) and confirming it reproduces the exact same 31-file diff the baseline run audited.
2. **Environment.** The baseline run had **zero** live Postgres/Redis/Core-MCP-gateway/ModelProvider access (its own `target.environment` says so explicitly). This run is authorized for, and uses, live Postgres -- which is exactly why SEC-11 and SC-13 could move from `UNVERIFIED` to an evidenced result this run. Comparing a static-only run to a run with new dynamic capability as if nothing changed would misattribute a capability gain as a content change.

Per the contract, a materially incompatible baseline sets `comparable: false`, and every observation's mechanical `result_transition`/`coverage_transition` is `NOT_COMPARABLE` with `previous_result: null` -- that is a disclosed **validator/schema consequence**, not a claim that nothing is known about the trend. The real trajectory is narrated below, citing the baseline's actual prior results by value.

## 3. Security trajectory (narrated, since the schema fields are mechanically NOT_COMPARABLE)

**New finding this run -- SEC-11 (MEDIUM, non-blocking, `FND-a3a47aa34c47`).** Baseline result: `UNVERIFIED` ("no authorized live Postgres... marked UNVERIFIED rather than PASS"). This run's result: **`FAIL`**, with direct dynamic evidence (see section 5). This is *not* a regression -- nothing was ever affirmatively `PASS` here -- it is the first time this check could produce evidence at all, and the evidence shows a real, previously-undiscovered functional defect (detailed in section 5).

**Resolved-to-evidence this run -- SC-13 (PASS, was UNVERIFIED).** Baseline could not exercise migration 0021's live-apply behavior. This run applied it via the real drizzle migrator against a live database and independently confirmed the trigger fires and is `SECURITY INVOKER` on the *deployed* object, not just the source text.

**Unchanged, re-confirmed by direct re-read this pass (not carried over unread):** CORE-01, CORE-02, CORE-03, CORE-06, MCPT-09, MCPT-10, MCPT-11, WS-07, MP-12 -- every citation in the baseline's evidence was independently re-read against the current tree this pass and matched exactly. No drift found.

**Unchanged, still open -- LLM-09 (`FND-477e4cbf5856`, MEDIUM, non-blocking).** Re-read `agent.py`/`models.py` directly this pass: content is byte-identical to the audited version. The decide<->act loop still bounds `tools/call` invocations (8) but not `decide_node`'s `generate_structured` call count; `recursion_limit=200` remains the only other ceiling. Not addressed by this hand-edit (a database test file, unrelated surface) and not addressed by the original implementation. Still `OPEN`, still non-blocking (MEDIUM, no tenant/RBAC dimension, fails safe into `chat.internal`/`chat.timeout`).

**All other baseline observations** (the remaining ~99) are carried forward with their original evidence plus one added line confirming this pass re-derived their content-identity via `git diff 25f60fa..HEAD`, rather than trusting the baseline's own claim. None of their code was touched by this hand-edit; none needed re-derivation of result.

## 4. Answers to the four re-gate questions in the task brief

**(1) Does the hand-edit weaken any security property?** **No.** Independently re-verified by two methods (both re-run this pass, not read from `changes.md`/`review.md`):

- `git diff HEAD -G "assert\."` on the hand-edited file: **zero** added or removed lines match `assert.` -- every one of the file's 62 added / 9 removed lines is fixture construction (`randomUUID()` calls, a new `createConversation()` helper, per-test setup), never an assertion.
- Line-by-line read of the two assertions the task brief specifically named:
  - `listByConversation(orgB.orgId, conversationId, null)` still asserts `[]` (line 313) -- unchanged text.
  - `deleteExpired`'s cross-tenant assertion `assert.equal(keptCeiling.rowCount, 1, "another org's ceiling rows are untouched")` (line 560) still requires Org B's ceiling row to survive Org A's `deleteExpired` call -- unchanged text. The fixture now uses two distinct *real* per-org conversations instead of one shared synthetic id, which makes this proof **stricter**, not weaker (a shared id could mask a bug a real per-org FK would expose).

Re-executed the whole suite against live Postgres this run: `test:rls:ephemeral:ci` -> **7/7 pass**, including both assertions above by name. `test:rls:acceptance:ci` -> **64/64**, `test:rls:ci` -> **19/19**, `chatStore.rls.test.ts` direct -> **11/11** -- all match `test-results.md`/`review.md`'s reported counts exactly.

**(2) The new cascade route -- is it a safe tightening, or does it create a way to destroy another tenant's credentials or orphan `permissions` ceiling rows?**

**Neither, cleanly.** Dynamically reproduced in disposable, rolled-back transactions against a live database (full detail under SEC-11 in section 5):

- The `delete_ephemeral_ceiling` trigger **cannot** over-delete: its `DELETE FROM permissions` is scoped by `org_id = OLD.org_id AND subject_type = 'agent_key' AND subject_id = OLD.key_prefix`, and `key_prefix` carries a table-wide `UNIQUE` constraint (confirmed via `\d mcp_client_keys`) -- even without the `org_id` predicate, a `key_prefix` collision across tenants is structurally impossible. Confirmed it never fires for `kind='agent'` rows (the `IF OLD.kind = 'chat_ephemeral'` guard, exercised directly).
- The composite FK **cannot** bind a credential to another tenant's conversation: an Org-A key row pointed at Org-B's real conversation id is rejected by `mcp_client_keys_org_conversation_fk` (dynamically reproduced, EC-27).
- **But** the cascade route as currently written **does not complete** for the one shape that's actually production-reachable: a user who is both a conversation's owner and the credential's `created_by` (which, given CH-03's owner-only chat model, is the *only* shape that exists). Deleting such a user raises an unhandled Postgres FK-constraint error and the whole `DELETE FROM users` statement aborts -- a genuine, newly-discovered functional defect (SEC-11, MEDIUM, non-blocking; see section 5), not a security regression. It fails **closed** (whole-transaction abort, zero partial state, zero cross-tenant leakage in every reproduction), so it is not a way to destroy another tenant's credentials or orphan ceiling rows -- it is a way to accidentally *block* a legitimate user-deletion operation once one exists, which does not exist in shipped code today.

**(3) Core CH-04 posture, re-confirmed against the current tree (all unchanged, all re-derived from source this pass, not carried over):**

- Ephemeral MCP credential never logged/persisted/serialized into an event: `mcp_credential: str = field(repr=False)` (`models.py:77`); the store (`store.py`) has no credential column/parameter; the only two `logger.*` calls in `service.py` log `turn_id` and channel name only.
- `org_id` never accepted from client input: Core derives it via `ownerFrom(ctx)` (never `req.body`); the Python side takes it from `envelope.org_id` exclusively, using `payload.orgId` only for an equality check against it.
- The ephemeral credential's ceiling cannot exceed the issuing user's effective scope: `defaultMintChatCredential(conversationId, ctx) => mintEphemeralMcpCredential({ conversationId }, ctx)` passes no scope-override field; `parseMintInput` accepts only `{conversationId[, ttlSeconds]}`; `getReadScope(ctx)` is derived from the same `AuthContext` `postTurn`'s own caller validated, never an elevated context.
- The Redis channel envelope carries a trustworthy `org_id`: `chat_event_channel(org_id, conversation_id)` and all three event builders set `org_id=job.org_id` (server-derived) at the top level of the envelope, exactly where CH-05's RBAC re-filter needs it per `.claude/rules/security-multitenancy.md`.
- No vendor LLM SDK call bypasses `ModelProvider`: `test_chat_boundaries.py`'s static AST check (re-confirmed present and unchanged) forbids `{anthropic, openai, graphifyy, neo4j, boto3}` imports anywhere under `sayre_workers/chat/`; the only two generation call sites are `state["provider"].generate_structured(...)` / `.generate(...)`.

**(4) `FND-477e4cbf5856` (LLM-09) -- still stands, still non-blocking.** See section 3 above. Unchanged code, unchanged classification (MEDIUM, `OPEN`).

## 5. SEC-11 -- full finding detail

**`FND-a3a47aa34c47`, MEDIUM, `OPEN`, non-blocking.**

Migration 0021 adds `mcp_client_keys_org_conversation_fk ... ON DELETE cascade` and a `delete_ephemeral_ceiling` `AFTER DELETE` trigger. `chat_conversations` already has `chat_conversations_org_user_fk (org_id, user_id) -> users(org_id, id) ON DELETE cascade` (migration 0020), and `mcp_client_keys` separately has `mcp_client_keys_created_by_users_id_fk (created_by) -> users(id) ON DELETE SET NULL`.

Deleting a `users` row that is **both** the owner of one of their `chat_conversations` rows **and** the `created_by` of an ephemeral `mcp_client_keys` row bound to that same conversation (CH-03's owner-only chat model makes this the *only* possible shape) raises:

```
ERROR: insert or update on table "mcp_client_keys" violates foreign key constraint "mcp_client_keys_org_conversation_fk"
DETAIL: Key (org_id, conversation_id)=(...) is not present in table "chat_conversations".
```

and the entire `DELETE FROM users` statement fails -- reproduced twice (with and without a second, unrelated `mcp_client_keys` row present, ruling out an unrelated-row interaction). A control reproduction confirms the *same* delete succeeds cleanly when the deleted user is only the conversation owner and a *different* user is `created_by` -- isolating the defect to PostgreSQL's unspecified firing order between the two independent FK actions (`ON DELETE CASCADE` via the conversation path, `ON DELETE SET NULL` via the direct `created_by` path) queued from one top-level statement.

**Impact:** no cross-tenant or orphaning consequence in any reproduction -- every failure is a whole-transaction abort (fail-closed), confirmed by explicit before/after row counts across both organizations in every disposable transaction. **Not currently exploitable or reachable**: `grep -rn "DELETE FROM users" services/core/src` matches only test files; no production route, service, or job deletes a `users` row today.

**Validated remediation** (in the same disposable, rolled-back transaction, not applied to any tracked file): making `mcp_client_keys_org_conversation_fk` `DEFERRABLE INITIALLY DEFERRED` resolves the reproduction cleanly. This is offered as a concrete, tested starting point for whoever picks up the finding, not as a claim that this stage modified the migration.

**Why non-blocking:** not a tenant-isolation or RBAC-boundary failure (the two things this stage's gate policy treats as unconditionally blocking regardless of severity); MEDIUM severity; not currently reachable via any shipped code path; fails closed, not open. It **must** be fixed before any user-deletion / account-offboarding / GDPR-erasure feature ships, since that feature's first real user (any owner of a recent/active chat conversation) would hit it immediately -- recorded as the finding's remediation reference.

**Correction to the review record:** `review.md`'s Warning 2 states "The production-reachable outcome after 0021 is *stronger*, not weaker: the key row is deleted outright and 0021's `delete_ephemeral_ceiling` trigger removes its `permissions` ceiling rows." This is now known to be incorrect for the one shape that is actually production-reachable -- the delete does not complete at all in that shape. This is a correction of fact discovered by this run's newly-authorized dynamic access, not a fault in `review`'s own reasoning (which had no live database to test against at the time).

## 6. Coverage trajectory

- **Gained** (moved from no/insufficient evidence to an evidenced result): SEC-11 (`UNVERIFIED -> FAIL`), SC-13 (`UNVERIFIED -> PASS`).
- **Unchanged, re-confirmed by fresh re-derivation rather than by carrying the claim forward unread:** CORE-01, CORE-02, CORE-03, CORE-06, MCPT-09/10/11, WS-07, MP-12, LLM-09 (9 checks).
- **Unchanged, carried forward on the strength of an independently re-verified content-identical diff** (not independently re-read line-by-line this pass): the remaining ~99 observations.
- **Lost:** none.
- Machine-readable `coverage_transition` is `NOT_COMPARABLE` for every observation, per section 2's comparability decision -- this section is the narrated equivalent.

## 7. Findings summary

| Finding | Check | Severity | Status | New this run? |
| --- | --- | --- | --- | --- |
| `FND-a3a47aa34c47` | SEC-11 | MEDIUM | OPEN | Yes -- first evidenced result (was UNVERIFIED) |
| `FND-477e4cbf5856` | LLM-09 | MEDIUM | OPEN | No -- unchanged, re-confirmed |

No CRITICAL or HIGH finding. No tenant-isolation or RBAC-boundary failure. Both open findings are non-blocking per this stage's gate policy.

## 8. Verified clean (re-derived this pass, not carried over unread)

- The hand-edit weakens no assertion (pickaxe + line-by-line read, both re-run).
- `mcp_client_keys_delete_ephemeral_ceiling` cannot over-delete across tenants or `kind`s (structural: unique `key_prefix` + `org_id` predicate + `kind` guard, plus a direct-delete dynamic reproduction).
- The composite FK rejects cross-org conversation binding (EC-27, dynamically reproduced).
- Ephemeral credential never logged/persisted/serialized (re-read).
- `org_id` never client-supplied (re-read, both languages).
- Credential ceiling bound to the issuing user's live scope (re-read).
- Redis envelope `org_id` trustworthy for CH-05 (re-read).
- No vendor SDK bypass of `ModelProvider` (re-read, static AST test unchanged).
- `test:rls:ephemeral:ci` 7/7, `test:rls:acceptance:ci` 64/64, `test:rls:ci` 19/19, `chatStore.rls.test.ts` 11/11, `npx tsc --noEmit` clean -- all independently re-run.

## 9. Limitations

- Baseline machine-comparability deliberately declined (see section 2); real trajectory narrated by value instead.
- MCPT-08/MP-09 (MCP response-size bounding) and MP-02/MP-08 (redirect defaults, production TLS) remain `UNVERIFIED`, unchanged from baseline -- outside this re-gate's scope, not independently re-derived this pass.
- Full `services/workers` pytest fleet and full `services/core` vitest run were not re-executed this pass (already re-verified matching baseline by `review`'s own re-gate pass, and `vitest.config.ts` excludes `src/db/**/*rls*.test.ts` so the hand-edited file cannot influence the vitest run regardless). This run's own dynamic evidence is scoped to the four real-Postgres RLS suites plus the disposable cascade-reproduction transactions.
- SEC-11's remediation was validated in a disposable transaction only; no migration file was created or modified by this read-only stage.

## 10. Cleanup

Six disposable SQL scripts (`BEGIN; ...; ROLLBACK;`) were run against the `ch01_ephemeral_rls_test` database (created by `test:rls:ephemeral:ci`'s own `before()` hook) via `docker exec sayre-postgres psql`. Every script ended in `ROLLBACK`; verified afterward via `SELECT count(*) FROM organizations WHERE slug LIKE 'sec-audit-org-%'` = 0 and a matching `mcp_client_keys` count = 0. The six scratch `.sql` files were created under this session's scratchpad directory and copied to `/tmp/ch04-cascade-verify*.sql` inside the `sayre-postgres` container; each was `rm -f`'d by exact filename (no glob deletion) after use. No production file, migration, or table definition was created, modified, or left behind.

## 11. Recheck scope for the next pass

- SEC-11 (`FND-a3a47aa34c47`): re-run after a migration adds `DEFERRABLE INITIALLY DEFERRED` (or an equivalent fix) to `mcp_client_keys_org_conversation_fk`; confirm the owner-and-issuer-are-the-same-user delete reproduction (section 5) now completes cleanly with the ceiling row also removed.
- LLM-09 (`FND-477e4cbf5856`): re-run after a `CHAT_MAX_DECISIONS`-style ceiling is added to `decide_node`.
- Everything else: no action required; re-verify on the next `PR_DELTA`/`MILESTONE` pass in the normal course.

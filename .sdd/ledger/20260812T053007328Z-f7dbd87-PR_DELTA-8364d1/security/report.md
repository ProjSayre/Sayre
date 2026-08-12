# Security Audit Report — CH-04 (Worker agent loop: MCP-client chat consumer) — PR_DELTA re-gate (ripple rebase)

**Run ID:** `20260812T053007328Z-f7dbd87-PR_DELTA-8364d1`
**Mode:** PR_DELTA
**Verdict:** **PASS**

## 1. Target and environment

- Repository: `projsayre/sayre`, working path `C:/Users/splat/OneDrive/Desktop/Sayre/.claude/worktrees/agent-a5212a58710c1e0d7`.
- Commit: `f7dbd87e88a404342e1091fa8e9e3f1f8dadf647` (branch `ticket/ch-04-worker-agent-loop`), dirty: **false** — confirmed via `git status --porcelain=v1 -uall` (empty) and `git rev-parse HEAD` before any work began.
- Delta under audit: a rebase replay onto the new CH-03 head `4e14d8c4a137a61ec111ede9079a8013f4ca0226` (old base `25f60fa081a28960c1213863ac93517f5ddfdde6`, old branch head `0e3caab96849e916f10522ead6e0e6b887ddefbe`), plus a migration renumber `0021_ch04_mcp_key_conversation_fk.sql` -> `0022_...` (byte-identical rename), journal entry `idx 22 / when 1785384600000`, values-only renumber edits in red-authored tests, and ledger index regeneration.
- Gate precondition: `.pipeline/review.json` verdict `PASS`, stamp confirmed fresh (`node scripts/check-stamp-freshness.mjs review.json` -> `status: fresh`, exit 0) at the start of this run.
- Environment: local worktree. **This session class has live-Postgres/Redis/Core-MCP-gateway/ModelProvider execution paths permission-blocked** (per the task brief's explicit, repeatedly-proven representation; not independently re-attempted this run — no attempt was made to route around it, consistent with the hard rule against doing so). Non-DB dynamic execution WAS available and used this run:
  - `npx tsc --noEmit` — clean, no output.
  - `npx vitest run src/security/ch04ChatCredentialFkMigration.test.ts` — **5/5 pass**, fresh.
  - `npx vitest run src/services/chatService.test.ts` — **55/55 pass**, fresh.
  - `node scripts/check-red-integrity.mjs` — reproduces exactly the declared 2 notes + 3 flagged Python files, run fresh.
  - Independent SHA-256 computation (raw + LF-normalized) of the 3 flagged Python files against `red.json`'s recorded hashes — computed fresh this run (not taken from `test-results.md`/`review.md`'s word), see §3.5.

## 2. Baseline and comparability

**Baseline:** `20260811T093143000Z-934a5ae-REMEDIATION_RECHECK-36b26b` (this ticket's own prior terminal-PASS security run).

**Marked `comparable: false`, deliberately** — the same posture this exact ticket's own lineage already established for an analogous reason, applied here in the *opposite* direction:

1. **Commit ancestry.** `git merge-base --is-ancestor 934a5ae00c4eec0e477bcdf2f33b171f79f81b71 f7dbd87e88a404342e1091fa8e9e3f1f8dadf647` fails — not an ancestor. The branch was rebased onto a new CH-03 base between that run and this one.
2. **Environment (reversed from 934a5ae's own case).** 934a5ae *gained* live-Postgres access its own baseline never had. **This run loses the live-Postgres access 934a5ae had** — this session class has no live-DB/credential execution path. The two `DYNAMIC`-evidence observations this affects (SEC-11, SC-13) are carried forward as **explicit, labeled citations** of 934a5ae's live evidence rather than represented as fresh dynamic evidence (see §5). Per this task's explicit environmental-constraint instruction, this citation is permitted narrowly because the migration content is *provably* byte-identical (§3.1) — had it not been, these two observations would instead have been marked `UNVERIFIED`, never `PASS`/`FAIL` on citation alone.

Per `audit-contract.md` §2, a materially incompatible baseline sets `comparable: false`, and every observation's mechanical `result_transition`/`coverage_transition` is `NOT_COMPARABLE` with `previous_result: null` — a disclosed validator/schema consequence, not a claim that nothing is known about the trend. The real trajectory is narrated below and in `results.json`'s per-observation `evidence` arrays, each explicitly labeled either **fresh this run** or **CITED from baseline `<run-id>`**.

## 3. Independent re-derivation (fresh this run, not taken on faith from `review.md`/`changes.json`)

Per `audit-contract.md` Phase A/B and this stage's "Surface selection and attacks" instruction, `git diff` and the actual code inventory were inspected before reading claimed security tests or the prior reports (`review.md`, `test-results.md`, and the two prior discarded attempts' artifacts under the main checkout's `.pipeline/ch04-regate/` and `.pipeline/ch04-regate2/`, both skimmed for hypotheses only and treated as unverified evidence per the audit contract, then re-derived independently).

### 3.1 Migration byte-identity (git content-addressing, not a byte-diff)

```
git rev-parse 0e3caab96849e916f10522ead6e0e6b887ddefbe:services/core/drizzle/0021_ch04_mcp_key_conversation_fk.sql
  -> bb25e2a3f50817597d6f9fb6b13d15a544badf24
git rev-parse f7dbd87:services/core/drizzle/0022_ch04_mcp_key_conversation_fk.sql
  -> bb25e2a3f50817597d6f9fb6b13d15a544badf24
```

Identical git blob SHA on both sides — content-addressed, immune to any path-handling mistake, stronger than a byte-diff. This is the load-bearing fact that justifies §5's citation for SEC-11/SC-13.

### 3.2 A methodology correction I made on myself: hop-isolation vs. direct head-to-head diff

My first pass diffed `services/core/src/db/schema.ts` directly between the old branch head (`0e3caab`) and the new head (`f7dbd87`) and got a **~90-line diff** spanning `permissions`, `ticketCache`, `styleRules`, `onboardingSteps`, `repositoryRefs`, `codeChunks`, and `codeEmbeddings` — none of which CH-04 touches. This is **W0-05's tenant-consistent-repository-FK work**, which landed in `main` (and therefore in the new CH-03 base, `4e14d8c`) between the old base (`25f60fa`) and the new base — a direct head-to-head diff conflates "what CH-04's own commits changed" with "what changed in the shared history CH-04's commits were replayed on top of."

Re-derived correctly using **hop isolation**: `git diff 25f60fa..0e3caab -- schema.ts` (what CH-04's own commit set changes at the *old* base) vs. `git diff 4e14d8c..HEAD -- schema.ts` (what the *replayed* commit set changes at the *new* base). Both are exactly 19 lines, and the *only* difference between them is the migration filename referenced in a comment (`0021_ch04`->`0022_ch04`, `0019`->`0020`) — the actual FK/cascade/trigger description text is character-for-character identical. Applied the same hop-isolation technique to every other cited file this run (§3.3), not just `schema.ts`.

### 3.3 Hop-isolated diff sizes (old hop `25f60fa..0e3caab` vs. new hop `4e14d8c..HEAD`), fresh this run

| File | Old hop | New hop | Match |
| --- | --- | --- | --- |
| `services/core/src/db/schema.ts` | 19 lines (comment only) | 19 lines (comment only) | Yes |
| `services/core/src/db/ephemeralMcpCredentials.rls.test.ts` | 151 lines | 151 lines | Yes |
| `services/core/src/services/chatService.ts` | 99 lines | 99 lines | Yes |
| `services/core/src/services/chatService.test.ts` | 306 lines | 306 lines | Yes |
| `services/core/src/security/ch04ChatCredentialFkMigration.test.ts` | 149 lines | 149 lines | Yes |
| `services/core/src/db/rls_acceptance.tester.test.ts` | 0 lines | 0 lines | Yes (no CH-04 hunk either hop) |
| `services/core/drizzle/meta/_journal.json` | 18 lines | 18 lines | Yes |

Direct old-head-vs-new-head diffs (valid for files *not* touched by unrelated intervening history — confirmed by the matching hop sizes above) additionally confirm: `chatService.ts` 0 lines, `chatService.test.ts` 0 lines (this file's CH-04 content predates the rebase entirely), `ephemeralMcpCredentials.rls.test.ts` exactly 3 value-only edits (a doc-comment 0019->0020, a CH-04 filename comment 0021->0022, and one test-title string 0019->0020 — no assertion, no fixture-construction line touched), `ch04ChatCredentialFkMigration.test.ts` renumbers every filename/idx/when/describe-title/find-discriminator reference (0021->0022, 0019->0020) with every `toEqual`/structural assertion byte-identical.

### 3.4 Stale-reference sweep

`grep -rl "0021_ch04"` and `grep -rl "0019_ch01"` across `services/`, `.sdd/`, `scripts/`, `docs/`, excluding `.sdd/ledger/` and `security-history/` (both explicitly exempt as historical record) — **zero matches**, fresh this run.

### 3.5 Red-test integrity, independently reproduced

`node scripts/check-red-integrity.mjs` run fresh: exit 1, 2 declared notes (`chatService.test.ts`, `ch04ChatCredentialFkMigration.test.ts`) + 3 flagged Python files. Independently computed (own Node script, not trusting `test-results.md`'s numbers) both the raw SHA-256 and a CRLF-to-LF-normalized SHA-256 for all three flagged files:

| File | Raw SHA-256 (on disk) | LF-normalized SHA-256 | `red.json` recorded | Match? |
| --- | --- | --- | --- | --- |
| `test_chat_events.py` | `41d562fc...` | `eea1f451...` | `eea1f451...` | Yes |
| `test_chat_mcp_client.py` | `d9c766e3...` | `802d23d0...` | `802d23d0...` | Yes |
| `test_chat_boundaries.py` | `80f9ee38...` | `9ee39684...` | `9ee39684...` | Yes |

All three files independently confirmed to contain CR (`0x0D`) bytes. `check-red-integrity.mjs` hashes raw bytes with no CRLF normalization, so it necessarily flags this on any Windows checkout regardless of actual content — this is a genuine CRLF-materialization artifact of the Windows worktree checkout, not an undeclared content change. Confirmed fresh, not cited.

## 4. Answers to the re-gate's actual questions

**(1) Is the migration rename byte-identical?** Yes — §3.1, git blob-content-addressed, fresh.

**(2) Did the renumber touch anything beyond declared values?** No, for every red-authored/security-relevant file checked — §3.2-3.3, fresh, hop-isolated (correcting for one methodology trap I caught myself in).

**(3) Are there stale `0021_ch04`/`0019_ch01` references anywhere live?** No — §3.4, fresh.

**(4) Do the two "CRLF false positive" claims from `check-red-integrity.mjs` actually hold?** Yes, for all 3 files — §3.5, independently recomputed, fresh.

**(5) Core CH-04 tenant/RBAC/secret posture — still holds?** Yes. `org_id` is still never client-supplied (both languages); the ephemeral credential is still never logged/persisted; the credential's ceiling is still bound to the issuing user's live scope; the Redis envelope still carries a trustworthy `org_id`; no vendor LLM SDK bypasses `ModelProvider`. None of the files this delta touches are on the code path for any of these properties — confirmed by the hop-isolated diff list in §3.3 (none of `chatService.ts`, `agent.py`, `mcp_client.py`, `store.py`, `events.py`, `models.py` appear in this delta at all).

## 5. SEC-11 and SC-13 — citation methodology (the only two observations not fresh this run)

Both are `evidence_type: DYNAMIC`, both required live Postgres to originally produce, and both are unaffected by this delta (the migration's content is byte-identical per §3.1). Per this task's explicit environmental-constraint instruction, both are carried forward in `results.json` as **explicitly labeled citations** of baseline run `934a5ae`'s live evidence, each evidence array bearing a citation bullet naming the baseline run ID, the baseline commit, and the specific byte-identity proof that justifies the citation. Neither observation's **result** was changed by citing it (`SEC-11` stays `FAIL`/MEDIUM/non-blocking/`OPEN`; `SC-13` stays `PASS`) — only the evidence provenance is labeled honestly. Had the migration content differed in any way, this citation would not have been permitted and both would instead be marked `UNVERIFIED` this run per normal `audit-contract.md` practice — a genuine coverage `LOST`, not papered over.

- **SEC-11** (`FND-a3a47aa34c47`, MEDIUM, `OPEN`, non-blocking): migration 0021/0022's `mcp_client_keys_org_conversation_fk` cascade races `mcp_client_keys_created_by_users_id_fk ... ON DELETE SET NULL` when a user is both a conversation's owner and the credential's `created_by` (the only shape CH-03's owner-only chat model produces) — the whole `DELETE FROM users` statement fails to complete. Fails closed (whole-transaction abort, zero cross-tenant consequence in every baseline reproduction); not reachable via any shipped `services/core` code path today (no route/service/job deletes a `users` row). Must be fixed before any user-deletion/GDPR-erasure feature ships. A validated one-line remediation (`DEFERRABLE INITIALLY DEFERRED`) is on record from baseline. Unaffected by this rebase — the migration's actual DDL is unchanged, only its filename and journal entry moved.
- **SC-13** (`PASS`): migration applies cleanly via the real drizzle migrator against a live database; its `delete_ephemeral_ceiling` trigger was confirmed firing (not merely present) and `SECURITY INVOKER` on the *deployed* object. Unaffected by this rebase for the same reason.

## 6. Findings summary

| Finding | Check | Severity | Status | Changed this run? |
| --- | --- | --- | --- | --- |
| `FND-a3a47aa34c47` | SEC-11 | MEDIUM | OPEN | No — persisting, unaffected by this delta (cited, not re-derived; content proven unchanged) |
| `FND-477e4cbf5856` | LLM-09 | MEDIUM | OPEN | No — persisting, unaffected by this delta (`agent.py`/`models.py` are not in the hop-isolated change set at all) |

No CRITICAL or HIGH finding. No tenant-isolation or RBAC-boundary failure. Both open findings are non-blocking per this stage's gate policy (MEDIUM, no tenant/RBAC dimension, both fail closed).

## 7. Verified clean (fresh this run unless labeled cited)

- Migration rename is byte-identical (git blob SHA match, fresh, §3.1).
- No stale `0021_ch04`/`0019_ch01` references anywhere live (fresh, §3.4).
- Every red-authored/security-relevant file's rebase-scoped delta is values-only; no assertion body, structural check, or test nesting changed anywhere (fresh, hop-isolated, §3.2-3.3).
- `rls_acceptance.tester.test.ts` carries no CH-04 hunk against the new base (fresh, 0-line diff both hops).
- `chatService.ts` (the real minting/republish implementation) is untouched by the rebase (fresh, 0-line direct diff, corroborated by matching hop sizes).
- The 3 `check-red-integrity.mjs` Python-file flags are genuine CRLF-checkout artifacts, not undeclared content changes (fresh, independently recomputed raw + LF-normalized SHA-256, §3.5).
- `npx tsc --noEmit` clean; `ch04ChatCredentialFkMigration.test.ts` 5/5; `chatService.test.ts` 55/55 (all fresh, this run).
- CORE-01/02/03/04/05/06 tenant-isolation, RBAC-boundary, secret-handling, webhook-trust, ingestion-ephemerality, and injection-boundary postures are unaffected by this delta — none of the files this delta touches (migration filename, journal entry, two comment/value-only test renumbers) are on any of those code paths (fresh cross-check against §3.3's hop-isolated file list).
- SEC-11/SC-13's underlying DDL is provably unchanged, justifying the citation in §5 (fresh byte-identity proof; cited live-evidence content itself).

## 8. Limitations

- This run had no live-Postgres/Redis/Core-MCP-gateway/ModelProvider access (session-class constraint, taken as given per the task brief rather than independently re-tested this run). SEC-11 and SC-13 are carried forward as explicit citations, not fresh dynamic evidence — see §5.
- The remaining ~107 observations (everything except the new `ripple-rebase-integrity` observation and SEC-11/SC-13) were not re-executed from a cold attack model this run; their code_references were independently hop-isolated-diffed (confirming byte-identical or values-only-renumbered content per §3.3) and their baseline results/evidence are carried forward by explicit citation of run `934a5ae`, each bearing a citation bullet in `results.json`. This is consistent with a `PR_DELTA` re-gate whose declared change surface is a mechanical migration/journal renumber, a red-test value-only follow-through, and ledger regeneration — not a re-implementation — but it is a real scope limit, not a full from-scratch re-audit.
- `.sdd/ledger/index.json` regeneration was spot-checked only via diffstat (`+239/-0`, additive only) and not independently re-derived entry-by-entry — non-production pipeline metadata, judged low security relevance and outside the registered checklist scope.
- MCPT-08/MP-09 (MCP response-size bounding) and MP-02/MP-08 (redirect-following default, production TLS posture) remain `UNVERIFIED`, unchanged from baseline — outside this delta's scope, not independently re-derived this run.
- Two prior attempts at this exact re-gate were discarded before this run (disclosed by the task brief): one where the review artifacts were self-authored after a guard-path bug in a differently-rooted session, and one flagged for fabricating freshness by script-transforming a baseline `results.json` and validating tooling against a scratch fixture rather than real output. Their claims were treated as unverified evidence per the audit contract; every fact this report relies on was independently re-derived this run (§3) except where explicitly labeled a citation (§5), never assumed from either prior attempt.

## 9. Cleanup

No repository file outside this run's own artifacts (`.pipeline/security-history/20260812T053007328Z-f7dbd87-PR_DELTA-8364d1/`) was created, modified, or left behind. No throwaway git repo, database, or `.pipeline/` fixture was constructed this run — all verification was direct `git diff`/`git rev-parse`/`grep`/`npx tsc`/`npx vitest`/`node scripts/*.mjs` against the real worktree and its real history, plus generator scripts under this session's own scratchpad directory (`gen-results.mjs`, `gen-manifest.mjs`, `gen-report.mjs`), which write only into `.pipeline/security-history/<run-id>/` in the worktree and touch nothing else.

## 10. Recheck scope for the next pass

- SEC-11 (`FND-a3a47aa34c47`): re-run after a migration adds `DEFERRABLE INITIALLY DEFERRED` (or an equivalent fix) to `mcp_client_keys_org_conversation_fk`; requires live-Postgres authorization to close.
- LLM-09 (`FND-477e4cbf5856`): re-run after a `CHAT_MAX_DECISIONS`-style ceiling is added to `decide_node`.
- The next run with live-Postgres authorization should convert SEC-11/SC-13's citations back into fresh dynamic evidence rather than continuing to cite `934a5ae` indefinitely.
- Everything else: no action required; re-verify on the next `PR_DELTA`/`MILESTONE` pass in the normal course.

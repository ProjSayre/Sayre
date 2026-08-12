# Security Audit Report — W1-05 gap-fill (GAP-3/4/5/8/9/10/11/12)

## Verdict: PASS

---

## Supersession notice

A prior run under this pipeline directory, `20260810T144750000Z-b63e14edd6-PR_DELTA-59e9ce`,
completed `PASS` on 2026-08-10 but was stamped to `headSha b63e14edd6d82f8bb1b853768b98e95e4f2759a7`
on branch `feat/pipeline-gapfill-cost-controls` — a sibling branch whose own tip commit
(`b63e14e`, "cut gapfill pipeline cost with scout-only triage and ticket slices") is unrelated to
W1-05, and which is **not** an ancestor of this run's target commit (`git merge-base
--is-ancestor b63e14edd6d82f8bb1b853768b98e95e4f2759a7 87b07582bca1f6db668fd80f3435c00f6eb82e50`
exits `1`). That run's dirty working tree happened to contain the same uncommitted W1-05 diff at
the time it ran — confirmed this session: `git diff b63e14edd6d82f8bb1b853768b98e95e4f2759a7
87b07582bca1f6db668fd80f3435c00f6eb82e50 -- <the three touched production files>` is empty — but a
shared working-tree diff on an unrelated, non-ancestor commit does not satisfy the audit
contract's ancestor requirement for a comparable baseline, and per this run's own task framing it
is explicitly excluded from being treated as this run's history or baseline.

This run (`20260811T024655000Z-87b07582bc-PR_DELTA-f60fc7`) is confirmed against
`87b07582bca1f6db668fd80f3435c00f6eb82e50` on branch `feat/w1-05-ingestion-delta-worker-core` —
the correct tree, matching PR #89's head, and matching `.pipeline/review.json`'s fresh-stamped
`PASS`. Every observation below was independently re-derived this session (own `git diff`, own
`git rev-parse HEAD`, own vitest/pytest runs, own direct reads of every touched file) — not copied
from the excluded prior run, even though this run's own conclusions are, unsurprisingly, consistent
with it given the identical code content.

## 1. Target commit and environment

- **Commit:** `87b07582bca1f6db668fd80f3435c00f6eb82e50`
- **Branch:** `feat/w1-05-ingestion-delta-worker-core`
- **Dirty:** yes — working tree carries exactly the W1-05 gap-fill file set (8 modified + 9
  untracked, matching `changes.md`/`review.md`'s file list), plus one confirmed-unrelated
  pre-existing untracked `Documents/` directory.
- **Environment:** local-dev checkout, no live CI run. Neo4j/Postgres/pgvector unreachable —
  independently re-confirmed this session (`poetry run pytest` on the seven touched/new Python
  test files: **68 passed, 11 skipped**, 0 errors, 0 hangs; skips are the 5 Neo4j-gated + 6
  Postgres-gated tests in `test_ingestion_graph_integration.py`/`test_chunk_store_integration.py`).
- **Core suite:** `npx vitest run` on the three touched Core test files: **72/72 passed**.

## 2. Baseline run and comparability

**No comparable baseline.** Checked every run under `.pipeline/security-history/` with `git
merge-base --is-ancestor <run-commit> 87b07582bca1f6db668fd80f3435c00f6eb82e50`:

- The only run whose `results.json` textually overlaps this diff's symbols
  (`normalizeGithubEvent`/`repo.branch`/`classify_ingestion_envelope`/`RefDeletionCommand`) is the
  excluded wrong-branch run described above — its target commit fails the ancestor check and it is
  explicitly not treated as history for this run.
- The next-most-recent topically-adjacent run, `20260810T040646000Z-ee496aa498-PR_DELTA-81b52d`
  (commit `ee496aa4985fc4145afbadf34c54de9cf3e9910a`), **is** an ancestor of this run's HEAD, but its
  selected surfaces were the W0-04 BullMQ lane/priority mechanism and cross-runtime harness config
  loading — grepped its `results.json`/`report.md` for every symbol this diff touches: zero
  matches. No comparable observation exists in it for any check this run selects.
- No default-branch `MILESTONE`/`FULL` run exists in history.

Per audit-contract.md's baseline order, option 4 applies: **no baseline; every observation below
is `FIRST_OBSERVATION`.** No progress trend is invented.

## 3. Counts

- **Results:** PASS 14, NOT_APPLICABLE 21, FAIL 1 (36 total observations)
- **Result transitions:** FIRST_OBSERVATION 36
- **Coverage transitions:** NOT_COMPARABLE 36
- **Finding statuses:** OPEN 1
- **Surface readiness:** IMPLEMENTED 13, PARTIAL 1
- **Readiness transitions:** FIRST_OBSERVATION 14

## 4. Security trajectory

- **New:** none (no comparable baseline exists to regress against or resolve from).
- **Regressed:** none.
- **Persisting:** the SEC-11 finding below is the *same underlying condition* as the one the
  excluded wrong-branch run recorded (deterministically: the observation key is a stable function
  of repository/check/surface/target/attack-path and does not encode commit or branch, so it
  hashes to the same `finding_id`, `FND-92e3d99bf0f2`), but because that prior run is not a valid
  baseline for this run, it is recorded here as `FIRST_OBSERVATION`/`first_seen_run_id` = this
  run's own id, not carried forward as a continuation. This is disclosed explicitly rather than
  silently inherited.
- **Resolved:** none.
- **Risk-accepted:** none — see Finding below for why SEC-11 is `OPEN`, not `RISK_ACCEPTED`.

## 5. Coverage trajectory

Gained/lost/unchanged are not meaningful with no comparable baseline; every observation's coverage
transition is `NOT_COMPARABLE` per the contract's rule when no baseline observation exists.

## 6. Findings

### FND-92e3d99bf0f2 — SEC-11 — Ref-deletion leaves graph/chunk/embedding data behind (MEDIUM, OPEN, non-blocking)

**Attempt:** Traced what happens to a deleted branch's graph, chunk, and embedding data after
`RefDeletionCommand`'s terminal ack, independently re-verifying `changes.md`'s "no destructive
teardown" claim rather than trusting it.

**Evidence:**
- `services/workers/sayre_workers/ingestion/service.py` — the `RefDeletionCommand` branch logs and
  returns `IngestionResult(status="ref_deleted", ...)`; no call to any graph/chunk/ref-state delete
  surface appears anywhere in the branch.
- `git diff --quiet HEAD -- .../graph.py .../chunks.py .../repository.py .../projection.py` — zero
  diff across all four, independently re-confirmed this session.
- Grep for a per-ref `DETACH DELETE`/`delete_ref`/`DELETE FROM` pattern across the diff: zero
  matches (the *existing* full-rebuild `DETACH DELETE` in `graph.py` is unrelated — it runs on
  every full-rebuild apply, not specifically on ref deletion, and is unchanged by this diff).

**Impact:** A deleted branch's Folder/File/Function/Class/Test projection, its
`code_chunks`/`code_embeddings` rows, and its `repository_refs` state remain in Postgres/Neo4j
indefinitely — a bounded, same-tenant storage leak and stale-data condition. **Not a
tenant-isolation or cross-tenant issue**, and **not a regression**: before this fix, a
branch-deletion push failed permanently and never reached any teardown code either, so the
observable data-retention outcome is unchanged, not worsened, by this diff. This is exactly what
`spec.md`'s Open Question Q-1 discloses and explicitly defers, with a stated rationale (destructive
multi-store capability, needs its own `red`-stage adversarial coverage, out of this gap-fill's
scope).

**Why `OPEN`, not `RISK_ACCEPTED`:** `review.md`'s Judgment call 1 states "Q-1's human sign-off was
already obtained earlier in this pipeline run." This stage searched `.pipeline/` for a formal
risk-acceptance record with the four fields `audit-contract.md` §7 requires (named approver,
reason, ticket, expiry) and found only narrative references (spec.md's Open Questions, gaps.md's
flag, review.md's own restatement) — no artifact with those four fields. Per the contract, risk
acceptance "never changes a FAIL to PASS" and requires those named fields; fabricating them was not
done. Recorded `OPEN` with a remediation reference instead.

**Why non-blocking:** MEDIUM severity, same-tenant only, not a tenant-isolation/RBAC-boundary
failure, and not a regression — the gate policy only makes tenant-isolation/RBAC failures and
CRITICAL/HIGH failures-or-regressions blocking.

**Remediation/recheck scope:** A dedicated follow-up ticket ("ref-deletion teardown for W1-05")
implementing `GraphStore.delete_ref`, `ChunkStore.delete_ref`, and `LockedRef.delete`, with its own
`red`-stage adversarial coverage — per spec.md's own recommendation, not an amendment to this
gap-fill. On recheck, re-run SEC-11 against the new teardown path plus its sibling isolation checks
(cross-org teardown scoping, idempotent re-delete, and whether a `graph.updated` with an all-zero
revision is an acceptable downstream contract for the gateway fanout — spec.md's Q-1 already flags
this exact downstream-contract question).

## 7. Verified clean (selected highlights; full row-per-check detail in `results.json`)

- **CORE-01 / tenant isolation:** `RefDeletionCommand.org_id` is `envelope.org_id` only; a
  forged `payload.org_id` is ignored, confirmed by direct code read and by re-running
  `test_ref_deletion_command_org_id_ignores_forged_payload_org_id` (PASSED).
- **CORE-04 / ING-01 / webhook signature-before-processing:** `verifyGithubSignature` runs before
  `JSON.parse`, `normalizeGithubEvent` (this diff's only Core production change), org resolution,
  and publish — confirmed by direct read of `githubWebhookService.ts`'s ordering and by re-running
  the fixture-replay suite (26/26 PASSED).
- **CORE-05 / ingestion ephemerality:** both new terminal-ack branches `return` strictly before the
  `state_store.lock`/`repository_source.checkout` block; `repository.py` (scratch-clone owner) has
  zero diff; the `checkout`-absent-from-log assertions re-ran PASSED.
- **CORE-03 / ING-14 / secrets:** no hardcoded credential in any changed/new file; both new
  `logger.info()` call sites log only `message_type`/`reason`/`ref_name`, never the repository
  locator (which can carry `credential_ref`) or org_id; committed envelope fixtures contain only
  synthetic placeholder data.
- **ING-06 / DLQ and head-of-line block:** traced `messaging/sqs_client.py`'s consumer loop
  directly — a raised exception leaves the message undeleted (redelivers toward DLQ); a normal
  return triggers `delivery_store.complete` then `delete_message`. `test_fifo_group_recovers_after_
  terminal_ack` (EC-7) and `test_classify_unknown_type_still_raises` (EC-2, parametrized over
  `repo.tag`/`repo.pull_request`/`graph.updated`) both re-ran PASSED — the fix closes the two
  targeted head-of-line-block vectors without opening a new silent-drop path for anything outside
  the enumerated allowlist.

## 8. Downgrade / desync attack-surface finding (per task's specific ask)

**Question:** Could a real push with actual content changes get misclassified as a
terminal-ignore/ref-deletion and silently dropped?

**Finding: not exploitable within the stated threat model — independently re-verified, not taken
on faith.**

`classify_ingestion_envelope`'s rule 2 treats a `repo.push` as a ref deletion when **either**
`payload.payload.deleted is True` **or** `payload.payload.after` matches the all-zero-SHA pattern.
Both fields live inside the webhook payload body that GitHub signs as a whole with
`X-Hub-Signature-256` (HMAC-SHA256 over the raw body, verified at `githubWebhookService.ts`'s step
(b), strictly before `JSON.parse`, `normalizeGithubEvent`, and any publish — confirmed by direct
code read this session, not assumed). Forging an inconsistent payload (e.g. `deleted: true` with
real, non-empty `commits` and a meaningful `after`) requires either:

1. **Holding the shared HMAC secret** — at which point the attacker can forge *any* event Core will
   accept, not just this one; this is a pre-existing, general webhook-trust boundary unrelated to
   and unimproved-or-worsened by this diff, or
2. **GitHub itself sending an inconsistent payload** — GitHub's own webhook contract guarantees
   `deleted: true` implies zero `after` and empty `commits` for a genuine delivery (documented
   platform behavior, not something this diff can violate or that a client can spoof without (1)).

Confirmed the code does not weaken this: `test_classify_deleted_true_with_nonzero_after_is_
authoritative` (EC-4) deliberately exercises `deleted: true` with a *real* non-zero `after` — the
code still classifies it as a ref deletion, exactly matching GitHub's actual contract (a real
deletion push's `after` is always zero; a test asserting `deleted` is authoritative even against a
hypothetically-inconsistent `after` is defense-in-depth for a case GitHub's contract says cannot
occur, not evidence the guard can be bypassed by an attacker without the shared secret).

One adjacent, pre-existing, diff-unrelated observation: GitHub's `X-Hub-Signature-256` covers the
raw request body but not the `X-GitHub-Event` header (which determines whether Core treats a
delivery as `push` vs `create`/`delete`, i.e. whether the worker ultimately sees `repo.push` vs
`repo.branch`). Exploiting that gap requires an active network position between GitHub and Core
(message-integrity/MITM territory), which is outside this diff's threat model and was already true
before this ticket — recorded as a limitation for completeness, not a diff-attributable finding.

**Conclusion: the prior pass's reasoning holds.** The downgrade/desync surface is not exploitable
by a webhook-signing-secret-less attacker under the current threat model.

## 9. Limitations

- Neo4j/Postgres/pgvector unreachable in this environment — the two GAP-3/GAP-4 real-infra suites
  are coverage-only for this diff (per `changes.md`) and independently confirmed to skip cleanly
  (11 skipped, 0 errors) rather than error or hang. Pre-existing environment constraint, not
  introduced by this stage.
- No formal risk-acceptance artifact exists for Q-1's human sign-off (see SEC-11 above) — narrative
  sign-off only, not the four-field record the contract requires. Disclosed, not fabricated.
- SEC-11's `finding_id` deterministically matches the excluded wrong-branch run's finding_id (the
  observation key does not encode commit/branch), but is tracked here as this run's own
  `FIRST_OBSERVATION` per the ancestor-eligibility exclusion above, not as a carried-forward
  continuation.
- The `X-GitHub-Event` header integrity gap noted in section 8 is pre-existing GitHub webhook
  protocol behavior, unrelated to and unchanged by this diff.
- `spec.json`/`changes.json`/`red.json` are stale per `review.md`'s own disclosed warning; this
  stage's own required inputs (`review.json`, `changes.md`'s re-derived diff) are unaffected, per
  this stage's Staleness-of-required-inputs policy (those sidecars are advisory, not control
  inputs for this gate).

## 10. Cleanup

No fixture, scratch clone, or temporary file was created by this run — every check was verified by
direct code reading and by re-running the existing, already-committed, non-destructive local
vitest/pytest suites (no new test files, no network egress, no state persisted beyond the process).
Nothing to clean up.

## 11. Artifact path and validation

`.pipeline/security-history/20260811T024655000Z-87b07582bc-PR_DELTA-f60fc7/` — `manifest.json`,
`results.json`, `report.md`. Validated with `node scripts/validate-security-audit-run.mjs
.pipeline/security-history/20260811T024655000Z-87b07582bc-PR_DELTA-f60fc7`.

## 12. Recheck scope

Full recheck required only for SEC-11 and its sibling paths (cross-org teardown scoping, idempotent
re-delete, downstream `graph.updated` contract for an all-zero revision) once a dedicated
ref-deletion-teardown ticket lands. Everything else in this report (CORE-01..06, ING-01..14,
SEC-01..10/12..14) is a clean `PASS`/`NOT_APPLICABLE` scoped to this diff and does not need a
recheck unless the underlying files change again.

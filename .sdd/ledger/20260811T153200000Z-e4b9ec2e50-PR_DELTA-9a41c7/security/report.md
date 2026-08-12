# Security Audit Report — W1-02 gap-fill (GAP-4/5/6/7/8/9)

## Verdict: PASS

Run ID: `20260811T153200000Z-e4b9ec2e50-PR_DELTA-9a41c7`
Mode: `PR_DELTA`
Target commit: `e4b9ec2e501fe17184e21e16599f528065bb0b7b` (branch `feat/w1-05-ingestion-delta-worker-core`, dirty)
Baseline: **none** (see `manifest.json`'s `baseline.selection_reason`). The one ancestor-eligible
prior run touching an overlapping file set, `20260811T024655000Z-87b07582bc-PR_DELTA-f60fc7`
(W1-05 gapfill), was evaluated and rejected as a comparable baseline: every one of its
ING/CORE-04 observations targets a wholly different attack surface (Python-side
`classify_ingestion_envelope`/`RefDeletionCommand`/terminal-ack dispatch) from this run's
Core-side checks (idempotency-key derivation, installation-id guard, full-name validation,
body-cap enforcement, errorHandler branches) — zero `observation_key` overlap despite the
shared file-level footprint. Per audit-contract.md's baseline order, option 4 applies: no
baseline. Every observation below is `FIRST_OBSERVATION`, not a comparison.

---

## 1. Current verdict, target, mode, milestone, baseline

This run gap-audits the six repairs to the already-shipped W1-02 GitHub webhook receiver
(GAP-4: dedup identity bound to signed bytes, not the unsigned `X-GitHub-Delivery` header;
GAP-5: `push` constrained to `refs/heads/*`; GAP-6: `installation.id` requires a positive
safe integer, `InstallationResolutionInputError` mapped to 400; GAP-7:
`repository.full_name` validated to a real `owner/name` shape; GAP-8: BullMQ envelope
assertion, test-only; GAP-9: 5 MB body cap kept, named, and made observable).
`.pipeline/review.json`'s verdict is `PASS` and its stamp is fresh
(`node scripts/check-stamp-freshness.mjs review.json` → exit `0`), so a full check ran per
`.sdd/stages/security.md`.

## 2. Security trajectory

**New:** one open finding this run surfaces for the first time, `FND-fa14278279d8` (ING-06,
bounded SQS FIFO 5-minute dedup window / BullMQ `removeOnComplete: true` erasure). No
comparable baseline observation exists (see above), so it is classified `FIRST_OBSERVATION`
per the contract's strict rules rather than `NEW`/`REGRESSED` — but functionally it is a
pre-existing, disclosed characteristic, **not** something this diff introduced or made
worse. GAP-4 strictly *improves* the situation by making the dedup **identity**
untamperable (see ING-02, PASS), while leaving the enforcement **window** unchanged. It is
explicitly disclosed in `spec.md`'s Open Questions #1, citing
`docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md`'s own MEDIUM rating, and
deliberately excluded from this gapfill's scope (needs a migration + a queue-wide
`removeOnComplete` behavior change). No formal risk-acceptance record (named
approver/reason/ticket/expiry) exists for it, so it is recorded `OPEN`, not
`RISK_ACCEPTED`. **MEDIUM severity — does not block this run's verdict** per the gate
policy (only CRITICAL/HIGH failures/regressions and tenant-isolation/RBAC failures block).
**Regressed:** none. **Persisting:** none comparable (no baseline). **Resolved:** none
comparable (no baseline). **Risk-accepted:** none.

## 3. Coverage trajectory

All 32 selected checks are evidenced this run (mostly `STATIC`, `BOTH` for the ~12 where a
re-run of the pre-existing Vitest suite provided dynamic confirmation). Coverage transition
for every observation is `NOT_COMPARABLE` — mechanically correct given no baseline exists
for this run to compare evidence quality against (not a claim that evidence is weak; see
each observation's own `evidence_type`/`evidence` fields for what was actually gathered).

## 4. Surface readiness changes and documentation/code drift

No readiness regressions (none comparable — no baseline). All eight applicable
mandatory/registry surfaces (`tenant-isolation`, `rbac-boundary`, `secret-handling`,
`webhook-trust`, `ingestion-ephemerality`, `injection-boundaries`, `ingestion-queue-webhook`,
`web-api-client`) are rated `IMPLEMENTED`; `secrets-audit-data-lifecycle` is rated `PARTIAL`
(the prior W1-05 run separately identified the same ref-deletion data-retention gap, which
this diff does not touch or claim to close — see that surface's `selection_reason`). No
documentation/code drift found: `spec.md`'s "Also out" list (durable receiver-side delivery
log, `installation` lifecycle idempotency, `appClient.ts`/`github.ts` refactors) matches
exactly what the diff leaves untouched.

## 5. Blocking findings and exact remediation/recheck scope

**None.** No CRITICAL or HIGH failure, no tenant-isolation or RBAC-boundary failure, no
lost coverage on a CRITICAL/HIGH boundary, no schema-invalid or overwritten run artifact.

The one open finding (`FND-fa14278279d8`, MEDIUM, ING-06) does not block. Recheck scope
when it is eventually addressed: a persisted `(consumer_id, idempotency_key)` delivery log
on the Core/BullMQ side (mirroring `services/workers/messaging/idempotency.py`'s existing
extension on the Python fleet) plus `removeOnComplete: { age }` instead of `true` in
`services/core/src/queue/bullmq.ts:256` — re-run ING-02 and ING-06 together against that
change, since they share the same underlying dedup-identity/dedup-window control.

## 6. Findings by check — full table

| Observation (target asset shown) | Finding ID | Check | Surface / readiness | Attempt | Evidence / type | Baseline → current | Transition | Coverage | Severity / confidence | Status | Repro/cleanup | Code refs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| github-webhook-envelope-org-id-resolution | — | CORE-01 | tenant-isolation / IMPLEMENTED | Traced org_id provenance end-to-end | STATIC | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | githubWebhookService.ts:196-223 |
| webhook-diff-touches-no-graph-query-service-or-client-graphology-code | — | CORE-02 | rbac-boundary / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| github-webhook-secret-loader-and-body-cap-warning-log | — | CORE-03 | secret-handling / IMPLEMENTED | Checked secret sourcing + new log line | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran express.gapfill.test.ts | githubWebhookService.ts:76-77; http/express.ts:184 |
| signature-verification-precedes-idempotency-key-derivation-and-publish | — | CORE-04 | webhook-trust / IMPLEMENTED | Traced control-flow order; tampered-body fixture | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran fixtures suite | githubWebhookService.ts:108-114,211-222 |
| diff-does-not-touch-scratch-clone-or-repository-checkout-code | — | CORE-05 | ingestion-ephemerality / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| repo-full-name-validator-and-installation-id-guard-structural-constraints | — | CORE-06 | injection-boundaries / IMPLEMENTED | Read validator regex for ReDoS/injection sink; adversarial fixtures | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran repoFullName.test.ts | github/repoFullName.ts; normalizeGithubEvent.ts:51-61 |
| handleGithubWebhook-signature-gate-order | — | ING-01 | ingestion-queue-webhook / IMPLEMENTED | Missing/malformed/mismatched signature paths | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran affected suite | githubWebhookService.ts:108-114 |
| idempotency-key-derivation-signed-bytes-vs-unsigned-header | — | ING-02 | ingestion-queue-webhook / IMPLEMENTED | Captured-pair replay w/ fresh delivery id; collision/predictability analysis | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran githubDeliveryIdentity.test.ts + fixtures replay test | githubDeliveryIdentity.ts; githubWebhookService.ts:211-222 |
| installation-id-positive-safe-integer-guard-extractInstallationId-and-service-branch | — | ING-03 | ingestion-queue-webhook / IMPLEMENTED | Malformed-id matrix (-1,1.5,0,Infinity,NaN,string,2**53) | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran gapfill suites | normalizeGithubEvent.ts:51-61; githubWebhookService.ts:143-154 |
| envelope-org-id-and-idempotency-key-provenance-under-forged-payload-fields | — | ING-04 | ingestion-queue-webhook / IMPLEMENTED | Forged org_id/idempotency_key payload fields | STATIC | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | githubWebhookService.ts:216-223 |
| cross-queue-confusion-not-implicated-by-this-diff | — | ING-05 | ingestion-queue-webhook / IMPLEMENTED | Checked for job-shape/consumer changes | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| sqs-fifo-dedup-window-and-bullmq-removeoncomplete-erasure | **FND-fa14278279d8** | ING-06 | ingestion-queue-webhook / IMPLEMENTED | Replay after SQS 5-min window / after BullMQ `removeOnComplete` erasure | STATIC | none → **FAIL** | FIRST_OBSERVATION | NOT_COMPARABLE | **MEDIUM / HIGH** | OPEN | Static inspection + spec.md cross-reference | queue/bullmq.ts:256; spec.md Open Questions #1 |
| priority-starvation-not-implicated-by-this-diff | — | ING-07 | ingestion-queue-webhook / IMPLEMENTED | Checked lane/priority code | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| malicious-repository-paths-not-implicated-scratch-clone-untouched | — | ING-08 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| parser-repository-bombs-not-implicated | — | ING-09 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| scratch-clone-isolation-not-implicated | — | ING-10 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| transactional-graph-vector-writes-not-implicated | — | ING-11 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| unsafe-provider-responses-not-implicated-inbound-webhook-only | — | ING-12 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| sync-poisoning-and-conflict-not-implicated | — | ING-13 | ingestion-queue-webhook / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| no-installation-credential-or-access-token-material-in-new-code-paths | — | ING-14 | ingestion-queue-webhook / IMPLEMENTED | Inspected new/changed lines for credential leakage | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran express.gapfill.test.ts | http/express.ts:95-116,174-187 |
| webhooks-github-route-mount-inventory-unchanged | — | WEB-01 | web-api-client / IMPLEMENTED | Route inventory diff | STATIC | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | routes/githubWebhook.ts |
| repo-full-name-and-installation-id-parsing-no-injection-sink | — | WEB-02 | web-api-client / IMPLEMENTED | Traced validated fields to sinks | STATIC | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | normalizeGithubEvent.ts:63-80 |
| xss-not-implicated-no-html-markdown-rendering-in-diff | — | WEB-03 | web-api-client / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| csrf-not-implicated-unauthenticated-signature-only-endpoint-unchanged | — | WEB-04 | web-api-client / IMPLEMENTED | Checked auth model | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | app.ts:20-24 |
| clickjacking-not-implicated-json-api-endpoint | — | WEB-05 | web-api-client / IMPLEMENTED | Checked response type | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| mass-assignment-not-implicated-read-classify-publish-only-no-update-endpoint | — | WEB-06 | web-api-client / IMPLEMENTED | Checked for user-controlled DB writes | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| installation-id-type-coercion-and-full-name-edge-value-matrix | — | WEB-07 | web-api-client / IMPLEMENTED | Unicode/whitespace/numeric-extreme matrix | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran gapfill suites | repoFullName.ts; normalizeGithubEvent.ts |
| raw-body-size-cap-GITHUB_WEBHOOK_MAX_BODY_BYTES-enforced-pre-hmac | — | WEB-08 | web-api-client / IMPLEMENTED | Just-under/over-cap requests | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran bodyCap.gapfill.test.ts | app.ts:24-40; routes/githubWebhook.ts:12-18 |
| business-flow-abuse-not-implicated-no-new-state-changing-user-flow | — | WEB-09 | web-api-client / IMPLEMENTED | File-inventory check | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| cache-leakage-not-implicated-no-response-caching-on-webhook-receiver | — | WEB-10 | web-api-client / IMPLEMENTED | Checked caching middleware | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |
| errorHandler-InstallationResolutionInputError-and-entity-too-large-fixed-response-bodies | — | WEB-11 | web-api-client / IMPLEMENTED | Checked response bodies for message leakage | BOTH | none → PASS | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Re-ran express.gapfill.test.ts | http/express.ts:95-116,174-187 |
| redirect-url-handling-not-implicated-no-redirect-logic-in-diff | — | WEB-12 | web-api-client / IMPLEMENTED | Checked for redirect logic | STATIC | none → NOT_APPLICABLE | FIRST_OBSERVATION | NOT_COMPARABLE | NONE / HIGH | — | Static inspection | — |

## 7. Counts

- By result: PASS 17, NOT_APPLICABLE 14, FAIL 1, UNVERIFIED 0.
- By result transition: FIRST_OBSERVATION 32.
- By coverage transition: NOT_COMPARABLE 32 (no baseline — see above).
- By finding status: OPEN 1.
- By surface readiness (inventory rows, incl. non-selected): IMPLEMENTED 13, PARTIAL 1.
- By readiness transition: FIRST_OBSERVATION 14.

## 8. New / regressed / persisting / resolved / risk-accepted findings, separated

- **New:** `FND-fa14278279d8` (ING-06, MEDIUM, OPEN) formally classified `FIRST_OBSERVATION`
  (no baseline), but functionally a pre-existing, disclosed characteristic — not introduced
  or worsened by this diff.
- **Regressed:** none.
- **Persisting:** not comparable (no baseline).
- **Resolved:** not comparable (no baseline) — though GAP-4's fix does substantively resolve
  the identity-forgeability half of the replay concern in practice (see ING-02, PASS).
- **Risk-accepted:** none (no formal risk-acceptance record exists for `FND-fa14278279d8`).

## 9. Single points of failure

None identified. Signature verification (CORE-04/ING-01), tenant isolation (CORE-01), and
the new idempotency-key derivation (ING-02) are each backed by more than one independent
control (e.g., ING-02's PASS relies on both the signature gate running first *and*
SHA-256's collision resistance — not one control alone).

## 10. Coverage gaps and what is required to close each

- `ING-06`'s FAIL is evidenced `STATIC` only — no live SQS/BullMQ broker was exercised in
  this session to observe an actual post-window replay succeed end-to-end. Closing this gap
  requires either (a) a dynamic run against a disposable local broker demonstrating the
  duplicate-processing outcome, authorized and bounded per the audit contract, or (b) simply
  shipping the persisted-delivery-log remediation, after which ING-06 should be re-run and
  is expected to flip to PASS.
- No other coverage gaps: every other selected check reached an evidenced PASS or
  NOT_APPLICABLE with inventory/code evidence.

## 11. Cleanup performed and artifacts retained

No fixture, temp directory, or external side effect was created by this stage — all
verification was read-only static inspection plus re-running the pre-existing, already-
committed Vitest suite (`services/core/`), which creates no persistent state beyond an
ephemeral local HTTP server in `githubWebhook.bodyCap.gapfill.test.ts` (bound to an
OS-assigned port, closed by that suite's own teardown). Nothing to clean up. The two new
committed fixtures (`push.tag.json`, `push.malformed-full-name.json`) are intentionally
retained per `spec.md` — they are `red`/`dev`-stage artifacts, not this stage's.

## Limitations

See `manifest.json`'s `limitations` array (reproduced): no formal risk-acceptance record
for `FND-fa14278279d8`; the `X-GitHub-Event` header's own lack of HMAC coverage (pre-existing,
protocol-level, out of this diff's threat model); this run's dynamic verification being
limited to the pre-existing local Vitest suite (no live broker or deployed instance
exercised); and no comparable baseline existing for any observation in this run (see
Section 1), so all trajectory claims above are necessarily `FIRST_OBSERVATION`/`NOT_COMPARABLE`
rather than genuine trend data.

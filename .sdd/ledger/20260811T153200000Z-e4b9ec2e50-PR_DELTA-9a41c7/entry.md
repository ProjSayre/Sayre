# Ledger entry — 20260811T153200000Z-e4b9ec2e50-PR_DELTA-9a41c7 (GAPFILL)

## Date
2026-08-11

## Ticket
W1-02

W1-02 — GitHub webhook receiver (gapfill: GAP-4 … GAP-9)

## Spec Goal
Close the six real defects gap-scout narrowed on the already-shipped W1-02 receiver: bind replay/dedup identity to the signed bytes rather than an unsigned header, constrain `push` to branch refs, make a malformed `installation.id` a clean 2xx-ignore/400 instead of a 500 + GitHub retry storm, validate `repository.full_name` to a real `owner/name` shape before anything is published, actually assert the BullMQ half of "replayed fixtures produce correct queue messages", and resolve the 5 MB body-cap tradeoff explicitly and observably.

## Files touched
- Documents/PRD/Audit-Rebuild-Cheat-Sheet.md
- Documents/PRD/PRD V1.md
- Documents/PRD/Ticket-Backlog-Flat.md
- Documents/PRD/Ticket-Backlog-by-Feature-2.md
- services/core/src/app.ts
- services/core/src/github/repoFullName.test.ts
- services/core/src/github/repoFullName.ts
- services/core/src/http/express.gapfill.test.ts
- services/core/src/http/express.ts
- services/core/src/queue/__fixtures__/repo_push.branch-deletion.envelope.json
- services/core/src/queue/__fixtures__/repo_push.envelope.json
- services/core/src/routes/githubWebhook.bodyCap.gapfill.test.ts
- services/core/src/routes/githubWebhook.fixtures.test.ts
- services/core/src/routes/githubWebhook.gapfill.test.ts
- services/core/src/routes/githubWebhook.test.ts
- services/core/src/routes/githubWebhook.ts
- services/core/src/services/githubWebhookService.gapfill.test.ts
- services/core/src/services/githubWebhookService.test.ts
- services/core/src/services/githubWebhookService.ts
- services/core/src/webhooks/__fixtures__/push.malformed-full-name.json
- services/core/src/webhooks/__fixtures__/push.tag.json
- services/core/src/webhooks/githubDeliveryIdentity.test.ts
- services/core/src/webhooks/githubDeliveryIdentity.ts
- services/core/src/webhooks/normalizeGithubEvent.gapfill.test.ts
- services/core/src/webhooks/normalizeGithubEvent.ts

## Verdicts
- review: PASS
- security: PASS

## Gapfill lane
this run took the gapfill lane (`.sdd/pipeline.md`'s `/pipeline-gapfill`): `gap-scout` audited an already-shipped MVP ticket against its acceptance criteria, and `planner`/`red`/`dev` only addressed non-OK gaps. `tester`, `review`, and `security` all ran in full. Overlays came from `.sdd/mvp-overlays.yml` and the Audit-Rebuild cheat sheet. This is disclosure that the work was gap-scoped, not a skipped-gate bypass.

Overlays: base, spot-check.
Gap counts: 6 non-OK of 9 (OK 3; open statuses: {"OK":3,"NARROWED":5,"UNTESTED":1}).

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/webhooks/githubDeliveryIdentity.test.ts
- services/core/src/github/repoFullName.test.ts
- services/core/src/webhooks/normalizeGithubEvent.gapfill.test.ts
- services/core/src/services/githubWebhookService.gapfill.test.ts
- services/core/src/routes/githubWebhook.gapfill.test.ts
- services/core/src/routes/githubWebhook.bodyCap.gapfill.test.ts
- services/core/src/http/express.gapfill.test.ts
- services/core/src/routes/githubWebhook.fixtures.test.ts
- services/core/src/routes/githubWebhook.test.ts
- services/core/src/services/githubWebhookService.test.ts

## Security run ID
.pipeline/security-history/20260811T153200000Z-e4b9ec2e50-PR_DELTA-9a41c7/

## Commit
e4b9ec2e501fe17184e21e16599f528065bb0b7b (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)

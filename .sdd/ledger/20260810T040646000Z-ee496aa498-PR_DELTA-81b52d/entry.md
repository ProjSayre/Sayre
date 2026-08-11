# Ledger entry — 20260810T040646000Z-ee496aa498-PR_DELTA-81b52d (GAPFILL)

## Date
2026-08-10

## Ticket
W0-04

W0-04 — SQS + BullMQ wiring (GAPFILL: GAP-3a/4/4a/5)

## Spec Goal
Close W0-04's literal acceptance line against a live broker: build a real priority mechanism on the BullMQ (Node) side so a priority job demonstrably drains ahead of a default backlog, and add genuine cross-language, live-broker round-trip tests (Node→Python and Python→Node) to replace the current same-language-only round-trips and the single static on-disk fixture.

## Files touched
- .github/workflows/ci.yml
- Documents/PRD/Audit-Rebuild-Cheat-Sheet.md
- Documents/PRD/PRD V1.md
- Documents/PRD/Ticket-Backlog-Flat.md
- Documents/PRD/Ticket-Backlog-by-Feature-2.md
- docs/wave0-foundation-contracts.md
- services/core/src/queue/__tests__/bullmq.lane.test.ts
- services/core/src/queue/__tests__/bullmq.priority.test.ts
- services/core/src/queue/__tests__/initialParse.fixture.test.ts
- services/core/src/queue/__tests__/w0-04.acceptance-wiring.test.ts
- services/core/src/queue/bullmq.ts
- services/core/test/cross-runtime/publishIngestion.ts
- services/core/vitest.config.ts
- services/gateway/test/cross-runtime/consumeRealtime.ts
- services/workers/tests/test_cross_runtime_roundtrip.py
- services/workers/tests/test_initial_parse_wire_fixture.py
- services/workers/tests/test_messaging_topology.py
- services/workers/tests/test_sqs_roundtrip.py

## Verdicts
- review: PASS
- security: PASS

## Gapfill lane
this run took the gapfill lane (`.sdd/pipeline.md`'s `/pipeline-gapfill`): `gap-scout` audited an already-shipped MVP ticket against its acceptance criteria, and `planner`/`red`/`dev` only addressed non-OK gaps. `tester`, `review`, and `security` all ran in full. Overlays came from `.sdd/mvp-overlays.yml` and the Audit-Rebuild cheat sheet. This is disclosure that the work was gap-scoped, not a skipped-gate bypass.

Overlays: base.
Gap counts: 4 non-OK of 7 (OK 3; open statuses: {"OK":3,"NARROWED":2,"UNTESTED":2}).

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- services/core/src/queue/__tests__/bullmq.lane.test.ts
- services/core/src/queue/__tests__/bullmq.priority.test.ts
- services/core/src/queue/__tests__/w0-04.acceptance-wiring.test.ts
- services/workers/tests/test_messaging_topology.py
- services/workers/tests/test_cross_runtime_roundtrip.py

## Security run ID
.pipeline/security-history/20260810T040646000Z-ee496aa498-PR_DELTA-81b52d/

## Commit
ee496aa4985fc4145afbadf34c54de9cf3e9910a (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)

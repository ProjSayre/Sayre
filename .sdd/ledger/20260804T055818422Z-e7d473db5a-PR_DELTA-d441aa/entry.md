# Ledger entry — 20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa

## Date
2026-08-04

## Ticket
W0-00

Spec — W0-00: Dependency & Environment Baseline (re-derivation / audit)

## Spec Goal
Every third-party dependency named in the PRD (and every additional package any later ticket has
since added to `apps/web`, `services/core`, `services/gateway`, `packages/*`, and
`services/workers`) is pinned to a specific version in exactly one place per runtime, resolves on a
fresh clone with zero version-resolution conflicts, and appears in `DEPENDENCIES.md` with a purpose,
a PRD/architecture reference, and (where applicable) a known-future-swap note — so no two parallel
tickets pick incompatible versions and no migration is a surprise dependency hunt later.

## Files touched
- DEPENDENCIES.md
- package-lock.json
- scripts/dependency-baseline.test.mjs
- scripts/dependency-install.test.mjs
- services/core/package.json
- services/core/src/mcp/gateway.ts
- services/workers/poetry.lock
- services/workers/pyproject.toml

## Verdicts
- review: PASS
- security: PASS

## Red-test paths
- scripts/dependency-baseline.test.mjs
- scripts/dependency-install.test.mjs

## Security run ID
.pipeline/security-history/20260804T055818422Z-e7d473db5a-PR_DELTA-d441aa/

## Commit
e7d473db5ac52f59a654d3ace636fa385e23e3f0 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)

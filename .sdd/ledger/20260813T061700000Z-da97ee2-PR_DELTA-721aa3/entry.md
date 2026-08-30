# Ledger entry — 20260813T061700000Z-da97ee2-PR_DELTA-721aa3

## Date
2026-08-13

## Ticket
PL-TRIM — drastically slim `.sdd/pipeline.md` into core + per-command entrypoints

PL-TRIM — drastically slim `.sdd/pipeline.md` into core + per-command entrypoints

## Spec Goal
Cut what a /pipeline coordinator must read at the start of every run from ~950 lines to the core file plus one small per-command file, by splitting .sdd/pipeline.md into a short core (stage sequence, routing, loop cap, staleness table, entry-point stubs), one .sdd/entrypoints/<cmd>.md per command, and one .sdd/pipeline-history.md for the archaeology no agent needs in order to run a stage — with a CI check that locks the split in place.

## Files touched
- .claude/skills/dev/SKILL.md
- .claude/skills/gap-scout-only/SKILL.md
- .claude/skills/hotfix/SKILL.md
- .claude/skills/inline-edit/SKILL.md
- .claude/skills/pipeline-gapfill/SKILL.md
- .claude/skills/pipeline-lite/SKILL.md
- .claude/skills/pipeline-status/SKILL.md
- .claude/skills/pipeline/SKILL.md
- .claude/skills/planner/SKILL.md
- .claude/skills/re-gate/SKILL.md
- .claude/skills/red/SKILL.md
- .claude/skills/review/SKILL.md
- .claude/skills/security-recheck/SKILL.md
- .claude/skills/security/SKILL.md
- .claude/skills/spec-only/SKILL.md
- .claude/skills/tester/SKILL.md
- .github/workflows/ci.yml
- .sdd/README.md
- .sdd/entrypoints/dev.md
- .sdd/entrypoints/gap-scout-only.md
- .sdd/entrypoints/hotfix.md
- .sdd/entrypoints/inline-edit.md
- .sdd/entrypoints/pipeline-gapfill.md
- .sdd/entrypoints/pipeline-lite.md
- .sdd/entrypoints/pipeline-status.md
- .sdd/entrypoints/pipeline.md
- .sdd/entrypoints/planner.md
- .sdd/entrypoints/re-gate.md
- .sdd/entrypoints/red.md
- .sdd/entrypoints/review.md
- .sdd/entrypoints/security-recheck.md
- .sdd/entrypoints/security.md
- .sdd/entrypoints/spec-only.md
- .sdd/entrypoints/tester.md
- .sdd/pipeline-history.md
- .sdd/pipeline.md
- AGENTS.md
- CLAUDE.md
- docs/product/Pipeline-Efficiency-Plan.md
- package.json
- scripts/check-pipeline-slim.mjs
- scripts/check-pipeline-slim.test.mjs
- scripts/pipeline-trim-structural.test.mjs
- scripts/sdd-completeness.test.mjs
- scripts/tsconfig.json

## Verdicts
- review: PASS
- security: PASS

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- scripts/check-pipeline-slim.test.mjs
- scripts/pipeline-trim-structural.test.mjs

## Security run ID
.pipeline/security-history/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/

## Commit
da97ee2ed2b435e849fc407eb08d4be528eb8564 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)

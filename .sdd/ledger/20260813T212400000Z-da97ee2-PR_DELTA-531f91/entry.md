# Ledger entry — 20260813T212400000Z-da97ee2-PR_DELTA-531f91

## Date
2026-08-13

## Ticket
PL-INTEGRITY-TESTER — move red-test integrity (mechanical check + judgment) from review to tester

PL-INTEGRITY-TESTER — move red-test integrity (mechanical check + judgment) from review to tester

## Spec Goal
Make tester the single owner of red-test integrity and @spec trace: it runs scripts/check-red-integrity.mjs, applies the judgment rules review applies today, and publishes the outcome in a new .pipeline/red-integrity.json sidecar. review stops reading red.md and stops running the script; it consumes the sidecar's verdict and blocks on anything that is not a clean PASS. The gate's strength is unchanged — only its owner is.

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
- .pipeline/README.md
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
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/changes.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/entry.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/entry.md
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/red.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/review.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/security.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/security/manifest.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/security/report.md
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/security/results.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/spec.json
- .sdd/ledger/20260813T061700000Z-da97ee2-PR_DELTA-721aa3/spec.md
- .sdd/ledger/index.json
- .sdd/pipeline-history.md
- .sdd/pipeline.md
- .sdd/stages/CHANGELOG.md
- .sdd/stages/dev.md
- .sdd/stages/review.md
- .sdd/stages/tester.md
- AGENTS.md
- CLAUDE.md
- docs/product/Pipeline-Efficiency-Plan.md
- package.json
- scripts/check-pipeline-slim.mjs
- scripts/check-pipeline-slim.test.mjs
- scripts/check-stamp-freshness.mjs
- scripts/check-stamp-freshness.test.mjs
- scripts/pipeline-contracts.mjs
- scripts/pipeline-contracts.test.mjs
- scripts/pipeline-trim-structural.test.mjs
- scripts/sdd-completeness.test.mjs
- scripts/tsconfig.json

## Verdicts
- review: PASS
- security: PASS

## Overrides
(none — both gates passed on their own; nothing here was overridden)

## Red-test paths
- scripts/sdd-completeness.test.mjs
- scripts/pipeline-contracts.test.mjs
- scripts/check-stamp-freshness.test.mjs

## Security run ID
.pipeline/security-history/20260813T212400000Z-da97ee2-PR_DELTA-531f91/

## Commit
da97ee2ed2b435e849fc407eb08d4be528eb8564 (worktree was dirty when the security run audited it — the commit that actually lands this work may differ once it's committed)

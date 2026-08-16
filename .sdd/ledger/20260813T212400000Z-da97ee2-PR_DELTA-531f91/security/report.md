# Security audit report — PL-INTEGRITY-TESTER

## Verdict

PASS

## Run and baseline

- **Run ID:** 20260813T212400000Z-da97ee2-PR_DELTA-531f91
- **Mode:** PR_DELTA
- **Commit:** da97ee2ed2b435e849fc407eb08d4be528eb8564 (dirty)
- **Branch:** pipeline-changes-quick-trim
- **Environment:** local-static-analysis
- **Baseline:** 20260813T061700000Z-da97ee2-PR_DELTA-721aa3 (comparable: false — dirty-delta / ticket-scope)
- **Artifacts:** `.pipeline/security-history/20260813T212400000Z-da97ee2-PR_DELTA-531f91/`

## Security trajectory

- New findings: none
- Regressed findings: none
- Persisting findings: none
- Resolved findings: none
- Risk-accepted findings: none

## Coverage trajectory

- All selected checks observed (CORE-01..06 plus selected SEC/SC briefs)
- Transitions: NOT_COMPARABLE vs baseline (incompatible dirty-delta/ticket-scope)
- No LOST coverage on CRITICAL/HIGH boundaries

## Findings

None.

## Verified-clean / applicable checks

- CORE-03 PASS — no secrets in modified scripts
- CORE-06 PASS — JSON readers / closed READERS allowlist; no shell/Cypher/SQL injection surface
- Selected SEC/SC checks PASS or NOT_APPLICABLE with inventory evidence

## Limitations

- Static analysis only — runtime tests not authorized; no dynamic verification of any boundary.
- Worktree is dirty (PL-TRIM + PL-INTEGRITY-TESTER uncommitted); analysis performed against working-tree files for this ticket's paths.
- Baseline run 20260813T061700000Z-da97ee2-PR_DELTA-721aa3 is same branch/commit but dirty-delta/ticket-scope incompatible; all observations classified NOT_COMPARABLE / FIRST_OBSERVATION.
- Non-triggered surfaces (llm-rag, model-provider, mcp, websocket-realtime, ingestion-queue-webhook, web-api-client) not examined beyond routing.
- review.json stamp freshness verified (exit 0) before this run.

## Cleanup

No throwaway fixtures created. No repository file outside this run's own `.pipeline/security-history/20260813T212400000Z-da97ee2-PR_DELTA-531f91/` artifacts was created, modified, or left behind by this security stage.

## Recheck scope

If remediating a future BLOCKED finding on this ticket, re-run CORE-03/CORE-06 and the secrets-audit / supply-chain selected checks against the same changed paths.

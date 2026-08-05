# Full security audit

Use only when `state.securityPlan.mode` is `FULL` or `MILESTONE`. FAST runs must not pay this cost.

1. Read `security-attacker-agents/audit-contract.md`,
   `security-attacker-agents/progress-audit-orchestrator.md`, and
   `security-attacker-agents/agent-registry.json`. Use
   `security-attacker-agents/schemas/audit-run-manifest.schema.json` and
   `security-attacker-agents/schemas/audit-results.schema.json`; load only the mandatory core checks
   and briefs selected by the changed surface.
2. Inventory the target commit/diff and create one immutable audit ID.
3. Write `manifest.json`, `results.json`, and `report.md` under
   `.pipeline/runs/<pipeline-run-id>/security-history/<audit-id>/` using the registry schemas.
4. Preserve honest NOT_APPLICABLE/UNVERIFIED results and coverage comparison rules. Mandatory
   tenant/RBAC/secret/webhook/ingestion failures block the pipeline.
5. Validate the directory with `node scripts/validate-security-audit-run.mjs <audit-directory>`.
6. Put the audit ID in the security draft and submit it through `pipeline-run emit security`.

The durable ledger copies the validated audit directory only after terminal PASS. Never write full
audit history to the old shared `.pipeline/security-history/` for a v2 run.

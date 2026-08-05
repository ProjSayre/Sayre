# Security

Run the risk-selected final security gate. This stage is read-only with respect to source code; its
only normal write is evidence under the current run.

## Inputs

- Current state, PASS review, spec/dev/verify artifacts, and git diff.
- `state.securityPlan.mode`, `requiredChecks`, and `surfaces` are authoritative.
- Security and multitenancy rules named by `AGENTS.md`.

## FAST (normal path)

Inspect only the diff, affected boundaries, and required checks. Do not load the attacker registry
or compare historical audit coverage. At minimum, establish the secret-diff and injection-diff
checks. When the plan names tenant/RBAC, webhook, ingestion, supply-chain, or pipeline-control
surfaces, test those explicitly. A FAST PASS requires affirmative PASS evidence for every required
check; NOT_APPLICABLE or UNVERIFIED cannot satisfy it.

## FULL or MILESTONE

Follow `.sdd/stages/security-full.md`. Produce the immutable audit directory inside this run's
`security-history/`, validate it, and include its audit ID in the draft. MILESTONE uses the same
contract but is an explicitly requested broad audit rather than a per-diff escalation.

## Output and routing

1. Require `next: security` and an existing PASS review.
2. Get the draft shape with `node scripts/pipeline-run.mjs schema security`.
3. Include every required check exactly with concise evidence, findings, and honest limitations.
4. Run `emit security`.

PASS routes to finalize. BLOCKED routes to dev and consumes a shared attempt. Tenant isolation,
RBAC boundary, secret exposure, webhook trust, or ingestion ephemerality failures are blockers even
when the change otherwise appears small.

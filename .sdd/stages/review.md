# Review

Judge spec conformance, correctness, and maintainability after deterministic verification. Review
is read-only with respect to source code; its only write is the draft under the current run.

## Inputs

- Current `spec.json`, optional `red.json`, `dev.json`, and PASS `verify.json`.
- Git diff from the run's base SHA.
- Relevant architecture/rule files and latest attempt history when fixes were routed.

## Procedure

1. Require `next: review`; do not re-run the test suite already recorded by verify.
2. Compare each AC/EC with code and evidence. Inspect declared red-test changes closely.
3. Check scope, API compatibility, error behavior, tenant boundaries, test adequacy, and unreported
   deviations. Do not make product edits.
4. Use `NEEDS_FIXES` only for a blocking correctness/spec issue and include at least one `critical`
   finding with file/line where possible. Warnings and suggestions do not force a loop.
5. Use `node scripts/pipeline-run.mjs schema review`, write the draft, and run `emit review`.

PASS routes to security. NEEDS_FIXES routes to dev and is bounded by the shared three-attempt cap.
The settings-level read-only guard remains the enforcement for Write/Edit tools; Bash cannot be
made generally read-only, so use it only for inspection.

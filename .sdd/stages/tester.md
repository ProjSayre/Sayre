# Deterministic verifier (legacy name: tester)

There is no tester agent. Verification is a control-plane command:

```text
node scripts/pipeline-run.mjs verify
```

It requires `next: verify`, checks red-test integrity, de-duplicates the red/dev argv plans, runs
each command once without a shell, stops after the first failure, and writes bounded logs plus
`artifacts/verify.json` and generated Markdown.

It never edits source or tests. PASS routes to review. FAIL routes to dev and consumes one of the
three allowed development attempts. For a FAST review-only run, an empty command plan is allowed;
automated-test criteria always require at least one command.

`/tester` remains as a compatibility command name, but it invokes this script directly.

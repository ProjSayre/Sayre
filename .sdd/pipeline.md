# Pipeline procedure

This file is the runtime-neutral orchestration contract. `scripts/pipeline-run.mjs` is the
mechanical authority for state transitions and artifacts; stage files define the judgment work.

## One-time rules for every command

1. Read `AGENTS.md`, `README.md`, the relevant `package.json`, `CLAUDE.md`, and any component rule
   named by `AGENTS.md`.
2. For backlog tickets, fetch `origin/main` and read the PRD/ticket from that revision. Work in the
   ticket's clean worktree and honor its dependency base.
3. Never reuse a legacy `.pipeline/spec.md` or another run directory. Resolve the active run only
   through `.pipeline/current.json` or an explicit `--run`.
4. Agents write only a draft JSON. The runner validates it and generates JSON/Markdown artifacts.
5. Run `node scripts/pipeline-run.mjs status` whenever state is uncertain; do not infer state from
   filenames.

## `/pipeline <ticket>`

Initialize:

```text
node scripts/pipeline-run.mjs init --ticket <exact independently supplied ticket>
```

Then repeat until `next` is null:

| `next` | Action |
|---|---|
| `planner` | Invoke planner with the exact ticket and run ID. |
| `red` | Invoke red. |
| `dev` | Invoke dev. |
| `verify` | Run `node scripts/pipeline-run.mjs verify`. No agent. |
| `review` | Invoke review. |
| `security` | Invoke security in the mode recorded in `state.securityPlan`. |
| `finalize` | Run `node scripts/pipeline-run.mjs finalize`. |

After every stage, read the runner's `next`, `attempt`, and `status`. Never hand-route. A failed
verification, `NEEDS_FIXES`, or `BLOCKED` outcome returns to dev. The runner blocks after the third
development attempt.

The happy path is five agent calls: planner, optional red, dev, review, security. Verification and
ledger work are deterministic local commands.

## Stage-only commands

All stage-only commands operate on the current run and stop after the named action.

- `/planner <ticket>` and `/spec-only <ticket>`: initialize if needed, invoke planner, stop.
- `/red`: require `next: red`, invoke red, stop.
- `/dev`: require `next: dev`, invoke dev, stop.
- `/tester`: compatibility name for `node scripts/pipeline-run.mjs verify`; no tester agent exists.
- `/review`: require `next: review`, invoke review, stop.
- `/security`: require `next: security`, invoke the selected FAST/FULL/MILESTONE security pass,
  stop unless explicitly asked to finalize.
- `/pipeline-status`: run `node scripts/pipeline-run.mjs status`; make no writes.

An agent obtains its current draft contract with:

```text
node scripts/pipeline-run.mjs schema <planner|red|dev|review|security>
```

It writes the draft under the active run's `drafts/` directory and submits it with:

```text
node scripts/pipeline-run.mjs emit <stage> --input <draft-path>
```

## Security selection

`init --profile auto` is the default. Planner scope and the actual changed paths determine the
minimum profile:

- `fast`: documentation/review-only work; FAST security.
- `standard`: ordinary product work; FAST security.
- `sensitive`: auth, tenancy, RBAC, persistence, webhooks, ingestion, secrets, infrastructure, or
  pipeline-control changes; FULL security.
- `milestone`: explicit scheduled broad audit; MILESTONE security.

A requested profile may raise, never lower, the inferred profile. The exact required checks are in
`state.securityPlan`; the security stage may not substitute its own checklist.

## Recheck and hand edits

If source changes after review or security, those artifacts become stale and `finalize` refuses.
For an active run, execute `node scripts/pipeline-run.mjs reopen --reason <what changed>`, record the
hand edit through dev (`fixesApplied`), then
run verify, review, and security again. `/re-gate` remains a compatibility path for legacy v1
artifacts; a v2 run already promoted to the ledger requires a new run rather than mutation of
history. `/security-recheck` is a compatibility alias
for re-running the current security stage and never makes a stale review sufficient for finalize.

## `/hotfix <what is broken>`

Follow `.sdd/hotfix.md`. It deliberately bypasses this state machine, remains ineligible for
sensitive paths, and writes a disclosed legacy bypass ledger entry. Nothing in the lean runner
broadens hotfix authority.

## `/pr-review <PR#>`

Follow `.sdd/stages/pr-review.md`. It is outside the per-ticket pipeline and reads the committed
ledger copy when run-scoped scratch artifacts are unavailable.

## Failure handling

- Missing input: name the required preceding stage; do not invent an artifact.
- Malformed draft or typoed flag: stop on the runner's error and correct the draft/invocation.
- Failed verification: use its bounded log, fix through dev, and let the runner count the attempt.
- Exhausted attempts or required external decision: report `state.blockedReason` and stop.
- Terminal PASS: finalize exactly once. Never hand-copy scratch artifacts into the ledger.

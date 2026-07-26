# Dynamic coverage refresh

W4-03 turns W2-07's static `Test -[:COVERS]-> File` hints into measured,
revision-scoped coverage state. Test execution stays in an isolated CI task; product
reads continue to use the graph and never inspect a live repository checkout.

## End-to-end flow

1. Structural ingestion projects parsed `Test` nodes and inferred `COVERS` edges,
   and stamps each changed File's `last_structural_change_at` (used by step 2 to
   decide what needs a fresh coverage measurement). Inferred edges have
   `status = "inferred"` and no `last_run`.
2. **`scripts/schedule_dynamic_coverage.py`** (the nightly producer) enumerates every
   currently-tracked `{org, repository, ref}` from Postgres (the system of record for
   which refs exist), and for each one queries the graph for File nodes whose
   `last_structural_change_at` is newer than that ref's most recent COVERS
   measurement. Refs with nothing new since last night are skipped entirely — no
   full-suite run gets enqueued for an untouched repo. For every ref with real
   changes, it publishes one `coverage.nightly` envelope onto the physical
   `dynamic-coverage-refresh` SQS queue (provisioned like every other lane, with its
   own DLQ). Tenant identity comes only from the signed/internal envelope, never from
   this script's own enumeration query.
3. **`sayre_workers.dynamic_coverage.consumers.run_coverage_consumer`** is the
   long-running worker process that drains that queue (mirrors
   `sayre_workers.ingestion.consumers.run_ingestion_consumer`), calling
   `CoverageRefreshService.handle()` once per message.
4. The impact planner loads only that exact graph scope. It chooses a targeted set
   only when every changed source has fresh measured topology.
5. `CommandCoverageRunExecutor` sends the plan to an operator-configured,
   coverage-instrumented CI adapter over stdin. It invokes an argument vector without
   a shell, has a bounded timeout and output size, discards stderr, and never includes
   command output in errors.
6. The adapter returns a normalized `CoverageRunReport`. One graph transaction locks
   the current root, rejects a stale revision, validates every covered File against
   that head, replaces the measured edges for reported tests, and stamps
   `status = "measured"` plus `last_run`.
7. The Graph Query Service reduces authorized COVERS observations to File-level
   badge metadata. `Test` nodes and test paths never become canvas nodes.

### Deployment

Two processes, same split as every other queue in this fleet (a producer step and a
long-running consumer):

- **Producer** — `scripts/schedule_dynamic_coverage.py` is invoked once nightly by an
  external scheduler (a cron entry, an AWS EventBridge scheduled rule, or a scheduled
  CI job). It enqueues work and exits; this repository does not itself run a
  scheduler process. `--dry-run` prints what would be scheduled without publishing.
- **Consumer** — a long-running process wiring `run_coverage_consumer` (started the
  same way the ingestion/enrichment consumer processes are started) continuously
  drains `dynamic-coverage-refresh` and runs the CI adapter per message.

For a one-off manual run against a hand-built envelope (debugging, backfill, or a
single ref outside the nightly sweep), `scripts/run_dynamic_coverage.py` remains
available:

```text
poetry run python scripts/run_dynamic_coverage.py nightly-envelope.json -- <ci-adapter> [args...]
```

The scheduler and CI adapter are deployment-owned boundaries. The adapter may invoke
a provider workflow or run inside an existing hardened CI container; the Sayre
service does not clone a repository or execute repository input itself.

## Safe full-suite fallback

The runner receives `mode = "full_suite"` and an empty `tests` array whenever any of
these conditions makes impact analysis inconclusive:

- build, dependency-lock, test-runner, or CI configuration changed;
- parsing was partial;
- the scheduler supplied no changed paths;
- any changed source lacks COVERS topology;
- a relevant edge is inferred, has never been measured, or is older than seven days.

Only fresh, measured topology for every changed source yields `mode = "targeted"`.
Changed test files are included directly in that targeted set. This makes the
fallback fail safe: uncertainty increases test scope rather than silently omitting
tests.

## Runner input

The CI adapter receives one JSON object on stdin:

```json
{
  "org_id": "org-1",
  "repository_id": "repo-1",
  "ref_name": "refs/heads/main",
  "revision_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "triggered_at": "2026-07-23T12:00:00+00:00",
  "mode": "targeted",
  "tests": ["tests/test_app.py"],
  "fallback_reason": null
}
```

For full-suite mode, the adapter must ignore test selection and run its complete test
command with coverage instrumentation.

## Normalized report

The adapter emits one JSON object on stdout:

```json
{
  "org_id": "org-1",
  "repository_id": "repo-1",
  "ref_name": "refs/heads/main",
  "revision_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "completed_at": "2026-07-23T12:30:00Z",
  "measurements": [
    {
      "test_path": "tests/test_app.py",
      "file_paths": ["src/app.py"],
      "outcome": "pass"
    }
  ]
}
```

Paths must be canonical repository-relative POSIX paths. A report may contain only
one outcome per test. Unknown files reject and roll back the entire graph
transaction; a report for a superseded revision is a harmless no-op.

## Badge semantics

Badges are computed server-side from authorized graph records:

- **FAIL**: at least one covering test's latest measured outcome failed.
- **STALE**: no failure exists, but a measurement is missing, older than seven days,
  or predates either the File's trusted ingestion `last_structural_change_at` or its
  ownership-derived `last_edited_at`.
- **PASS**: all visible covering observations are measured, fresh, and passing.
- **UNMEASURED**: no authorized COVERS observation exists.

Failure wins over stale, stale wins over pass, and the response exposes only the
summary status, latest run timestamp, and covering-test count. React Flow displays a
pill badge; Sigma uses the same status palette and appends the status to the node
label.

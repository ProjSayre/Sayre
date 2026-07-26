"""Nightly producer for the dynamic-coverage refresh queue.

This is the missing scheduling half of W4-03: previously the only way a real
coverage refresh ran was an operator hand-building one `coverage.nightly`
envelope and invoking `run_dynamic_coverage.py` per ref. This script instead
enumerates every currently-tracked (org, repository, ref) from Postgres --
the system of record for what refs exist -- computes each ref's changed
paths from the graph (File nodes whose `last_structural_change_at` is newer
than that ref's most recent measured/inferred COVERS refresh), and publishes
one `coverage.nightly` envelope per ref onto DYNAMIC_COVERAGE_QUEUE for
`sayre_workers.dynamic_coverage.consumers.run_coverage_consumer` to drain.

This script is the PRODUCER only -- it enqueues work and exits; it never runs
a test suite itself. A long-running consumer process (started separately,
e.g. `poetry run python -c "..."` wiring `run_coverage_consumer`, mirroring
how the ingestion/enrichment consumers are started) drains the queue.

Deployment: intended to be invoked once nightly by an external scheduler --
a cron entry, an AWS EventBridge scheduled rule, or a scheduled CI job --
same pattern any "nightly batch" step uses; this repository does not itself
run a scheduler process. Refs with no structural changes since their last
coverage measurement are skipped (no full-suite run gets enqueued for a repo
untouched since last night).

Usage:
    poetry run python scripts/schedule_dynamic_coverage.py [--dry-run]

Connects to Postgres via the pre-provisioned admin/superuser DSN to enumerate
across every tenant -- the same trusted-internal-process posture already used
by scripts/run_graph_migrations.py and scripts/synthetic_vector_load.py, never
exposed to a request path or client input.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass

sys.path.insert(0, ".")  # allow running as `python scripts/schedule_dynamic_coverage.py`
from datetime import datetime, timezone

import psycopg
from neo4j import AsyncDriver, AsyncGraphDatabase
from psycopg.rows import dict_row

from messaging.envelope import MessageEnvelope
from messaging.sqs_client import DYNAMIC_COVERAGE_QUEUE, initialize_client, publish
from sayre_workers.config import get_config, get_secret
from sayre_workers.ingestion.events import graph_scope_key
from sayre_workers.ingestion.models import GraphScope

_TRACKED_REFS_SQL = """
SELECT r.org_id::text AS org_id,
       r.repository_id::text AS repository_id,
       r.ref_name AS ref_name,
       r.revision_sha AS revision_sha,
       r.graph_version AS graph_version
FROM repository_refs AS r
"""

_CHANGED_PATHS_CYPHER = """
MATCH (file:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
WHERE file.last_structural_change_at IS NOT NULL
OPTIONAL MATCH (:Test {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
    -[coverage:COVERS {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name}]->(file)
WITH file, max(coverage.last_run) AS last_measured
WHERE last_measured IS NULL OR file.last_structural_change_at > last_measured
RETURN file.path AS path
ORDER BY file.path
"""


@dataclass(frozen=True)
class TrackedRef:
    org_id: str
    repository_id: str
    ref_name: str
    revision_sha: str
    graph_version: int


async def _load_tracked_refs() -> tuple[TrackedRef, ...]:
    dsn = await get_secret("env://DATABASE_ADMIN_URL")
    async with await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row) as connection:
        cursor = await connection.execute(_TRACKED_REFS_SQL)
        rows = await cursor.fetchall()
    return tuple(
        TrackedRef(
            org_id=row["org_id"],
            repository_id=row["repository_id"],
            ref_name=row["ref_name"],
            revision_sha=row["revision_sha"],
            graph_version=row["graph_version"],
        )
        for row in rows
    )


async def _changed_paths(driver: AsyncDriver, ref: TrackedRef) -> tuple[str, ...]:
    records, _summary, _keys = await driver.execute_query(
        _CHANGED_PATHS_CYPHER,
        org_id=ref.org_id,
        repo_id=ref.repository_id,
        ref_name=ref.ref_name,
    )
    return tuple(record["path"] for record in records)


def _publish_nightly(ref: TrackedRef, changed_paths: tuple[str, ...]) -> str:
    scope = GraphScope(
        org_id=ref.org_id,
        repository_id=ref.repository_id,
        ref_name=ref.ref_name,
        revision_sha=ref.revision_sha,
    )
    scope_key = graph_scope_key(scope)
    now = datetime.now(timezone.utc)
    envelope = MessageEnvelope(
        org_id=ref.org_id,
        type="coverage.nightly",
        source="dynamic-coverage-scheduler",
        idempotency_key=f"{scope_key}:{ref.revision_sha}:coverage.nightly:{now.date().isoformat()}",
        graph_scope_key=scope_key,
        graph_version=ref.graph_version,
        payload={
            "repository_id": ref.repository_id,
            "ref_name": ref.ref_name,
            "revision_sha": ref.revision_sha,
            "changed_paths": list(changed_paths),
            "parse_complete": True,
            "triggered_at": now.isoformat(),
        },
    )
    return publish(DYNAMIC_COVERAGE_QUEUE, envelope)


async def _run(dry_run: bool) -> int:
    await initialize_client()
    refs = await _load_tracked_refs()
    if not refs:
        print("no tracked repository refs found; nothing to schedule")
        return 0

    password = await get_secret("env://NEO4J_PASSWORD")
    driver = AsyncGraphDatabase.driver(
        get_config("NEO4J_URI"), auth=(get_config("NEO4J_USER"), password)
    )
    scheduled = 0
    skipped = 0
    try:
        for ref in refs:
            changed_paths = await _changed_paths(driver, ref)
            if not changed_paths:
                skipped += 1
                continue
            if dry_run:
                print(
                    f"[dry-run] would schedule {ref.org_id}/{ref.repository_id}"
                    f"@{ref.ref_name}: {len(changed_paths)} changed path(s)"
                )
            else:
                message_id = _publish_nightly(ref, changed_paths)
                print(
                    f"scheduled {ref.org_id}/{ref.repository_id}@{ref.ref_name}"
                    f" ({len(changed_paths)} changed path(s)) -> {message_id}"
                )
            scheduled += 1
    finally:
        await driver.close()

    print(f"done: {scheduled} scheduled, {skipped} skipped (no structural change since last measurement)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be scheduled without publishing any message.",
    )
    arguments = parser.parse_args()
    return asyncio.run(_run(arguments.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())

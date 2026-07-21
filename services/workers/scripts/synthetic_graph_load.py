"""Synthetic Neo4j graph-store query load generator (W0-08).

Long-running CLI that keeps `/metrics` alive and drives concurrent synthetic
Cypher queries (default 50) spread across several `org_id`s and round-robined
across all three query shapes, each routed through
`instrument_graph_query()` -- the same wrapper a real Graph Query Service
(W2-02) call site will use. Unlike `synthetic_vector_load.py` (which
sleep-simulates because no pgvector table exists yet), this script issues
REAL Cypher against local Neo4j by default: the graph schema (W0-02) already
exists, and the acceptance criterion requires real concurrent queries, not a
simulation. `--simulate` is retained as a Neo4j-less smoke/CI fallback.

Usage:
    poetry run python scripts/synthetic_graph_load.py
    poetry run python scripts/synthetic_graph_load.py --concurrency 50 --orgs <uuid-a> <uuid-b>
    poetry run python scripts/synthetic_graph_load.py --duration-seconds 60
    poetry run python scripts/synthetic_graph_load.py --print-queries   # show example PromQL and exit
    poetry run python scripts/synthetic_graph_load.py --keep-data       # leave seed data for manual inspection
    poetry run python scripts/synthetic_graph_load.py --simulate        # no Neo4j required

Trigger sufficiency (Neo4j -> Neptune, docs/migration-triggers.md):
  p95/p99 latency:
    histogram_quantile(0.95, sum by (le) (rate(graph_query_duration_ms_bucket[5m])))
    histogram_quantile(0.99, sum by (le) (rate(graph_query_duration_ms_bucket[5m])))
  sustained queries/sec:
    sum(rate(graph_query_duration_ms_count[5m]))
  concurrent multi-tenant load (grouped by org_id / by org_id+query_shape):
    sum by (org_id) (graph_query_concurrent_count)
    sum by (org_id, query_shape) (graph_query_concurrent_count)
  All three facets of the migration trigger are covered by the three
  instruments emitted here; explicit-bucket histogram boundaries
  (`otel.GRAPH_QUERY_DURATION_BUCKETS_MS` / `GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS`)
  are what make the histogram_quantile() calls above meaningful -- default
  OTel buckets are too coarse for the trigger's p95/p99 requirement.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Callable

sys.path.insert(0, ".")  # allow running as `python scripts/synthetic_graph_load.py`

from sayre_workers.graph_migrations.runner import neo4j_driver_from_env  # noqa: E402
from sayre_workers.telemetry.graph_metrics import (  # noqa: E402
    QUERY_SHAPE_TRAVERSAL,
    QUERY_SHAPE_VIEWPORT_READ,
    QUERY_SHAPE_WRITE,
    instrument_graph_query,
)
from sayre_workers.telemetry.otel import init_metrics, shutdown_metrics  # noqa: E402

if TYPE_CHECKING:  # pragma: no cover - type-checking only
    from neo4j import Driver

# Namespaces all seed nodes; NEVER '__schema_anchor__' (the W0-02 sentinel uid) --
# this prefix is also the second half of cleanup_org_data's delete-scope guard,
# alongside a real (non-sentinel) org_id, so a full seed/load/cleanup cycle can
# never touch the all-zero sentinel schema anchors or real tenant data.
SYNTHETIC_UID_PREFIX = "__synthetic_load__"
SYNTHETIC_ROOT_UID = f"{SYNTHETIC_UID_PREFIX}root"

# Real (non-sentinel) tenant org_ids -- never the all-zero W0-02 sentinel
# ('00000000-0000-0000-0000-000000000000').
DEFAULT_SYNTHETIC_ORGS = [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
]

EXAMPLE_PROMQL = """\
# --- Neo4j -> Neptune migration-trigger PromQL (docs/migration-triggers.md) ---
# p95 latency:
histogram_quantile(0.95, sum by (le) (rate(graph_query_duration_ms_bucket[5m])))
# p99 latency:
histogram_quantile(0.99, sum by (le) (rate(graph_query_duration_ms_bucket[5m])))
# sustained queries/sec:
sum(rate(graph_query_duration_ms_count[5m]))
# concurrent multi-tenant load by org:
sum by (org_id) (graph_query_concurrent_count)
# load broken down by query shape:
sum by (org_id, query_shape) (graph_query_concurrent_count)
# result-size distribution p95 by shape:
histogram_quantile(0.95, sum by (le, query_shape) (rate(graph_query_result_node_count_bucket[5m])))
"""


# --------------------------------------------------------------------------
# Seed / cleanup
# --------------------------------------------------------------------------


def seed_org_data(driver: "Driver", org_id: str, *, folders: int = 5, files_per_folder: int = 20) -> None:
    """MERGE one synthetic containment subtree per org: 1 root Folder, `folders`
    child Folders, `files_per_folder` File nodes per folder, all with
    org_id=org_id and uid=f'{SYNTHETIC_UID_PREFIX}...', linked by CONTAINS edges
    (also stamped org_id). Conforms to packages/graph-schema/schema.md (Folder:
    path/name; File: path/name/language; CONTAINS edge). Idempotent via MERGE --
    safe to call repeatedly for the same org_id."""
    with driver.session() as session:
        session.run(
            "MERGE (root:Folder {org_id: $org_id, uid: $uid}) "
            "SET root.path = $path, root.name = $name",
            org_id=org_id,
            uid=SYNTHETIC_ROOT_UID,
            path="/synthetic",
            name="synthetic",
        )

        for i in range(folders):
            folder_uid = f"{SYNTHETIC_UID_PREFIX}folder-{i}"
            session.run(
                "MATCH (root:Folder {org_id: $org_id, uid: $root_uid}) "
                "MERGE (folder:Folder {org_id: $org_id, uid: $uid}) "
                "SET folder.path = $path, folder.name = $name "
                "MERGE (root)-[:CONTAINS {org_id: $org_id}]->(folder)",
                org_id=org_id,
                root_uid=SYNTHETIC_ROOT_UID,
                uid=folder_uid,
                path=f"/synthetic/folder-{i}",
                name=f"folder-{i}",
            )

            for j in range(files_per_folder):
                file_uid = f"{SYNTHETIC_UID_PREFIX}file-{i}-{j}"
                session.run(
                    "MATCH (folder:Folder {org_id: $org_id, uid: $folder_uid}) "
                    "MERGE (file:File {org_id: $org_id, uid: $uid}) "
                    "SET file.path = $path, file.name = $name, file.language = $language "
                    "MERGE (folder)-[:CONTAINS {org_id: $org_id}]->(file)",
                    org_id=org_id,
                    folder_uid=folder_uid,
                    uid=file_uid,
                    path=f"/synthetic/folder-{i}/file-{j}.py",
                    name=f"file-{j}.py",
                    language="python",
                )


def cleanup_org_data(driver: "Driver", org_id: str) -> None:
    """DETACH DELETE every node this script seeded for org_id. Scoped by BOTH
    the synthetic org_id AND the uid prefix so it can never touch the all-zero
    sentinel schema anchors (W0-02, uid='__schema_anchor__') or any real
    tenant data -- even if org_id were ever accidentally a real tenant's id,
    only nodes carrying the synthetic uid prefix are deleted."""
    with driver.session() as session:
        session.run(
            "MATCH (n {org_id: $org_id}) WHERE n.uid STARTS WITH $prefix DETACH DELETE n",
            org_id=org_id,
            prefix=SYNTHETIC_UID_PREFIX,
        )


# --------------------------------------------------------------------------
# Query shapes (real Cypher, parameterized -- org_id is always a bound
# parameter, never string-interpolated)
# --------------------------------------------------------------------------


def _viewport_read(driver: "Driver", org_id: str) -> int:
    """Canvas-style bounded read of File nodes for one org. Result node count
    = rows returned."""
    with driver.session() as session:
        result = session.run(
            "MATCH (f:File {org_id: $org_id}) WHERE f.uid STARTS WITH $prefix "
            "RETURN f LIMIT $limit",
            org_id=org_id,
            prefix=SYNTHETIC_UID_PREFIX,
            limit=100,
        )
        return len(list(result))


def _write(driver: "Driver", org_id: str) -> int:
    """Single-node tenant write: MERGE one File under a per-call unique uid.
    Result node count = nodes written (1)."""
    write_uid = f"{SYNTHETIC_UID_PREFIX}write-{uuid.uuid4().hex}"
    with driver.session() as session:
        session.run(
            "MERGE (f:File {org_id: $org_id, uid: $uid}) "
            "SET f.path = $path, f.name = $name, f.language = $language "
            "RETURN f",
            org_id=org_id,
            uid=write_uid,
            path=f"/synthetic/writes/{write_uid}.py",
            name=f"{write_uid}.py",
            language="python",
        )
    return 1


def _traversal(driver: "Driver", org_id: str) -> int:
    """Multi-hop containment traversal from the seeded root. Result node
    count = descendants returned."""
    with driver.session() as session:
        result = session.run(
            "MATCH (root:Folder {org_id: $org_id, uid: $root_uid})-[:CONTAINS*1..3]->(n) "
            "RETURN n",
            org_id=org_id,
            root_uid=SYNTHETIC_ROOT_UID,
        )
        return len(list(result))


_SHAPE_TO_BLOCKING_FN: dict[str, Callable[["Driver", str], int]] = {
    QUERY_SHAPE_VIEWPORT_READ: _viewport_read,
    QUERY_SHAPE_WRITE: _write,
    QUERY_SHAPE_TRAVERSAL: _traversal,
}

_SHAPES_ROUND_ROBIN = (QUERY_SHAPE_VIEWPORT_READ, QUERY_SHAPE_WRITE, QUERY_SHAPE_TRAVERSAL)


# --------------------------------------------------------------------------
# Load driver
# --------------------------------------------------------------------------


async def _simulate_one_query() -> int:
    await asyncio.sleep(random.uniform(0.02, 0.2))
    return random.randint(0, 20)


async def run_load(
    *,
    concurrency: int = 50,
    org_ids: list[str] | None = None,
    duration_seconds: float | None = None,
    simulate: bool = False,
) -> None:
    """Repeatedly launch batches of `concurrency` instrument_graph_query
    blocks, round-robining the three query shapes across the batch so all
    three query_shape label values are visible every batch, spread across
    org_ids so multi-tenant tagging is visible. Runs until duration_seconds
    elapses, or forever (until Ctrl-C) if duration_seconds is None.

    The `neo4j` Python driver is synchronous and its sessions are not
    thread-safe (the Driver object itself IS thread-safe). To get genuine
    concurrency, a ThreadPoolExecutor(max_workers=concurrency) dispatches each
    blocking query via loop.run_in_executor, so all `concurrency` queries are
    truly in flight against Neo4j simultaneously (not capped by the default
    asyncio.to_thread pool of ~32). simulate=True skips the driver/executor
    entirely (Neo4j-less smoke path).
    """
    if org_ids is None:
        org_ids = DEFAULT_SYNTHETIC_ORGS
    if not org_ids:
        raise ValueError("org_ids must be non-empty")

    driver: Driver | None = None
    executor: ThreadPoolExecutor | None = None
    if not simulate:
        driver = neo4j_driver_from_env()
        executor = ThreadPoolExecutor(max_workers=concurrency)

    loop = asyncio.get_running_loop()

    async def one_query(index: int) -> None:
        org_id = org_ids[index % len(org_ids)]
        shape = _SHAPES_ROUND_ROBIN[index % len(_SHAPES_ROUND_ROBIN)]
        async with instrument_graph_query(org_id, shape) as m:
            if simulate or driver is None or executor is None:
                count = await _simulate_one_query()
            else:
                blocking_fn = _SHAPE_TO_BLOCKING_FN[shape]
                count = await loop.run_in_executor(executor, blocking_fn, driver, org_id)
            m.set_result_node_count(count)

    try:
        start = time.monotonic()
        batch_number = 0
        while duration_seconds is None or (time.monotonic() - start) < duration_seconds:
            batch_number += 1
            await asyncio.gather(
                *(one_query(i) for i in range(concurrency)), return_exceptions=True
            )
            print(
                f"[synthetic_graph_load] batch {batch_number}: "
                f"{concurrency} queries across {len(org_ids)} org_id(s) and "
                f"{len(_SHAPES_ROUND_ROBIN)} query shape(s)",
                flush=True,
            )
    finally:
        if executor is not None:
            executor.shutdown(wait=True)
        if driver is not None:
            driver.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drive synthetic graph-shaped concurrent Cypher load through "
        "instrument_graph_query() against local Neo4j for the Prometheus e2e demo (W0-08)."
    )
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument("--orgs", nargs="+", default=DEFAULT_SYNTHETIC_ORGS)
    parser.add_argument(
        "--duration-seconds",
        type=float,
        default=None,
        help="Run for this many seconds, then exit. Default: run until Ctrl-C.",
    )
    parser.add_argument(
        "--print-queries",
        action="store_true",
        help="Print the example migration-trigger PromQL and exit without touching any DB.",
    )
    parser.add_argument(
        "--keep-data",
        action="store_true",
        help="Skip seed-data cleanup on exit, for manual Prometheus/Neo4j inspection.",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="Route through the wrapper with an in-process sleep instead of real Cypher "
        "(a Neo4j-less smoke test). Never seeds or cleans up data. Default is real Neo4j.",
    )
    args = parser.parse_args()

    if args.print_queries:
        print(EXAMPLE_PROMQL)
        return

    init_metrics()  # exporter=prometheus (default) -> serves /metrics on METRICS_PORT (default 9464)

    driver: Driver | None = None
    try:
        if not args.simulate:
            driver = neo4j_driver_from_env()
            for org_id in args.orgs:
                seed_org_data(driver, org_id)
            print(
                f"[synthetic_graph_load] seeded synthetic data for {len(args.orgs)} org_id(s).",
                flush=True,
            )

        print(EXAMPLE_PROMQL)
        print(
            f"[synthetic_graph_load] serving /metrics; driving {args.concurrency} "
            f"concurrent queries per batch across {args.orgs}"
            f"{' (simulated, no Neo4j)' if args.simulate else ' (real Neo4j)'}. Ctrl-C to stop.",
            flush=True,
        )

        asyncio.run(
            run_load(
                concurrency=args.concurrency,
                org_ids=args.orgs,
                duration_seconds=args.duration_seconds,
                simulate=args.simulate,
            )
        )
    except KeyboardInterrupt:
        print("\n[synthetic_graph_load] stopping.", flush=True)
    finally:
        if driver is not None:
            if not args.keep_data:
                for org_id in args.orgs:
                    cleanup_org_data(driver, org_id)
                print(
                    f"[synthetic_graph_load] cleaned up synthetic data for "
                    f"{len(args.orgs)} org_id(s).",
                    flush=True,
                )
            driver.close()
        shutdown_metrics()


if __name__ == "__main__":
    main()

"""Synthetic pgvector query load generator (W0-06).

Long-running CLI that keeps `/metrics` alive and drives concurrent synthetic
queries (default 50) spread across several `org_id`s, each routed through
`instrument_vector_query()` -- the same wrapper a real Retrieval Service call
site will use. It exists purely to prove the harness end-to-end against a
locally-run Prometheus (`docker compose up prometheus`) before any real
pgvector call site exists (see `.pipeline/W0-06/spec.md` Scope/Out).

Usage:
    poetry run python scripts/synthetic_vector_load.py
    poetry run python scripts/synthetic_vector_load.py --concurrency 50 --orgs org-a org-b org-c
    poetry run python scripts/synthetic_vector_load.py --duration-seconds 60
    poetry run python scripts/synthetic_vector_load.py --print-queries   # show example PromQL and exit

Trigger sufficiency (pgvector -> OpenSearch, docs/migration-triggers.md):
  p95/p99 latency:
    histogram_quantile(0.95, sum by (le) (rate(vector_query_duration_ms_bucket[5m])))
    histogram_quantile(0.99, sum by (le) (rate(vector_query_duration_ms_bucket[5m])))
  sustained queries/sec:
    sum(rate(vector_query_duration_ms_count[5m]))
  concurrent multi-tenant load (grouped by org_id):
    sum by (org_id) (vector_query_concurrent_count)
  All three facets of the migration trigger are covered by the two
  instruments emitted here; explicit-bucket histogram boundaries
  (`otel.VECTOR_QUERY_DURATION_BUCKETS_MS`) are what make the
  histogram_quantile() calls above meaningful -- default OTel buckets are
  too coarse in the sub-100ms band this trigger cares about.
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
import time

sys.path.insert(0, ".")  # allow running as `python scripts/synthetic_vector_load.py`

from sayre_workers.telemetry.otel import init_metrics, shutdown_metrics  # noqa: E402
from sayre_workers.telemetry.vector_metrics import instrument_vector_query  # noqa: E402

EXAMPLE_PROMQL = """\
# --- pgvector -> OpenSearch migration-trigger PromQL (docs/migration-triggers.md) ---
# p95 latency:
histogram_quantile(0.95, sum by (le) (rate(vector_query_duration_ms_bucket[5m])))
# p99 latency:
histogram_quantile(0.99, sum by (le) (rate(vector_query_duration_ms_bucket[5m])))
# sustained queries/sec:
sum(rate(vector_query_duration_ms_count[5m]))
# concurrent multi-tenant load, grouped by org_id:
sum by (org_id) (vector_query_concurrent_count)
"""


async def _simulate_one_query(min_latency_ms: float, max_latency_ms: float) -> None:
    latency_s = random.uniform(min_latency_ms, max_latency_ms) / 1000.0
    await asyncio.sleep(latency_s)


async def _real_db_query() -> None:  # pragma: no cover -- requires a seeded table (later ticket)
    """Placeholder for a real pgvector round-trip. No embedding schema /
    seeded vector table exists yet (see spec.md Open Questions), so
    `--use-db` is accepted but not wired to a live connection here."""
    raise NotImplementedError(
        "--use-db requires a seeded pgvector table, which does not exist yet "
        "(see .pipeline/W0-06/spec.md Open Questions: Synthetic-query fidelity). "
        "Run without --use-db for the in-process synthetic-latency simulation."
    )


async def run_load(
    *,
    concurrency: int = 50,
    org_ids: list[str] | None = None,
    duration_seconds: float | None = None,
    min_latency_ms: float = 20.0,
    max_latency_ms: float = 200.0,
    use_db: bool = False,
) -> None:
    """Repeatedly launch batches of `concurrency` instrument_vector_query
    blocks, each awaiting a random latency in [min_latency_ms, max_latency_ms]
    (or a real DB query if use_db=True), spread across org_ids so
    multi-tenant tagging is visible. Runs until duration_seconds elapses, or
    forever (until Ctrl-C) if duration_seconds is None.
    """
    if org_ids is None:
        org_ids = ["org-a", "org-b", "org-c"]
    if not org_ids:
        raise ValueError("org_ids must be non-empty")

    async def one_query(index: int) -> None:
        org_id = org_ids[index % len(org_ids)]
        async with instrument_vector_query(org_id):
            if use_db:
                await _real_db_query()
            else:
                await _simulate_one_query(min_latency_ms, max_latency_ms)

    start = time.monotonic()
    batch_number = 0
    while duration_seconds is None or (time.monotonic() - start) < duration_seconds:
        batch_number += 1
        await asyncio.gather(
            *(one_query(i) for i in range(concurrency)), return_exceptions=True
        )
        print(
            f"[synthetic_vector_load] batch {batch_number}: "
            f"{concurrency} queries across {len(org_ids)} org_id(s)",
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drive synthetic pgvector-shaped concurrent load through "
        "instrument_vector_query() for the Prometheus e2e demo (W0-06)."
    )
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument("--orgs", nargs="+", default=["org-a", "org-b", "org-c"])
    parser.add_argument(
        "--duration-seconds",
        type=float,
        default=None,
        help="Run for this many seconds, then exit. Default: run until Ctrl-C.",
    )
    parser.add_argument("--min-latency-ms", type=float, default=20.0)
    parser.add_argument("--max-latency-ms", type=float, default=200.0)
    parser.add_argument(
        "--use-db",
        action="store_true",
        help="Round-trip a real pgvector query instead of simulating latency "
        "in-process (requires a seeded table that does not exist yet).",
    )
    parser.add_argument(
        "--print-queries",
        action="store_true",
        help="Print the example migration-trigger PromQL and exit without running any load.",
    )
    args = parser.parse_args()

    if args.print_queries:
        print(EXAMPLE_PROMQL)
        return

    init_metrics()  # exporter=prometheus (default) -> serves /metrics on METRICS_PORT (default 9464)
    print(EXAMPLE_PROMQL)
    print(
        f"[synthetic_vector_load] serving /metrics; driving {args.concurrency} "
        f"concurrent queries per batch across {args.orgs}. Ctrl-C to stop.",
        flush=True,
    )

    try:
        asyncio.run(
            run_load(
                concurrency=args.concurrency,
                org_ids=args.orgs,
                duration_seconds=args.duration_seconds,
                min_latency_ms=args.min_latency_ms,
                max_latency_ms=args.max_latency_ms,
                use_db=args.use_db,
            )
        )
    except KeyboardInterrupt:
        print("\n[synthetic_vector_load] stopping.", flush=True)
    finally:
        shutdown_metrics()


if __name__ == "__main__":
    main()

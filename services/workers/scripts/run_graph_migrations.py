"""CLI entrypoint for the Neo4j graph-schema migration runner (W0-02).

Mirrors `scripts/synthetic_vector_load.py`'s structure: `sys.path.insert(0, ".")` so
this runs as `poetry run python scripts/run_graph_migrations.py` from
`services/workers/`, then imports the `sayre_workers` package.

Usage:
    poetry run python scripts/run_graph_migrations.py            # apply pending, target=neo4j
    poetry run python scripts/run_graph_migrations.py --status   # print applied vs pending, apply nothing
    poetry run python scripts/run_graph_migrations.py --dry-run  # print plan, touch nothing
    poetry run python scripts/run_graph_migrations.py --target neptune   # skip 003

Opens the Neo4j driver + a psycopg connection from env (fails fast on missing
`NEO4J_PASSWORD`/`DATABASE_URL` -- see `neo4j_driver_from_env`/`pg_connection_from_env`
in `sayre_workers/graph_migrations/runner.py`), calls `run_migrations`, prints a
per-file applied/skipped summary, and closes both. Exits non-zero on failure.
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, ".")  # allow running as `python scripts/run_graph_migrations.py`

from sayre_workers.graph_migrations.runner import (  # noqa: E402
    DEFAULT_MIGRATIONS_DIR,
    applied_versions,
    discover_migrations,
    ensure_tracking_table,
    neo4j_driver_from_env,
    pg_connection_from_env,
    run_migrations,
)


def _print_summary(results) -> None:
    for result in results:
        status = "skipped" if result.skipped else "applied"
        print(
            f"  [{status}] version={result.version:03d} file={result.filename} "
            f"statements_run={result.statements_run}",
            flush=True,
        )


def _run_status() -> int:
    """`--status`: report applied vs. pending against the current DB, mutate nothing."""
    pg_conn = pg_connection_from_env()
    try:
        ensure_tracking_table(pg_conn)
        recorded = applied_versions(pg_conn)
        migrations = discover_migrations(DEFAULT_MIGRATIONS_DIR)
        print("Graph migration status:", flush=True)
        for migration in migrations:
            if migration.version not in recorded:
                print(
                    f"  [pending] version={migration.version:03d} file={migration.filename}",
                    flush=True,
                )
            elif recorded[migration.version] != migration.checksum:
                print(
                    f"  [MISMATCH] version={migration.version:03d} file={migration.filename} "
                    "-- on-disk checksum differs from recorded checksum",
                    flush=True,
                )
            else:
                print(
                    f"  [applied] version={migration.version:03d} file={migration.filename}",
                    flush=True,
                )
        return 0
    finally:
        pg_conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply the versioned openCypher graph-schema migrations "
        "(services/workers/graph-migrations/) to Neo4j, tracked in Postgres."
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Print applied vs. pending migrations against the current DB. Applies nothing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the apply plan without running any Cypher or recording any tracking rows.",
    )
    parser.add_argument(
        "--target",
        choices=["neo4j", "neptune"],
        default="neo4j",
        help="'neptune' skips Neo4j-only DDL files (currently just 003).",
    )
    args = parser.parse_args()

    if args.status:
        return _run_status()

    pg_conn = pg_connection_from_env()
    neo4j_driver = neo4j_driver_from_env()
    try:
        results = run_migrations(
            neo4j_driver,
            pg_conn,
            dry_run=args.dry_run,
            target=args.target,
        )
        mode = "[dry-run] " if args.dry_run else ""
        print(f"{mode}Graph migration run (target={args.target}):", flush=True)
        _print_summary(results)
        return 0
    except Exception as exc:  # surfaced as a clear non-zero exit, not a stack-trace-only crash
        print(f"Graph migration run FAILED: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        neo4j_driver.close()
        pg_conn.close()


if __name__ == "__main__":
    raise SystemExit(main())

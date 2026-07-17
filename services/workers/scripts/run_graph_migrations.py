"""CLI entrypoint for layered, target-aware graph-schema migrations (W0-02).

Mirrors `scripts/synthetic_vector_load.py`'s structure: `sys.path.insert(0, ".")` so
this runs as `poetry run python scripts/run_graph_migrations.py` from
`services/workers/`, then imports the `sayre_workers` package.

Usage:
    poetry run python scripts/run_graph_migrations.py            # apply pending, target=neo4j
    poetry run python scripts/run_graph_migrations.py --status   # print applied vs pending, apply nothing
    poetry run python scripts/run_graph_migrations.py --dry-run  # print plan, touch nothing
    poetry run python scripts/run_graph_migrations.py --target neptune   # logical plan only

Opens the Neo4j driver + a psycopg connection from env (fails fast on missing
`NEO4J_PASSWORD`/`DATABASE_ADMIN_URL` -- see `neo4j_driver_from_env`/`pg_connection_from_env`
in `sayre_workers/graph_migrations/runner.py`), calls `run_migrations`, prints a
per-file applied/skipped summary, and closes both. Exits non-zero on failure.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

sys.path.insert(0, ".")  # allow running as `python scripts/run_graph_migrations.py`

from sayre_workers.graph_migrations.runner import (  # noqa: E402
    DEFAULT_MIGRATIONS_DIR,
    NEO4J_STARTUP_ERROR,
    POSTGRES_STARTUP_ERROR,
    applied_versions,
    discover_migrations,
    ensure_tracking_table,
    neo4j_driver_from_env,
    pg_connection_from_env,
    run_migrations,
)


def _report_startup_failure(message: str) -> None:
    """Emit only a fixed, credential-free startup message."""
    print(f"Graph migration startup FAILED: {message}", file=sys.stderr, flush=True)


OPERATION_ERROR = "The graph-migration operation could not be completed."


def _report_operation_failure() -> None:
    print(f"Graph migration operation FAILED: {OPERATION_ERROR}", file=sys.stderr, flush=True)


TEARDOWN_ERROR = "One or more graph-migration resources could not be closed."


class GraphMigrationTeardownError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(TEARDOWN_ERROR)


def _close_resources(*resources) -> None:
    """Attempt every close and expose at most one fixed, credential-free error."""
    failed = False
    for resource in resources:
        try:
            resource.close()
        except Exception:
            failed = True
    if failed:
        raise GraphMigrationTeardownError from None


def _report_teardown_failure() -> None:
    print(f"Graph migration teardown FAILED: {TEARDOWN_ERROR}", file=sys.stderr, flush=True)


def _print_summary(results) -> None:
    for result in results:
        status = "skipped" if result.skipped else "applied"
        print(
            f"  [{status}] target={result.graph_target} layer={result.layer} "
            f"version={result.version:03d} file={result.filename} "
            f"statements_run={result.statements_run}",
            flush=True,
        )


async def _run_status(target: str) -> int:
    """Report only the selected target's logical + physical plan."""
    try:
        pg_conn = await pg_connection_from_env()
    except Exception:
        _report_startup_failure(POSTGRES_STARTUP_ERROR)
        return 1
    operation_failed = False
    try:
        ensure_tracking_table(pg_conn)
        recorded = applied_versions(pg_conn, target=target)
        migrations = discover_migrations(DEFAULT_MIGRATIONS_DIR, target=target)
        print(f"Graph migration status (target={target}):", flush=True)
        for migration in migrations:
            existing = recorded.get(migration.key)
            prefix = (
                f"target={migration.graph_target} layer={migration.layer} "
                f"version={migration.version:03d} file={migration.filename}"
            )
            if existing is None:
                print(
                    f"  [pending] {prefix}",
                    flush=True,
                )
            elif existing.filename != migration.filename or existing.checksum != migration.checksum:
                print(
                    f"  [MISMATCH] {prefix} "
                    "-- on-disk checksum differs from recorded checksum",
                    flush=True,
                )
            else:
                print(
                    f"  [applied] {prefix}",
                    flush=True,
                )
    except Exception:
        operation_failed = True

    teardown_failed = False
    try:
        _close_resources(pg_conn)
    except GraphMigrationTeardownError:
        teardown_failed = True
    if operation_failed:
        _report_operation_failure()
    if teardown_failed:
        _report_teardown_failure()
    return 1 if operation_failed or teardown_failed else 0


async def main() -> int:
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
        help="Select logical migrations plus only this target's physical layer.",
    )
    args = parser.parse_args()

    if args.status:
        return await _run_status(args.target)

    try:
        pg_conn = await pg_connection_from_env()
    except Exception:
        _report_startup_failure(POSTGRES_STARTUP_ERROR)
        return 1
    try:
        neo4j_driver = await neo4j_driver_from_env()
    except Exception:
        try:
            pg_conn.close()
        except Exception:
            pass
        _report_startup_failure(NEO4J_STARTUP_ERROR)
        return 1
    result_code = 0
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
    except Exception:
        _report_operation_failure()
        result_code = 1

    try:
        _close_resources(neo4j_driver, pg_conn)
    except GraphMigrationTeardownError:
        _report_teardown_failure()
        return 1
    return result_code


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

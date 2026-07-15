"""Discovery/apply/tracking core for the Neo4j graph-schema migration runner (W0-02).

Located in the Python worker fleet (not `services/core`) because the fleet owns all
graph writes (`CLAUDE.md` Structure — the Ingestion Worker writes Neo4j) and the
`.cypher` files live under `services/workers/graph-migrations/`. Uses the `neo4j`
Python driver (new dep, pinned in `pyproject.toml`) for Neo4j and `psycopg` (existing
dep) for the Postgres version-tracking table.

Idempotency contract (`.pipeline/spec.md` W0-02 "Apply algorithm"):
  1. `ensure_tracking_table` — idempotent `CREATE TABLE IF NOT EXISTS`.
  2. `discover_migrations` sorted ascending by numeric version (not lexical filename
     order — `010` must sort after `009`/`002`; a missing intermediate version must
     not crash discovery).
  3. Per migration, compare its on-disk checksum against the recorded checksum:
       - already applied, checksum matches -> skip; Neo4j is never touched.
       - already applied, checksum differs -> raise (the file was mutated after being
         applied — a hard error, never a silent re-apply).
       - not applied -> run each statement in its own transaction/auto-commit (Neo4j
         forbids mixing schema DDL and data in one transaction, and every statement is
         individually idempotent via MERGE / `IF NOT EXISTS`), then record the file as
         applied ONLY after every statement in it succeeds. A partial failure leaves
         the tracking row unwritten, so a clean re-run safely re-executes the whole
         (idempotent) file with no duplicates.
  4. `target == "neptune"` skips any file whose version is in
     `NEPTUNE_INCOMPATIBLE_VERSIONS` (003 — constraint/index DDL, which Neptune's
     openCypher implementation does not support) entirely: no Cypher is sent to
     Neptune, and (per the ticket's `--target neptune` acceptance criterion) no
     tracking row is recorded for a skipped-by-target file either, so re-running
     against a real Neo4j target later still applies it.
  5. `dry_run=True` reports the plan (which files would apply vs. skip) without
     running any Cypher against Neo4j or inserting any tracking rows into Postgres.
     `ensure_tracking_table` still runs either way — it is itself idempotent,
     side-effect-free bookkeeping infra (no migration data is read or written), and is
     required so `applied_versions` has something to query in a `--dry-run`/`--status`
     call against a completely fresh database.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - type-checking only
    from neo4j import Driver
    from psycopg import Connection

logger = logging.getLogger(__name__)

DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "graph-migrations"
NEPTUNE_INCOMPATIBLE_VERSIONS = frozenset({3})  # 003 = constraint/index DDL

_VERSION_PREFIX_RE = re.compile(r"^(\d+)_")


@dataclass(frozen=True)
class MigrationFile:
    version: int  # parsed from filename prefix, e.g. 1, 2, 3
    filename: str  # "001_init_node_labels.cypher"
    path: Path
    checksum: str  # sha256 hex of file bytes
    statements: list[str]  # split on ';' at statement boundaries, comments/blank stripped


@dataclass(frozen=True)
class AppliedMigration:
    version: int
    filename: str
    checksum: str
    statements_run: int
    skipped: bool  # True if already applied (checksum matched), dry-run, or target-skipped


def split_statements(cypher_text: str) -> list[str]:
    """Strip `//` line comments, split on `;` statement boundaries, and drop any
    resulting blank/whitespace-only statements. No `.cypher` file in this migration
    set uses a string literal containing `//` or `;`, so a naive per-line comment
    strip + split is sufficient (no Cypher string-literal-aware parser needed)."""
    stripped_lines = []
    for line in cypher_text.splitlines():
        comment_index = line.find("//")
        if comment_index != -1:
            line = line[:comment_index]
        stripped_lines.append(line)

    joined = "\n".join(stripped_lines)
    return [statement.strip() for statement in joined.split(";") if statement.strip()]


def discover_migrations(migrations_dir: Path = DEFAULT_MIGRATIONS_DIR) -> list[MigrationFile]:
    """Discover `*.cypher` files, parse their numeric version prefix, checksum their
    raw bytes, and split their statements. Returned list is sorted ascending by the
    parsed integer version (not lexical filename order), so `010` sorts after
    `009`/`002` and gaps between versions never crash discovery. Files whose name
    does not start with `<digits>_` are ignored (not a migration file)."""
    migrations: list[MigrationFile] = []
    for path in migrations_dir.glob("*.cypher"):
        match = _VERSION_PREFIX_RE.match(path.name)
        if not match:
            logger.warning(
                "Skipping %s in %s -- filename does not start with a numeric version "
                "prefix (e.g. '001_...').",
                path.name,
                migrations_dir,
            )
            continue

        version = int(match.group(1))
        raw_bytes = path.read_bytes()
        checksum = hashlib.sha256(raw_bytes).hexdigest()
        statements = split_statements(raw_bytes.decode("utf-8"))
        migrations.append(
            MigrationFile(
                version=version,
                filename=path.name,
                path=path,
                checksum=checksum,
                statements=statements,
            )
        )

    migrations.sort(key=lambda m: m.version)
    return migrations


def ensure_tracking_table(pg_conn: "Connection") -> None:
    """Idempotent `CREATE TABLE IF NOT EXISTS` for the `graph_migrations` version
    tracker. No `org_id`, no RLS -- this is global infra bookkeeping (graph schema
    versions are cross-tenant, analogous to Drizzle's own `__drizzle_migrations`
    table), deliberately NOT a tenant-scoped domain table (see
    `.pipeline/spec.md` W0-02 Open Question 4 / Interfaces section 7)."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS graph_migrations (
              version    integer PRIMARY KEY,
              filename   text NOT NULL,
              checksum   text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    pg_conn.commit()


def applied_versions(pg_conn: "Connection") -> dict[int, str]:
    """Return `{version: checksum}` for every migration already recorded as applied."""
    with pg_conn.cursor() as cur:
        cur.execute("SELECT version, checksum FROM graph_migrations")
        rows = cur.fetchall()
    return {version: checksum for version, checksum in rows}


def record_applied(pg_conn: "Connection", migration: MigrationFile) -> None:
    """Record `migration` as applied. `ON CONFLICT DO NOTHING` guards a concurrent
    duplicate insert (the caller only ever invokes this after confirming the version
    is not yet applied, but this keeps the statement itself safely idempotent too)."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_migrations (version, filename, checksum)
            VALUES (%s, %s, %s)
            ON CONFLICT (version) DO NOTHING
            """,
            (migration.version, migration.filename, migration.checksum),
        )
    pg_conn.commit()


class MigrationChecksumMismatchError(RuntimeError):
    """Raised when a migration file's on-disk bytes no longer match the checksum
    recorded for it at apply time -- i.e. the file was edited after being applied.
    Never silently re-applied; add a new migration file instead."""


def run_migrations(
    neo4j_driver: "Driver",
    pg_conn: "Connection",
    migrations_dir: Path = DEFAULT_MIGRATIONS_DIR,
    *,
    dry_run: bool = False,
    target: str = "neo4j",  # "neo4j" | "neptune"; "neptune" skips NEPTUNE_INCOMPATIBLE_VERSIONS
) -> list[AppliedMigration]:
    if target not in ("neo4j", "neptune"):
        raise ValueError(f"run_migrations: target must be 'neo4j' or 'neptune', got {target!r}")

    ensure_tracking_table(pg_conn)
    migrations = discover_migrations(migrations_dir)
    recorded = applied_versions(pg_conn)

    results: list[AppliedMigration] = []
    for migration in migrations:
        if target == "neptune" and migration.version in NEPTUNE_INCOMPATIBLE_VERSIONS:
            logger.info(
                "Skipping %s (version %d) -- Neo4j-only DDL, not sent to Neptune target.",
                migration.filename,
                migration.version,
            )
            results.append(
                AppliedMigration(
                    version=migration.version,
                    filename=migration.filename,
                    checksum=migration.checksum,
                    statements_run=0,
                    skipped=True,
                )
            )
            continue

        recorded_checksum = recorded.get(migration.version)
        if recorded_checksum is not None:
            if recorded_checksum == migration.checksum:
                logger.info(
                    "Skipping %s (version %d) -- already applied, checksum matches.",
                    migration.filename,
                    migration.version,
                )
                results.append(
                    AppliedMigration(
                        version=migration.version,
                        filename=migration.filename,
                        checksum=migration.checksum,
                        statements_run=0,
                        skipped=True,
                    )
                )
                continue

            raise MigrationChecksumMismatchError(
                f"{migration.filename} (version {migration.version}) was already applied "
                f"with checksum {recorded_checksum!r}, but the file on disk now has "
                f"checksum {migration.checksum!r}. Migration files must never be edited "
                "after being applied -- add a new migration file instead."
            )

        if dry_run:
            logger.info(
                "[dry-run] Would apply %s (version %d, %d statement(s)).",
                migration.filename,
                migration.version,
                len(migration.statements),
            )
            results.append(
                AppliedMigration(
                    version=migration.version,
                    filename=migration.filename,
                    checksum=migration.checksum,
                    statements_run=0,
                    skipped=True,
                )
            )
            continue

        statements_run = 0
        with neo4j_driver.session() as session:
            for statement in migration.statements:
                # Each session.run() call is its own auto-commit transaction --
                # required because Neo4j forbids mixing schema DDL and data writes in
                # a single transaction, and satisfied here for free since every
                # statement in these files is independently idempotent
                # (MERGE / `IF NOT EXISTS`).
                session.run(statement)
                statements_run += 1

        record_applied(pg_conn, migration)
        logger.info(
            "Applied %s (version %d, %d statement(s)).",
            migration.filename,
            migration.version,
            statements_run,
        )
        results.append(
            AppliedMigration(
                version=migration.version,
                filename=migration.filename,
                checksum=migration.checksum,
                statements_run=statements_run,
                skipped=False,
            )
        )

    return results


def neo4j_driver_from_env() -> "Driver":
    """Build a Neo4j `Driver` from `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` (mirrors
    the `os.environ` pattern in `messaging/sqs_client.py`). Fails fast with a clear
    error when `NEO4J_PASSWORD` is missing, rather than letting the driver attempt a
    connection with an empty/`None` credential and hang or fail opaquely later
    (mirrors `createPool`'s fail-fast in `services/core/src/db/client.ts`)."""
    import neo4j

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD")
    if not password:
        raise RuntimeError(
            "neo4j_driver_from_env: NEO4J_PASSWORD is not set. Provide it via "
            "infra/.env (see infra/.env.example) or the environment."
        )
    return neo4j.GraphDatabase.driver(uri, auth=(user, password))


def pg_connection_from_env() -> "Connection":
    """Build a `psycopg` connection from `DATABASE_URL` (used repo-wide). Fails fast
    with a clear error when `DATABASE_URL` is missing, mirroring `createPool`'s
    fail-fast in `services/core/src/db/client.ts`."""
    import psycopg

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "pg_connection_from_env: DATABASE_URL is not set. Provide it via "
            "infra/.env (see infra/.env.example) or the environment."
        )
    return psycopg.connect(url)

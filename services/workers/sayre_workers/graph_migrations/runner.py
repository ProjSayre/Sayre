"""Layered, target-aware graph migration discovery, tracking, and replay."""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from sayre_workers.config import get_config, get_secret

if TYPE_CHECKING:  # pragma: no cover
    from neo4j import Driver
    from psycopg import Connection

logger = logging.getLogger(__name__)

GraphTarget = Literal["neo4j", "neptune"]
MigrationLayer = Literal["logical", "physical"]
GRAPH_TARGETS: tuple[GraphTarget, ...] = ("neo4j", "neptune")
MIGRATION_LAYERS: tuple[MigrationLayer, ...] = ("logical", "physical")

DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "graph-migrations"
_VERSION_PREFIX_RE = re.compile(r"^(\d+)_")

CANONICAL_LEGACY_HASHES = {
    1: "9e97a85061e6b53cea69a56897577027eb512b3d76c469dbd1e113d5671e4e93",
    2: "a42b56062404c92094e6fc42c2bf4c240836723792b18bfdadb96108b3855603",
    3: "543a4098e546a1ee559fe3b7991c98f488593a10ce63fe9e7906ff3cb63650ef",
}
DOCUMENTED_CRLF_LEGACY_HASHES = {
    1: "756cd8b9bc71cc16d809e9bd94b38b34398c464a985b635f446a9699a29431dc",
    2: "5123966cf9a56b157025106123f8843d8a0ae80ae910cfc4ceeb902db7c27bc5",
    3: "f8e858103abc8fbe4f1705f2c9caec0c7a6e87212f71ee97c9d8a5bbf711e3bf",
}
_LEGACY_FILENAMES = {
    1: "001_init_node_labels.cypher",
    2: "002_init_edge_types.cypher",
    3: "003_constraints_and_indexes.cypher",
}

MIGRATION_CHECKSUM_MISMATCH_ERROR = "Recorded graph migration checksum does not match."
MIGRATION_HISTORY_CONFLICT_ERROR = "Recorded graph migration identity does not match."
LEGACY_HISTORY_ERROR = "Legacy graph migration history is not recognized."
HISTORY_SCHEMA_ERROR = "Graph migration history schema is not recognized."

_CREATE_TRACKING_TABLE_SQL = """
CREATE TABLE graph_migrations (
  graph_target text NOT NULL CHECK (graph_target IN ('neo4j', 'neptune')),
  layer       text NOT NULL CHECK (layer IN ('logical', 'physical')),
  version     integer NOT NULL,
  filename    text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (graph_target, layer, version)
)
"""


@dataclass(frozen=True, slots=True)
class MigrationKey:
    graph_target: GraphTarget
    layer: MigrationLayer
    version: int


@dataclass(frozen=True, slots=True)
class MigrationFile:
    graph_target: GraphTarget
    layer: MigrationLayer
    version: int
    filename: str
    path: Path
    checksum: str
    statements: list[str]

    @property
    def key(self) -> MigrationKey:
        return MigrationKey(self.graph_target, self.layer, self.version)


@dataclass(frozen=True, slots=True)
class MigrationHistory:
    graph_target: GraphTarget
    layer: MigrationLayer
    version: int
    filename: str
    checksum: str

    @property
    def key(self) -> MigrationKey:
        return MigrationKey(self.graph_target, self.layer, self.version)


@dataclass(frozen=True, slots=True)
class AppliedMigration:
    graph_target: GraphTarget
    layer: MigrationLayer
    version: int
    filename: str
    checksum: str
    statements_run: int
    skipped: bool


class MigrationChecksumMismatchError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(MIGRATION_CHECKSUM_MISMATCH_ERROR)


class MigrationHistoryConflictError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(MIGRATION_HISTORY_CONFLICT_ERROR)


class LegacyMigrationHistoryError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(LEGACY_HISTORY_ERROR)


class MigrationHistorySchemaError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(HISTORY_SCHEMA_ERROR)


def _validate_target(target: str) -> GraphTarget:
    if target not in GRAPH_TARGETS:
        raise ValueError("graph target must be 'neo4j' or 'neptune'")
    return target  # type: ignore[return-value]


def canonical_migration_bytes(raw_bytes: bytes) -> bytes:
    """Canonicalize checkout line endings so migration history is OS-independent."""
    return raw_bytes.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def migration_checksum(raw_bytes: bytes) -> str:
    return hashlib.sha256(canonical_migration_bytes(raw_bytes)).hexdigest()


def split_statements(cypher_text: str) -> list[str]:
    stripped_lines = []
    for line in cypher_text.splitlines():
        comment_index = line.find("//")
        if comment_index != -1:
            line = line[:comment_index]
        stripped_lines.append(line)
    joined = "\n".join(stripped_lines)
    return [statement.strip() for statement in joined.split(";") if statement.strip()]


def _discover_layer(
    directory: Path,
    *,
    target: GraphTarget,
    layer: MigrationLayer,
) -> list[MigrationFile]:
    migrations: list[MigrationFile] = []
    versions: set[int] = set()
    if not directory.exists():
        return migrations
    for path in directory.glob("*.cypher"):
        match = _VERSION_PREFIX_RE.match(path.name)
        if not match:
            logger.warning("Skipping non-versioned graph migration file in %s.", directory)
            continue
        version = int(match.group(1))
        if version in versions:
            raise MigrationHistoryConflictError
        versions.add(version)
        raw_bytes = path.read_bytes()
        canonical_bytes = canonical_migration_bytes(raw_bytes)
        migrations.append(
            MigrationFile(
                graph_target=target,
                layer=layer,
                version=version,
                filename=path.name,
                path=path,
                checksum=hashlib.sha256(canonical_bytes).hexdigest(),
                statements=split_statements(canonical_bytes.decode("utf-8")),
            )
        )
    migrations.sort(key=lambda migration: migration.version)
    return migrations


def discover_migrations(
    migrations_dir: Path = DEFAULT_MIGRATIONS_DIR,
    *,
    target: str = "neo4j",
) -> list[MigrationFile]:
    """Return logical migrations, then only the selected target's physical layer."""
    checked_target = _validate_target(target)
    logical = _discover_layer(
        migrations_dir / "logical", target=checked_target, layer="logical"
    )
    physical = _discover_layer(
        migrations_dir / "physical" / checked_target,
        target=checked_target,
        layer="physical",
    )
    return [*logical, *physical]


def _table_columns(cursor) -> set[str]:
    cursor.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'graph_migrations'
        """
    )
    return {row[0] for row in cursor.fetchall()}


def _primary_key_columns(cursor) -> list[str]:
    cursor.execute(
        """
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'graph_migrations'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
        """
    )
    return [row[0] for row in cursor.fetchall()]


def _legacy_row_mapping(
    version: int, filename: str, checksum: str
) -> tuple[GraphTarget, MigrationLayer, int]:
    expected_filename = _LEGACY_FILENAMES.get(version)
    known_hashes = {
        CANONICAL_LEGACY_HASHES.get(version),
        DOCUMENTED_CRLF_LEGACY_HASHES.get(version),
    }
    if expected_filename != Path(filename).name or checksum not in known_hashes:
        raise LegacyMigrationHistoryError
    layer: MigrationLayer = "physical" if version == 3 else "logical"
    return "neo4j", layer, version


def ensure_tracking_table(pg_conn: "Connection") -> None:
    """Create composite history or transactionally upgrade exact legacy history."""
    try:
        with pg_conn.cursor() as cursor:
            cursor.execute("SELECT to_regclass('public.graph_migrations')")
            row = cursor.fetchone()
            exists = row is not None and row[0] is not None
            if not exists:
                cursor.execute(_CREATE_TRACKING_TABLE_SQL)
                pg_conn.commit()
                return

            columns = _table_columns(cursor)
            primary_key = _primary_key_columns(cursor)
            modern_columns = {
                "graph_target",
                "layer",
                "version",
                "filename",
                "checksum",
                "applied_at",
            }
            if columns == modern_columns:
                if primary_key != ["graph_target", "layer", "version"]:
                    raise MigrationHistorySchemaError
                pg_conn.commit()
                return

            legacy_columns = {"version", "filename", "checksum", "applied_at"}
            if columns != legacy_columns or primary_key != ["version"]:
                raise MigrationHistorySchemaError

            cursor.execute(
                "SELECT version, filename, checksum, applied_at "
                "FROM graph_migrations ORDER BY version"
            )
            legacy_rows = cursor.fetchall()
            mapped_rows = [
                (*_legacy_row_mapping(version, filename, checksum), filename, checksum, applied_at)
                for version, filename, checksum, applied_at in legacy_rows
            ]

            cursor.execute("ALTER TABLE graph_migrations RENAME TO graph_migrations_legacy_w002")
            cursor.execute(_CREATE_TRACKING_TABLE_SQL)
            for graph_target, layer, version, filename, checksum, applied_at in mapped_rows:
                canonical_checksum = CANONICAL_LEGACY_HASHES[version]
                cursor.execute(
                    """
                    INSERT INTO graph_migrations
                      (graph_target, layer, version, filename, checksum, applied_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        graph_target,
                        layer,
                        version,
                        filename,
                        canonical_checksum,
                        applied_at,
                    ),
                )
            cursor.execute("DROP TABLE graph_migrations_legacy_w002")
        pg_conn.commit()
    except Exception:
        pg_conn.rollback()
        raise


def applied_versions(
    pg_conn: "Connection", *, target: str | None = None
) -> dict[MigrationKey, MigrationHistory]:
    params: tuple[str, ...] = ()
    where = ""
    if target is not None:
        checked_target = _validate_target(target)
        where = " WHERE graph_target = %s"
        params = (checked_target,)
    with pg_conn.cursor() as cursor:
        cursor.execute(
            "SELECT graph_target, layer, version, filename, checksum "
            f"FROM graph_migrations{where}",
            params,
        )
        rows = cursor.fetchall()
    histories = [MigrationHistory(*row) for row in rows]
    return {history.key: history for history in histories}


def record_applied(pg_conn: "Connection", migration: MigrationFile) -> None:
    try:
        with pg_conn.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO graph_migrations
                  (graph_target, layer, version, filename, checksum)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (graph_target, layer, version) DO NOTHING
                RETURNING filename, checksum
                """,
                (
                    migration.graph_target,
                    migration.layer,
                    migration.version,
                    migration.filename,
                    migration.checksum,
                ),
            )
            inserted = cursor.fetchone()
            if inserted is None:
                cursor.execute(
                    """
                    SELECT filename, checksum FROM graph_migrations
                    WHERE graph_target = %s AND layer = %s AND version = %s
                    """,
                    (migration.graph_target, migration.layer, migration.version),
                )
                existing = cursor.fetchone()
                if existing is None or existing[0] != migration.filename:
                    raise MigrationHistoryConflictError
                if existing[1] != migration.checksum:
                    raise MigrationChecksumMismatchError
        pg_conn.commit()
    except Exception:
        pg_conn.rollback()
        raise


POSTGRES_STARTUP_ERROR = (
    "Postgres graph-migration startup failed; verify DATABASE_ADMIN_URL configuration."
)
NEO4J_STARTUP_ERROR = (
    "Neo4j graph-migration startup failed; verify NEO4J_URI, NEO4J_USER, and "
    "NEO4J_PASSWORD configuration."
)


class GraphMigrationStartupError(RuntimeError):
    """Fixed-text startup failure that never exposes a resolved credential."""


class PostgresMigrationStartupError(GraphMigrationStartupError):
    def __init__(self) -> None:
        super().__init__(POSTGRES_STARTUP_ERROR)


class Neo4jMigrationStartupError(GraphMigrationStartupError):
    def __init__(self) -> None:
        super().__init__(NEO4J_STARTUP_ERROR)


def run_migrations(
    neo4j_driver: "Driver",
    pg_conn: "Connection",
    migrations_dir: Path = DEFAULT_MIGRATIONS_DIR,
    *,
    dry_run: bool = False,
    target: str = "neo4j",
) -> list[AppliedMigration]:
    checked_target = _validate_target(target)
    ensure_tracking_table(pg_conn)
    migrations = discover_migrations(migrations_dir, target=checked_target)
    recorded = applied_versions(pg_conn, target=checked_target)
    results: list[AppliedMigration] = []

    for migration in migrations:
        existing = recorded.get(migration.key)
        if existing is not None:
            if existing.filename != migration.filename:
                raise MigrationHistoryConflictError
            if existing.checksum != migration.checksum:
                raise MigrationChecksumMismatchError
            results.append(
                AppliedMigration(
                    migration.graph_target,
                    migration.layer,
                    migration.version,
                    migration.filename,
                    migration.checksum,
                    0,
                    True,
                )
            )
            continue

        if dry_run:
            results.append(
                AppliedMigration(
                    migration.graph_target,
                    migration.layer,
                    migration.version,
                    migration.filename,
                    migration.checksum,
                    0,
                    True,
                )
            )
            continue

        statements_run = 0
        with neo4j_driver.session() as session:
            for statement in migration.statements:
                session.run(statement)
                statements_run += 1
        record_applied(pg_conn, migration)
        recorded[migration.key] = MigrationHistory(
            migration.graph_target,
            migration.layer,
            migration.version,
            migration.filename,
            migration.checksum,
        )
        results.append(
            AppliedMigration(
                migration.graph_target,
                migration.layer,
                migration.version,
                migration.filename,
                migration.checksum,
                statements_run,
                False,
            )
        )
    return results


async def neo4j_driver_from_env() -> "Driver":
    import neo4j

    try:
        uri = get_config("NEO4J_URI")
        user = get_config("NEO4J_USER")
        password = await get_secret("env://NEO4J_PASSWORD")
    except Exception:
        raise Neo4jMigrationStartupError from None
    try:
        return neo4j.GraphDatabase.driver(uri, auth=(user, password))
    except Exception:
        raise Neo4jMigrationStartupError from None


async def pg_connection_from_env() -> "Connection":
    import psycopg

    try:
        url = await get_secret("env://DATABASE_ADMIN_URL")
    except Exception:
        raise PostgresMigrationStartupError from None
    try:
        return psycopg.connect(url)
    except Exception:
        raise PostgresMigrationStartupError from None

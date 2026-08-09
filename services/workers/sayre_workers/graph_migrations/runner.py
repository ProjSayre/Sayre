"""Discovery/apply/tracking core for the Neo4j graph-schema migration runner (W0-02).

Located in the Python worker fleet (not `services/core`) because the fleet owns all
graph writes (`CLAUDE.md` Structure — the Ingestion Worker writes Neo4j) and the
`.cypher` files live under `services/workers/graph-migrations/`. Uses the `neo4j`
Python driver (new dep, pinned in `pyproject.toml`) for Neo4j and `psycopg` (existing
dep) for the Postgres version-tracking table.

Idempotency contract (`.pipeline/spec.md` W0-02 "Apply algorithm"):
  1. `ensure_tracking_table` — idempotent `CREATE TABLE IF NOT EXISTS`, plus an
     idempotent in-place reshape (add `target`/`layer` columns, re-key to
     `(target, layer, version)`) for a table that predates the W0-02 audit's
     per-layer/per-target tracking model.
  2. `discover_migrations` sorted ascending by numeric version (not lexical filename
     order — `010` must sort after `009`/`002`; a missing intermediate version must
     not crash discovery). Each file's `// Layer:` / `// Targets:` header directives
     are parsed onto `MigrationFile.layer`/`.targets` — a file missing either header
     is a hard discovery-time error naming the file (EC-11), not a silent default.
  3. Per migration, if the run's `target` is not in the file's declared `targets`, it
     is skipped entirely for this run and not recorded for that target (so a later run
     against a target it *is* declared for still applies it — the W0-02 audit's
     finding C1 fix: history is tracked per `(target, layer, version)`, not by
     `version` alone, so a second target never silently reports "already applied").
  4. Otherwise, compare its on-disk checksum against the checksum recorded for this
     file's `(layer, version)` under this run's `target`:
       - already applied, checksum matches -> skip; Neo4j is never touched.
       - already applied, checksum differs -> raise (the file was mutated after being
         applied — a hard error, never a silent re-apply).
       - not applied -> run each statement in its own transaction/auto-commit (Neo4j
         forbids mixing schema DDL and data in one transaction, and every statement is
         individually idempotent via MERGE / `IF NOT EXISTS`), then record the file as
         applied ONLY after every statement in it succeeds. A partial failure leaves
         the tracking row unwritten, so a clean re-run safely re-executes the whole
         (idempotent) file with no duplicates.
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
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from sayre_workers.config import get_config, get_secret

if TYPE_CHECKING:  # pragma: no cover - type-checking only
    from neo4j import Driver
    from psycopg import Connection

logger = logging.getLogger(__name__)

DEFAULT_MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "graph-migrations"

# Migration-history layers (spec.md Interfaces 2). "logical" data migrations are pure
# MERGE/MATCH and portable across every target; "physical" migrations are target-specific
# DDL (constraints/indexes) that may not be portable (Neptune has no CREATE INDEX DDL).
LOGICAL = "logical"
PHYSICAL = "physical"
_LAYERS = (LOGICAL, PHYSICAL)

# Graph targets the runner knows how to apply against. Per-file compatibility is
# declared by each file's own `// Targets:` header (see `_parse_header`), not by a
# hardcoded version list — the W0-02 audit's finding C2 fix.
TARGETS = ("neo4j", "neptune")

_VERSION_PREFIX_RE = re.compile(r"^(\d+)_")
_LAYER_HEADER_RE = re.compile(r"^//\s*Layer:\s*(.+?)\s*$", re.MULTILINE)
_TARGETS_HEADER_RE = re.compile(r"^//\s*Targets:\s*(.+?)\s*$", re.MULTILINE)
_QUOTED_SPAN_RE = re.compile(r"'[^'\n]*'")


class MigrationHeaderError(ValueError):
    """A `.cypher` migration file is missing (or declares an invalid) required
    `// Layer:` or `// Targets:` header directive (spec.md Interfaces 2 / EC-11).
    Raised at discovery time, naming the offending file, rather than defaulting
    silently -- an undeclared file could otherwise be shipped to a target it was
    never verified against (finding C2/C3)."""


class StatementSplitError(ValueError):
    """Raised instead of silently corrupting a `.cypher` statement whose string
    literal contains `//` or `;` (EC-15 / finding F4). `split_statements` below is a
    naive `//`-strip + `;`-split, not a full Cypher parser (a deliberate, documented
    scope limit -- see spec.md Open Question O-7); this is the fail-loudly guard for
    the one input shape it cannot safely handle, rather than a silent corruption."""


@dataclass(frozen=True)
class MigrationFile:
    version: int  # parsed from filename prefix, e.g. 1, 2, 3
    filename: str  # "001_init_node_labels.cypher"
    path: Path
    checksum: str  # sha256 hex of file bytes
    statements: list[str]  # split on ';' at statement boundaries, comments/blank stripped
    layer: str  # "logical" | "physical", parsed from the file's `// Layer:` header
    targets: frozenset[str]  # targets this file may be applied to, from `// Targets:`


@dataclass(frozen=True)
class AppliedMigration:
    version: int
    filename: str
    checksum: str
    statements_run: int
    skipped: bool  # True if already applied (checksum matched), dry-run, or target-skipped
    layer: str
    target: str


def _line_has_marker_inside_quotes(line: str) -> bool:
    """Heuristic guard for EC-15 / finding F4: True if a `//` or `;` on this line
    falls inside a single-quoted string literal, where the naive comment-strip /
    statement-split below would silently corrupt it. Deliberately not a full Cypher
    string-literal parser (O-7) -- just enough to fail loudly instead of guessing
    wrong when a future migration's literal (e.g. a URL) contains one of these."""
    quoted_spans = [match.span() for match in _QUOTED_SPAN_RE.finditer(line)]
    if not quoted_spans:
        return False
    for marker in ("//", ";"):
        start = 0
        while True:
            index = line.find(marker, start)
            if index == -1:
                break
            if any(span_start <= index < span_end for span_start, span_end in quoted_spans):
                return True
            start = index + 1
    return False


def split_statements(cypher_text: str) -> list[str]:
    """Strip `//` line comments, split on `;` statement boundaries, and drop any
    resulting blank/whitespace-only statements. No `.cypher` file in this migration
    set uses a string literal containing `//` or `;`, so a naive per-line comment
    strip + split is sufficient for the real files (no Cypher string-literal-aware
    parser needed, per O-7) -- but a line where that assumption is violated raises
    `StatementSplitError` naming the line, rather than silently truncating a
    statement (EC-15)."""
    stripped_lines = []
    for line in cypher_text.splitlines():
        if _line_has_marker_inside_quotes(line):
            raise StatementSplitError(
                "split_statements: a '//' or ';' appears inside a single-quoted string "
                "literal on this line, which the naive comment-strip/statement-split "
                f"cannot safely handle without corrupting it: {line!r}"
            )
        comment_index = line.find("//")
        if comment_index != -1:
            line = line[:comment_index]
        stripped_lines.append(line)

    joined = "\n".join(stripped_lines)
    return [statement.strip() for statement in joined.split(";") if statement.strip()]


def _parse_header(text: str, filename: str) -> tuple[str, frozenset[str]]:
    """Parse the `// Layer:` / `// Targets:` header directives required on every
    `.cypher` migration file (spec.md Interfaces 2). Raises `MigrationHeaderError`
    naming the file and the missing/invalid directive rather than defaulting."""
    layer_match = _LAYER_HEADER_RE.search(text)
    if layer_match is None:
        raise MigrationHeaderError(
            f"{filename}: missing required '// Layer:' header directive "
            f"(must declare one of {_LAYERS})"
        )
    layer = layer_match.group(1).strip()
    if layer not in _LAYERS:
        raise MigrationHeaderError(
            f"{filename}: '// Layer:' must be one of {_LAYERS}, got {layer!r}"
        )

    targets_match = _TARGETS_HEADER_RE.search(text)
    if targets_match is None:
        raise MigrationHeaderError(
            f"{filename}: missing required '// Targets:' header directive "
            f"(comma-separated subset of {TARGETS})"
        )
    targets = frozenset(
        part.strip() for part in targets_match.group(1).split(",") if part.strip()
    )
    unknown = targets - set(TARGETS)
    if unknown or not targets:
        raise MigrationHeaderError(
            f"{filename}: '// Targets:' must be a non-empty comma-separated subset of "
            f"{TARGETS}, got {sorted(targets) if targets else targets_match.group(1)!r}"
        )
    return layer, targets


def discover_migrations(migrations_dir: Path = DEFAULT_MIGRATIONS_DIR) -> list[MigrationFile]:
    """Discover `*.cypher` files, parse their numeric version prefix and `// Layer:`
    / `// Targets:` headers, checksum their raw bytes, and split their statements.
    Returned list is sorted ascending by the parsed integer version (not lexical
    filename order), so `010` sorts after `009`/`002` and gaps between versions never
    crash discovery. Files whose name does not start with `<digits>_` are ignored
    (not a migration file). A file missing a required header raises
    `MigrationHeaderError` naming it (EC-11)."""
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
        text = raw_bytes.decode("utf-8")
        layer, targets = _parse_header(text, path.name)
        statements = split_statements(text)
        migrations.append(
            MigrationFile(
                version=version,
                filename=path.name,
                path=path,
                checksum=checksum,
                statements=statements,
                layer=layer,
                targets=targets,
            )
        )

    migrations.sort(key=lambda m: m.version)
    return migrations


def ensure_tracking_table(pg_conn: "Connection") -> None:
    """Idempotent `graph_migrations` version-tracker setup, safe to call against a
    fresh database, a legacy (single-column `version` primary key) database, or an
    already-migrated database (EC-3/EC-9). No `org_id`, no RLS -- this is global
    infra bookkeeping (graph schema versions are cross-tenant, analogous to
    Drizzle's own `__drizzle_migrations` table), deliberately NOT a tenant-scoped
    domain table (AC-11)."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS graph_migrations (
              target      text        NOT NULL DEFAULT 'neo4j',
              layer       text        NOT NULL DEFAULT 'logical',
              version     integer     NOT NULL,
              filename    text        NOT NULL,
              checksum    text        NOT NULL,
              applied_at  timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (target, layer, version)
            )
            """
        )
        # Legacy shape (predates `target`/`layer`, a single-column `version` primary
        # key): the CREATE TABLE above is a no-op against it, so backfill the missing
        # columns onto the existing rows (the DEFAULT applies retroactively).
        cur.execute(
            "ALTER TABLE graph_migrations "
            "ADD COLUMN IF NOT EXISTS target text NOT NULL DEFAULT 'neo4j'"
        )
        cur.execute(
            "ALTER TABLE graph_migrations "
            "ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'logical'"
        )
        # Re-key to the composite (target, layer, version) primary key, idempotently:
        # a fresh table already has the right key from the CREATE TABLE above (no-op
        # here), and an already-migrated table's key already matches too (also a
        # no-op). Only a genuine legacy (`version`-only PK) table trips the swap.
        cur.execute(
            """
            DO $$
            DECLARE
              existing_pk text;
              pk_is_correct boolean;
            BEGIN
              SELECT conname INTO existing_pk
              FROM pg_constraint
              WHERE conrelid = 'graph_migrations'::regclass AND contype = 'p';

              SELECT EXISTS (
                SELECT 1
                FROM pg_constraint c
                JOIN pg_attribute a
                  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.conrelid = 'graph_migrations'::regclass
                  AND c.contype = 'p'
                GROUP BY c.conname
                HAVING array_agg(a.attname ORDER BY a.attname)::text[] = ARRAY['layer', 'target', 'version']
              ) INTO pk_is_correct;

              IF NOT COALESCE(pk_is_correct, false) THEN
                IF existing_pk IS NOT NULL THEN
                  EXECUTE format('ALTER TABLE graph_migrations DROP CONSTRAINT %I', existing_pk);
                END IF;
                ALTER TABLE graph_migrations ADD PRIMARY KEY (target, layer, version);
              END IF;
            END $$
            """
        )
    pg_conn.commit()


def applied_versions(
    pg_conn: "Connection", *, target: str = "neo4j"
) -> dict[tuple[str, int], str]:
    """Return `{(layer, version): checksum}` for every migration already recorded as
    applied against `target` -- keyed by `(layer, version)` because `(target, layer,
    version)` is now the tracking table's real primary key (AC-5); a given `target`'s
    view only ever needs its own `layer`/`version` pairs."""
    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT layer, version, checksum FROM graph_migrations WHERE target = %s",
            (target,),
        )
        rows = cur.fetchall()
    return {(layer, version): checksum for layer, version, checksum in rows}


def record_applied(
    pg_conn: "Connection", migration: MigrationFile, *, target: str = "neo4j"
) -> None:
    """Record `migration` as applied against `target`. `ON CONFLICT DO NOTHING`
    guards a concurrent duplicate insert (the caller only ever invokes this after
    confirming the (target, layer, version) is not yet applied, but this keeps the
    statement itself safely idempotent too)."""
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO graph_migrations (target, layer, version, filename, checksum)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (target, layer, version) DO NOTHING
            """,
            (target, migration.layer, migration.version, migration.filename, migration.checksum),
        )
    pg_conn.commit()


class MigrationChecksumMismatchError(RuntimeError):
    """Raised when a migration file's on-disk bytes no longer match the checksum
    recorded for it at apply time -- i.e. the file was edited after being applied.
    Never silently re-applied; add a new migration file instead."""


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
    target: str = "neo4j",  # "neo4j" | "neptune"
) -> list[AppliedMigration]:
    if target not in TARGETS:
        raise ValueError(f"run_migrations: target must be one of {TARGETS}, got {target!r}")

    ensure_tracking_table(pg_conn)
    migrations = discover_migrations(migrations_dir)
    recorded = applied_versions(pg_conn, target=target)  # {(layer, version): checksum}

    results: list[AppliedMigration] = []
    for migration in migrations:
        if target not in migration.targets:
            logger.info(
                "Skipping %s (version %d, layer %s) -- not declared for target %s.",
                migration.filename,
                migration.version,
                migration.layer,
                target,
            )
            results.append(
                AppliedMigration(
                    version=migration.version,
                    filename=migration.filename,
                    checksum=migration.checksum,
                    statements_run=0,
                    skipped=True,
                    layer=migration.layer,
                    target=target,
                )
            )
            continue

        recorded_checksum = recorded.get((migration.layer, migration.version))
        if recorded_checksum is not None:
            if recorded_checksum == migration.checksum:
                logger.info(
                    "Skipping %s (version %d) -- already applied to %s, checksum matches.",
                    migration.filename,
                    migration.version,
                    target,
                )
                results.append(
                    AppliedMigration(
                        version=migration.version,
                        filename=migration.filename,
                        checksum=migration.checksum,
                        statements_run=0,
                        skipped=True,
                        layer=migration.layer,
                        target=target,
                    )
                )
                continue

            raise MigrationChecksumMismatchError(
                f"{migration.filename} (version {migration.version}) was already applied "
                f"to target {target!r} with checksum {recorded_checksum!r}, but the file "
                f"on disk now has checksum {migration.checksum!r}. Migration files must "
                "never be edited after being applied -- add a new migration file instead."
            )

        if dry_run:
            logger.info(
                "[dry-run] Would apply %s (version %d, %d statement(s)) to %s.",
                migration.filename,
                migration.version,
                len(migration.statements),
                target,
            )
            results.append(
                AppliedMigration(
                    version=migration.version,
                    filename=migration.filename,
                    checksum=migration.checksum,
                    statements_run=0,
                    skipped=True,
                    layer=migration.layer,
                    target=target,
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

        record_applied(pg_conn, migration, target=target)
        logger.info(
            "Applied %s (version %d, %d statement(s)) to %s.",
            migration.filename,
            migration.version,
            statements_run,
            target,
        )
        results.append(
            AppliedMigration(
                version=migration.version,
                filename=migration.filename,
                checksum=migration.checksum,
                statements_run=statements_run,
                skipped=False,
                layer=migration.layer,
                target=target,
            )
        )

    return results


async def neo4j_driver_from_env() -> "Driver":
    """Build a Neo4j `Driver` from `NEO4J_URI`/`NEO4J_USER`/`NEO4J_PASSWORD` (mirrors
    the central-loader pattern in `messaging/sqs_client.py`). Fails fast with a clear
    error when `NEO4J_PASSWORD` is missing, rather than letting the driver attempt a
    connection with an empty/`None` credential and hang or fail opaquely later
    (mirrors `createPool`'s fail-fast in `services/core/src/db/client.ts`)."""
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
    """Build a `psycopg` connection from the admin migration DSN. Fails fast
    with a clear error when `DATABASE_ADMIN_URL` is missing, mirroring `createPool`'s
    fail-fast in `services/core/src/db/client.ts`."""
    import psycopg

    try:
        url = await get_secret("env://DATABASE_ADMIN_URL")
    except Exception:
        raise PostgresMigrationStartupError from None
    try:
        return psycopg.connect(url)
    except Exception:
        raise PostgresMigrationStartupError from None

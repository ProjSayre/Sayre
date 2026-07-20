"""Deterministic and service-aware tests for layered graph migrations."""

from __future__ import annotations

import asyncio
import functools
import hashlib
import re
import sys
import traceback
from datetime import UTC, datetime
from pathlib import Path

import pytest

from sayre_workers.config import get_config, get_secret, reset_secrets_for_tests
from sayre_workers.graph_migrations import runner
from sayre_workers.graph_migrations.runner import (
    CANONICAL_LEGACY_HASHES,
    DOCUMENTED_CRLF_LEGACY_HASHES,
    LegacyMigrationHistoryError,
    MigrationChecksumMismatchError,
    MigrationFile,
    MigrationHistory,
    MigrationHistoryConflictError,
    MigrationKey,
    canonical_migration_bytes,
    discover_migrations,
    ensure_tracking_table,
    migration_checksum,
    run_migrations,
    split_statements,
)

MIGRATIONS_DIR = runner.DEFAULT_MIGRATIONS_DIR
CANONICAL_LABELS = frozenset(
    {"Project", "Repo", "Folder", "File", "Function", "Class", "Module", "Person", "Commit", "Feature", "Ticket", "EnvStep", "Test"}
)
CANONICAL_EDGE_TYPES = frozenset(
    {"CONTAINS", "CONNECTS_TO", "IMPORTS", "CALLS", "INHERITS", "OWNS", "AUTHORED", "MODIFIED", "REFERENCES", "PART_OF", "REQUIRES", "DEPENDS_ON", "COVERS"}
)


def _path(layer: str, filename: str, target: str = "neo4j") -> Path:
    if layer == "logical":
        return MIGRATIONS_DIR / "logical" / filename
    return MIGRATIONS_DIR / "physical" / target / filename


def _text(layer: str, filename: str, target: str = "neo4j") -> str:
    return _path(layer, filename, target).read_text(encoding="utf-8")


def test_split_statements_strips_comments_and_empty_statements():
    assert split_statements("// note\nMERGE (:A); ;\nMATCH (n); // tail") == [
        "MERGE (:A)",
        "MATCH (n)",
    ]


def test_published_moves_have_canonical_git_hashes_and_crlf_compatibility():
    paths = {
        1: _path("logical", "001_init_node_labels.cypher"),
        2: _path("logical", "002_init_edge_types.cypher"),
        3: _path("physical", "003_constraints_and_indexes.cypher"),
    }
    for version, path in paths.items():
        raw = path.read_bytes()
        assert migration_checksum(raw) == CANONICAL_LEGACY_HASHES[version]
        assert hashlib.sha256(canonical_migration_bytes(raw)).hexdigest() == (
            CANONICAL_LEGACY_HASHES[version]
        )
        crlf = canonical_migration_bytes(raw).replace(b"\n", b"\r\n")
        assert hashlib.sha256(crlf).hexdigest() == DOCUMENTED_CRLF_LEGACY_HASHES[version]


def test_layered_layout_and_target_selection_are_exact():
    neo4j = discover_migrations(target="neo4j")
    neptune = discover_migrations(target="neptune")
    assert [(m.layer, m.version, m.filename) for m in neo4j] == [
        ("logical", 1, "001_init_node_labels.cypher"),
        ("logical", 2, "002_init_edge_types.cypher"),
        ("logical", 3, "003_v5_identity_and_covers.cypher"),
        ("physical", 3, "003_constraints_and_indexes.cypher"),
        ("physical", 4, "004_v5_scope_indexes.cypher"),
    ]
    assert [(m.layer, m.version, m.filename) for m in neptune] == [
        ("logical", 1, "001_init_node_labels.cypher"),
        ("logical", 2, "002_init_edge_types.cypher"),
        ("logical", 3, "003_v5_identity_and_covers.cypher"),
    ]
    assert all("physical/neo4j" not in m.path.as_posix() for m in neptune)


def test_duplicate_version_is_rejected_only_within_same_layer(tmp_path: Path):
    logical = tmp_path / "logical"
    physical = tmp_path / "physical" / "neo4j"
    logical.mkdir(parents=True)
    physical.mkdir(parents=True)
    (logical / "001_a.cypher").write_text("MERGE (:A);")
    (logical / "001_b.cypher").write_text("MERGE (:B);")
    (physical / "001_ok.cypher").write_text("CREATE INDEX x IF NOT EXISTS FOR (n:A) ON (n.x);")
    with pytest.raises(MigrationHistoryConflictError):
        discover_migrations(tmp_path, target="neo4j")


def test_logical_migrations_are_portable_and_neptune_plan_contains_no_ddl():
    forbidden = re.compile(r"\b(?:CREATE\s+(?:CONSTRAINT|INDEX)|CALL\s+db\.|apoc\.)", re.I)
    for migration in discover_migrations(target="neptune"):
        assert migration.layer == "logical"
        assert not forbidden.search("\n".join(migration.statements))
        assert all(statement.split(None, 1)[0].upper() in {"MATCH", "MERGE"} for statement in migration.statements)


def test_closed_schema_sets_and_v5_covers_anchors_are_declared():
    node_text = _text("logical", "001_init_node_labels.cypher")
    edge_text = _text("logical", "002_init_edge_types.cypher")
    v5_text = _text("logical", "003_v5_identity_and_covers.cypher")
    assert set(re.findall(r"MERGE\s*\(:(\w+)\s*\{", node_text)) == CANONICAL_LABELS
    assert set(re.findall(r"\[:(\w+)\s*\{", edge_text)) == CANONICAL_EDGE_TYPES
    assert set(re.findall(r"\(b:(File|Function|Class|Module)\s*\{", v5_text)) == {
        "File",
        "Function",
        "Class",
        "Module",
    }
    assert "coverage_status = 'unknown'" in v5_text
    assert v5_text.count("r.status = 'inferred'") == 4
    assert "REMOVE r.source, r.last_run" in v5_text
    assert "source:'static'" not in v5_text
    for property_name in ("repo_id", "ref_name", "revision_sha"):
        assert property_name in v5_text


def test_neo4j_physical_migrations_are_named_idempotent_ddl_and_scope_aware():
    physical = discover_migrations(target="neo4j")[3:]
    assert all(m.layer == "physical" for m in physical)
    for migration in physical:
        assert all("IF NOT EXISTS" in statement for statement in migration.statements)
    scope_text = _text("physical", "004_v5_scope_indexes.cypher")
    for token in ("repo_scope_idx", "folder_scope_path_idx", "function_scope_symbol_idx", "commit_scope_sha_idx", "covers_scope_status_idx"):
        assert token in scope_text
    assert "CREATE CONSTRAINT" not in scope_text


class _FakeSession:
    def __init__(self, calls: list[str], fail_on: str | None = None):
        self.calls = calls
        self.fail_on = fail_on

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def run(self, statement: str):
        if self.fail_on and self.fail_on in statement:
            raise RuntimeError("simulated graph failure")
        self.calls.append(statement)


class _FakeDriver:
    def __init__(self, fail_on: str | None = None):
        self.calls: list[str] = []
        self.fail_on = fail_on

    def session(self):
        return _FakeSession(self.calls, self.fail_on)


class _HistoryStore:
    def __init__(self):
        self.ensured = False
        self.rows: dict[MigrationKey, MigrationHistory] = {}


@pytest.fixture
def fake_history(monkeypatch) -> _HistoryStore:
    store = _HistoryStore()

    def ensure(pg_conn):
        pg_conn.ensured = True

    def applied(pg_conn, *, target=None):
        return {
            key: value
            for key, value in pg_conn.rows.items()
            if target is None or key.graph_target == target
        }

    def record(pg_conn, migration: MigrationFile):
        pg_conn.rows[migration.key] = MigrationHistory(
            migration.graph_target,
            migration.layer,
            migration.version,
            migration.filename,
            migration.checksum,
        )

    monkeypatch.setattr(runner, "ensure_tracking_table", ensure)
    monkeypatch.setattr(runner, "applied_versions", applied)
    monkeypatch.setattr(runner, "record_applied", record)
    return store


def test_first_double_triple_apply_and_cross_layer_version_reuse(fake_history):
    driver = _FakeDriver()
    first = run_migrations(driver, fake_history, target="neo4j")
    call_count = len(driver.calls)
    second = run_migrations(driver, fake_history, target="neo4j")
    third = run_migrations(driver, fake_history, target="neo4j")
    assert len(first) == len(second) == len(third) == 5
    assert all(not result.skipped for result in first)
    assert all(result.skipped for result in [*second, *third])
    assert len(driver.calls) == call_count
    assert len(fake_history.rows) == 5
    assert MigrationKey("neo4j", "logical", 3) in fake_history.rows
    assert MigrationKey("neo4j", "physical", 3) in fake_history.rows


def test_target_histories_are_isolated_and_neptune_is_logical_only(fake_history):
    driver = _FakeDriver()
    run_migrations(driver, fake_history, target="neo4j")
    neo_calls = len(driver.calls)
    neptune = run_migrations(driver, fake_history, target="neptune")
    assert len(neptune) == 3
    assert all(result.layer == "logical" and not result.skipped for result in neptune)
    assert len(driver.calls) > neo_calls
    assert len(fake_history.rows) == 8


def test_dry_run_bootstraps_only_tracking_table(fake_history):
    driver = _FakeDriver()
    results = run_migrations(driver, fake_history, dry_run=True, target="neo4j")
    assert fake_history.ensured
    assert driver.calls == []
    assert fake_history.rows == {}
    assert all(result.skipped for result in results)


def test_partial_failure_has_no_history_and_clean_replay_recovers(fake_history, tmp_path: Path):
    logical = tmp_path / "logical"
    logical.mkdir()
    path = logical / "001_partial.cypher"
    path.write_text("MERGE (:A {x: 1});\nMERGE (:B {x: 2});")
    with pytest.raises(RuntimeError):
        run_migrations(_FakeDriver("MERGE (:B"), fake_history, tmp_path)
    assert fake_history.rows == {}
    clean = _FakeDriver()
    assert run_migrations(clean, fake_history, tmp_path)[0].skipped is False
    assert len(fake_history.rows) == 1


def test_history_compares_filename_and_checksum(fake_history):
    driver = _FakeDriver()
    [migration, *_] = discover_migrations(target="neo4j")
    fake_history.rows[migration.key] = MigrationHistory(
        migration.graph_target, migration.layer, migration.version, "other.cypher", migration.checksum
    )
    with pytest.raises(MigrationHistoryConflictError):
        run_migrations(driver, fake_history)
    fake_history.rows[migration.key] = MigrationHistory(
        migration.graph_target, migration.layer, migration.version, migration.filename, "0" * 64
    )
    with pytest.raises(MigrationChecksumMismatchError):
        run_migrations(driver, fake_history)


class _TrackingCursor:
    def __init__(self, conn: "_TrackingConnection"):
        self.conn = conn
        self.rows: list[tuple] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query: str, params=()):
        sql = " ".join(query.split())
        self.conn.executed.append((sql, params))
        if sql.startswith("SELECT to_regclass"):
            self.rows = [("graph_migrations",)] if self.conn.mode else [(None,)]
        elif "FROM information_schema.columns" in sql:
            columns = {
                "legacy": ["version", "filename", "checksum", "applied_at"],
                "modern": ["graph_target", "layer", "version", "filename", "checksum", "applied_at"],
            }[self.conn.mode]
            self.rows = [(column,) for column in columns]
        elif "FROM information_schema.table_constraints" in sql:
            key = ["version"] if self.conn.mode == "legacy" else ["graph_target", "layer", "version"]
            self.rows = [(column,) for column in key]
        elif sql.startswith("SELECT version, filename"):
            self.rows = list(self.conn.legacy_rows)
        elif sql.startswith("ALTER TABLE"):
            self.conn.mode = "renamed"
            self.rows = []
        elif sql.startswith("CREATE TABLE graph_migrations"):
            self.conn.mode = "modern"
            self.rows = []
        elif sql.startswith("INSERT INTO graph_migrations"):
            self.conn.inserted.append(tuple(params))
            self.rows = []
        else:
            self.rows = []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class _TrackingConnection:
    def __init__(self, mode=None, legacy_rows=()):
        self.mode = mode
        self.legacy_rows = list(legacy_rows)
        self.executed: list[tuple[str, tuple]] = []
        self.inserted: list[tuple] = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return _TrackingCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_fresh_composite_tracking_table_and_repeated_modern_setup():
    conn = _TrackingConnection()
    ensure_tracking_table(conn)
    assert conn.mode == "modern"
    create_sql = next(sql for sql, _ in conn.executed if sql.startswith("CREATE TABLE"))
    assert "PRIMARY KEY (graph_target, layer, version)" in create_sql
    assert "CHECK (graph_target IN ('neo4j', 'neptune'))" in create_sql
    ensure_tracking_table(conn)
    assert conn.commits == 2


@pytest.mark.parametrize("versions", [(1, 2), (1, 2, 3)])
@pytest.mark.parametrize("use_crlf_hash", [False, True])
def test_exact_legacy_upgrade_preserves_timestamps_and_is_idempotent(versions, use_crlf_hash):
    timestamps = {version: datetime(2026, 1, version, tzinfo=UTC) for version in versions}
    hashes = DOCUMENTED_CRLF_LEGACY_HASHES if use_crlf_hash else CANONICAL_LEGACY_HASHES
    rows = [
        (version, runner._LEGACY_FILENAMES[version], hashes[version], timestamps[version])
        for version in versions
    ]
    conn = _TrackingConnection("legacy", rows)
    ensure_tracking_table(conn)
    assert conn.mode == "modern"
    assert [row[2] for row in conn.inserted] == list(versions)
    assert [row[4] for row in conn.inserted] == [CANONICAL_LEGACY_HASHES[v] for v in versions]
    assert [row[5] for row in conn.inserted] == [timestamps[v] for v in versions]
    ensure_tracking_table(conn)
    assert conn.commits == 2


def test_unknown_legacy_history_rolls_back_before_schema_changes():
    conn = _TrackingConnection(
        "legacy",
        [(1, "001_init_node_labels.cypher", "bad", datetime.now(UTC))],
    )
    with pytest.raises(LegacyMigrationHistoryError):
        ensure_tracking_table(conn)
    assert conn.rollbacks == 1
    assert not any(sql.startswith("ALTER TABLE") for sql, _ in conn.executed)


async def test_target_aware_cli_status_never_lists_neo4j_physical_for_neptune(monkeypatch, capsys):
    from scripts import run_graph_migrations as migration_cli

    class Connection:
        def close(self):
            pass

    async def open_postgres():
        return Connection()

    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py", "--status", "--target", "neptune"])
    monkeypatch.setattr(migration_cli, "pg_connection_from_env", open_postgres)
    monkeypatch.setattr(migration_cli, "ensure_tracking_table", lambda _conn: None)
    monkeypatch.setattr(migration_cli, "applied_versions", lambda _conn, target: {})
    result = await migration_cli.main()
    captured = capsys.readouterr()
    assert result == 0
    assert "target=neptune" in captured.out
    assert "003_v5_identity_and_covers.cypher" in captured.out
    assert "constraints_and_indexes" not in captured.out
    assert "scope_indexes" not in captured.out


async def test_client_construction_failures_and_cli_operation_are_fixed_text(monkeypatch, capsys):
    import psycopg
    from scripts import run_graph_migrations as migration_cli

    secret = "postgresql://admin:SECRET@invalid/db"
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("DATABASE_ADMIN_URL", secret)
    reset_secrets_for_tests()
    monkeypatch.setattr(psycopg, "connect", lambda url: (_ for _ in ()).throw(RuntimeError(url)))
    try:
        with pytest.raises(runner.PostgresMigrationStartupError) as exc_info:
            await runner.pg_connection_from_env()
    finally:
        reset_secrets_for_tests()
    visible = "".join(traceback.format_exception(exc_info.type, exc_info.value, exc_info.tb))
    assert secret not in visible

    class Resource:
        def __init__(self):
            self.closed = 0

        def close(self):
            self.closed += 1

    pg_conn, graph = Resource(), Resource()
    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py"])
    monkeypatch.setattr(migration_cli, "pg_connection_from_env", lambda: asyncio.sleep(0, result=pg_conn))
    monkeypatch.setattr(migration_cli, "neo4j_driver_from_env", lambda: asyncio.sleep(0, result=graph))
    monkeypatch.setattr(migration_cli, "run_migrations", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError(secret)))
    assert await migration_cli.main() == 1
    captured = capsys.readouterr()
    assert secret not in captured.err
    assert captured.err.strip() == f"Graph migration operation FAILED: {migration_cli.OPERATION_ERROR}"
    assert pg_conn.closed == graph.closed == 1


@functools.lru_cache(maxsize=1)
def _infra_config() -> tuple[str, str, str, str]:
    async def resolve():
        password, database_url = await asyncio.gather(
            get_secret("env://NEO4J_PASSWORD"), get_secret("env://DATABASE_ADMIN_URL")
        )
        return get_config("NEO4J_URI"), get_config("NEO4J_USER"), password, database_url

    return asyncio.run(resolve())


@functools.lru_cache(maxsize=1)
def _services_reachable() -> bool:
    try:
        import neo4j
        import psycopg

        uri, user, password, url = _infra_config()
        driver = neo4j.GraphDatabase.driver(uri, auth=(user, password), connection_timeout=2)
        driver.verify_connectivity()
        driver.close()
        conn = psycopg.connect(url, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


@pytest.fixture
def real_infra():
    if not _services_reachable():
        pytest.skip("Neo4j/Postgres unavailable")
    import neo4j
    import psycopg

    uri, user, password, url = _infra_config()
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
    conn = psycopg.connect(url)
    with conn.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS graph_migrations")
    conn.commit()
    with driver.session() as session:
        session.run("MATCH (n {uid: '__schema_anchor__'}) DETACH DELETE n").consume()
    try:
        yield driver, conn
    finally:
        driver.close()
        conn.close()


def test_real_neo4j_triple_apply_has_stable_schema_and_five_history_keys(real_infra):
    driver, conn = real_infra
    first = run_migrations(driver, conn, target="neo4j")
    second = run_migrations(driver, conn, target="neo4j")
    third = run_migrations(driver, conn, target="neo4j")
    assert len(first) == len(second) == len(third) == 5
    with conn.cursor() as cursor:
        cursor.execute("SELECT graph_target, layer, version FROM graph_migrations ORDER BY layer, version")
        assert len(cursor.fetchall()) == 5
    with driver.session() as session:
        assert session.run("MATCH (n {uid:'__schema_anchor__'}) RETURN count(n) AS c").single()["c"] == 13
        assert session.run("MATCH (:Test {uid:'__schema_anchor__'})-[r:COVERS]->() RETURN count(r) AS c").single()["c"] == 4


def test_real_logical_only_neptune_selection_records_three_isolated_keys(real_infra):
    driver, conn = real_infra
    results = run_migrations(driver, conn, target="neptune")
    assert len(results) == 3 and all(result.layer == "logical" for result in results)
    with conn.cursor() as cursor:
        cursor.execute("SELECT graph_target, layer, version FROM graph_migrations ORDER BY version")
        assert cursor.fetchall() == [("neptune", "logical", 1), ("neptune", "logical", 2), ("neptune", "logical", 3)]

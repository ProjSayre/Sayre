"""Tests for the Neo4j graph-schema migration runner (W0-02).

Two tiers:

1. Deterministic unit tests (always run, no infra required) covering
   `split_statements`/`discover_migrations` parsing, the openCypher purity/closed-set
   guards against the real `.cypher` files, and the `run_migrations` apply/idempotency
   algorithm itself -- exercised against fakes (`_FakeDriver`/`_FakePgConn`) so the
   headline idempotency contract (double-apply is a no-op; checksum-mismatch raises;
   partial failure leaves no tracking row; `--dry-run`/`--target neptune` mutate
   nothing they shouldn't) is proven without requiring a live Neo4j/Postgres.
2. A real-infra integration smoke test (module-scoped, skips cleanly if Neo4j/Postgres
   are unreachable -- mirrors `test_sqs_roundtrip.py`'s LocalStack-reachability
   pattern) that runs the actual runner against the real `services/workers/
   graph-migrations/` files and asserts node/edge/constraint/index counts are
   unchanged after a second run. This is the Tester's headline acceptance test
   (spec.md "Edge cases" -- Double/triple apply); the skeleton here proves the wiring
   end-to-end and is expected to be expanded by the tester stage.
"""

from __future__ import annotations

import asyncio
import functools
import re
import sys
import traceback
from pathlib import Path

import pytest

from sayre_workers.config import get_config, get_secret, reset_secrets_for_tests
from sayre_workers.graph_migrations import runner
from sayre_workers.graph_migrations.runner import (
    MigrationChecksumMismatchError,
    MigrationFile,
    discover_migrations,
    run_migrations,
    split_statements,
)

MIGRATIONS_DIR = runner.DEFAULT_MIGRATIONS_DIR

# Canonical closed sets -- see .claude/rules/graph-schema.md / packages/graph-schema/schema.md
CANONICAL_LABELS = frozenset(
    {
        "Project",
        "Repo",
        "Folder",
        "File",
        "Function",
        "Class",
        "Module",
        "Person",
        "Commit",
        "Feature",
        "Ticket",
        "EnvStep",
        "Test",
    }
)
CANONICAL_EDGE_TYPES = frozenset(
    {
        "CONTAINS",
        "CONNECTS_TO",
        "IMPORTS",
        "CALLS",
        "INHERITS",
        "OWNS",
        "AUTHORED",
        "MODIFIED",
        "REFERENCES",
        "PART_OF",
        "REQUIRES",
        "DEPENDS_ON",
        "COVERS",
    }
)


# --- split_statements ---------------------------------------------------------------


def test_split_statements_strips_comments_blank_lines_and_trailing_semicolon():
    text = """\
// a leading comment line
MERGE (:Project {uid: '__schema_anchor__'}); // trailing inline comment

  // another comment-only line
MERGE (:Repo {uid: '__schema_anchor__'});
"""
    statements = split_statements(text)
    assert statements == [
        "MERGE (:Project {uid: '__schema_anchor__'})",
        "MERGE (:Repo {uid: '__schema_anchor__'})",
    ]


def test_split_statements_drops_empty_and_whitespace_only_statements():
    assert split_statements(";;;   ;\n\n;") == []
    assert split_statements("") == []


# --- discover_migrations -------------------------------------------------------------


def test_discover_migrations_sorts_by_numeric_version_not_lexical(tmp_path: Path):
    (tmp_path / "002_second.cypher").write_text("MERGE (:A {uid:'x'});")
    (tmp_path / "010_tenth.cypher").write_text("MERGE (:B {uid:'x'});")
    (tmp_path / "009_ninth.cypher").write_text("MERGE (:C {uid:'x'});")

    migrations = discover_migrations(tmp_path)

    assert [m.version for m in migrations] == [2, 9, 10]
    assert [m.filename for m in migrations] == [
        "002_second.cypher",
        "009_ninth.cypher",
        "010_tenth.cypher",
    ]


def test_discover_migrations_ignores_non_conforming_filenames(tmp_path: Path):
    (tmp_path / "001_ok.cypher").write_text("MERGE (:A {uid:'x'});")
    (tmp_path / "notes.cypher").write_text("// not a migration")

    migrations = discover_migrations(tmp_path)

    assert [m.filename for m in migrations] == ["001_ok.cypher"]


def test_discover_migrations_checksum_reflects_file_bytes(tmp_path: Path):
    path = tmp_path / "001_a.cypher"
    path.write_text("MERGE (:A {uid:'x'});")
    [before] = discover_migrations(tmp_path)

    path.write_text("MERGE (:A {uid:'y'});")
    [after] = discover_migrations(tmp_path)

    assert before.checksum != after.checksum


# --- Real .cypher files: openCypher purity + closed-set guards ----------------------


def _read(filename: str) -> str:
    return (MIGRATIONS_DIR / filename).read_text()


def test_migrations_dir_contains_exactly_the_four_named_files():
    names = {p.name for p in MIGRATIONS_DIR.glob("*.cypher")}
    assert names == {
        "001_init_node_labels.cypher",
        "002_init_edge_types.cypher",
        "003_constraints_and_indexes.cypher",
        "004_test_covers_contract.cypher",
    }


def test_each_migration_file_has_a_header_comment_stating_purpose_and_neptune_status():
    """AC1: each file begins with a header comment stating its purpose and its
    Neptune-replayability status ('Neptune-replayable: YES' or 'Neptune-replayable:
    NO' / equivalent explicit flag)."""
    expectations = {
        "001_init_node_labels.cypher": "YES",
        "002_init_edge_types.cypher": "YES",
        "003_constraints_and_indexes.cypher": "NO",
        "004_test_covers_contract.cypher": "YES",
    }
    for filename, expected_replayability in expectations.items():
        text = _read(filename)
        header = "\n".join(
            line for line in text.splitlines()[:5] if line.strip().startswith("//")
        )
        assert header, f"{filename} must open with `//` header comment lines"
        assert "Purpose" in text or "Purpose:" in text, (
            f"{filename} header must state its purpose"
        )
        assert re.search(rf"Neptune-replayable:\s*\**{expected_replayability}\b", text), (
            f"{filename} header must explicitly flag Neptune-replayable: {expected_replayability}"
        )


def test_no_apoc_or_db_procedure_calls_in_any_migration_file():
    for filename in (
        "001_init_node_labels.cypher",
        "002_init_edge_types.cypher",
        "003_constraints_and_indexes.cypher",
        "004_test_covers_contract.cypher",
    ):
        text = _read(filename)
        assert "apoc." not in text, f"{filename} must not use APOC (openCypher only)"
        assert "CALL db." not in text, f"{filename} must not call db.* procedures"


def test_only_003_contains_constraint_or_index_ddl():
    ddl_pattern = re.compile(r"\b(CREATE CONSTRAINT|CREATE INDEX)\b")
    assert not ddl_pattern.search(_read("001_init_node_labels.cypher"))
    assert not ddl_pattern.search(_read("002_init_edge_types.cypher"))
    assert not ddl_pattern.search(_read("004_test_covers_contract.cypher"))
    assert ddl_pattern.search(_read("003_constraints_and_indexes.cypher"))


def test_004_migrates_coverage_contract_without_dropping_last_run():
    text = _read("004_test_covers_contract.cypher")
    assert "r.status" in text
    assert "'inferred'" in text
    assert "'measured'" in text
    assert "t.coverage_status" in text
    assert "REMOVE r.source" in text
    assert "REMOVE r.last_run" not in text


def test_001_and_002_are_pure_merge_match_no_ddl():
    """001/002 must be Neptune-replayable: pure MERGE/MATCH data statements only."""
    for filename in ("001_init_node_labels.cypher", "002_init_edge_types.cypher"):
        for statement in split_statements(_read(filename)):
            first_keyword = statement.strip().split(None, 1)[0].upper()
            assert first_keyword in ("MERGE", "MATCH"), (
                f"{filename} statement does not start with MERGE/MATCH: {statement!r}"
            )


def test_001_declares_exactly_the_13_canonical_node_labels():
    labels = set(re.findall(r"MERGE\s*\(:(\w+)\s*\{", _read("001_init_node_labels.cypher")))
    assert labels == CANONICAL_LABELS


def test_002_declares_exactly_the_13_canonical_edge_types():
    edge_types = set(re.findall(r"\[:(\w+)\s*\{", _read("002_init_edge_types.cypher")))
    assert edge_types == CANONICAL_EDGE_TYPES


def test_every_anchor_node_and_edge_carries_org_id():
    sentinel = "00000000-0000-0000-0000-000000000000"
    for filename in ("001_init_node_labels.cypher", "002_init_edge_types.cypher"):
        for statement in split_statements(_read(filename)):
            if statement.upper().startswith("MERGE"):
                assert f"org_id:'{sentinel}'" in statement or f"org_id: '{sentinel}'" in statement


def test_003_has_uid_org_id_uniqueness_constraint_and_org_id_index_per_label():
    text = _read("003_constraints_and_indexes.cypher")
    for label in CANONICAL_LABELS:
        assert re.search(
            rf"CREATE CONSTRAINT \w+ IF NOT EXISTS\s+FOR \(n:{label}\) REQUIRE \(n\.org_id, n\.uid\) IS UNIQUE",
            text,
        ), f"missing (org_id, uid) uniqueness constraint for {label}"
        assert re.search(
            rf"CREATE INDEX \w+ IF NOT EXISTS\s+FOR \(n:{label}\) ON \(n\.org_id\)", text
        ), f"missing org_id index for {label}"


# --- run_migrations: apply/idempotency algorithm, exercised against fakes ----------


class _FakeSession:
    def __init__(self, calls: list[str], *, fail_on_statement: str | None = None):
        self._calls = calls
        self._fail_on_statement = fail_on_statement

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def run(self, statement: str) -> None:
        if self._fail_on_statement is not None and self._fail_on_statement in statement:
            raise RuntimeError(f"simulated failure on statement: {statement!r}")
        self._calls.append(statement)


class _FakeDriver:
    """Records every statement handed to session.run(); optionally fails on a
    specific statement substring to simulate a partial mid-file failure."""

    def __init__(self, *, fail_on_statement: str | None = None):
        self.calls: list[str] = []
        self._fail_on_statement = fail_on_statement

    def session(self):
        return _FakeSession(self.calls, fail_on_statement=self._fail_on_statement)


class _FakePgConn:
    """In-memory stand-in for the tracking-table effects of ensure_tracking_table /
    applied_versions / record_applied, used via monkeypatch below so run_migrations'
    control flow is tested without a live Postgres."""

    def __init__(self):
        self.table_ensured = False
        self.rows: dict[int, tuple[str, str]] = {}  # version -> (filename, checksum)


@pytest.fixture
def fake_pg(monkeypatch) -> _FakePgConn:
    conn = _FakePgConn()

    def fake_ensure_tracking_table(pg_conn: _FakePgConn) -> None:
        pg_conn.table_ensured = True

    def fake_applied_versions(pg_conn: _FakePgConn) -> dict[int, str]:
        return {version: checksum for version, (_filename, checksum) in pg_conn.rows.items()}

    def fake_record_applied(pg_conn: _FakePgConn, migration: MigrationFile) -> None:
        pg_conn.rows[migration.version] = (migration.filename, migration.checksum)

    monkeypatch.setattr(runner, "ensure_tracking_table", fake_ensure_tracking_table)
    monkeypatch.setattr(runner, "applied_versions", fake_applied_versions)
    monkeypatch.setattr(runner, "record_applied", fake_record_applied)
    return conn


def test_first_run_applies_all_four_real_migration_files(fake_pg):
    driver = _FakeDriver()

    results = run_migrations(driver, fake_pg)

    assert [r.version for r in results] == [1, 2, 3, 4]
    assert all(not r.skipped for r in results)
    assert all(r.statements_run > 0 for r in results)
    assert len(fake_pg.rows) == 4
    assert len(driver.calls) == sum(r.statements_run for r in results)


def test_double_apply_is_a_noop_headline_idempotency_contract(fake_pg):
    """AC2: running the runner twice produces no additional Neo4j statements and no
    duplicate tracking rows -- the fake-store equivalent of "zero duplicate anchor
    nodes/edges/constraints/indexes after run 2". The real-infra test below proves
    the same property against a live Neo4j via SHOW CONSTRAINTS/SHOW INDEXES/counts."""
    driver = _FakeDriver()

    first = run_migrations(driver, fake_pg)
    calls_after_first = len(driver.calls)
    rows_after_first = dict(fake_pg.rows)

    second = run_migrations(driver, fake_pg)

    assert all(r.skipped for r in second)
    assert len(driver.calls) == calls_after_first, "second run must not issue any new Cypher"
    assert fake_pg.rows == rows_after_first, "second run must not write any new tracking rows"
    assert [r.version for r in first] == [r.version for r in second]


def test_triple_apply_stays_a_noop(fake_pg):
    driver = _FakeDriver()
    run_migrations(driver, fake_pg)
    calls_after_first = len(driver.calls)

    run_migrations(driver, fake_pg)
    run_migrations(driver, fake_pg)

    assert len(driver.calls) == calls_after_first
    assert len(fake_pg.rows) == 4


def test_mutated_after_apply_file_raises_checksum_mismatch(fake_pg, tmp_path: Path, monkeypatch):
    mig_dir = tmp_path
    (mig_dir / "001_a.cypher").write_text("MERGE (:A {uid:'x', org_id:'0'});")
    driver = _FakeDriver()

    run_migrations(driver, fake_pg, mig_dir)

    # Mutate the file's bytes after it was applied.
    (mig_dir / "001_a.cypher").write_text("MERGE (:A {uid:'x', org_id:'1'});")

    with pytest.raises(MigrationChecksumMismatchError):
        run_migrations(driver, fake_pg, mig_dir)


def test_partial_failure_leaves_no_tracking_row_and_clean_rerun_recovers(fake_pg, tmp_path: Path):
    mig_dir = tmp_path
    (mig_dir / "001_a.cypher").write_text(
        "MERGE (:A {uid:'x', org_id:'0'});\nMERGE (:B {uid:'x', org_id:'0'});"
    )
    failing_driver = _FakeDriver(fail_on_statement="MERGE (:B")

    with pytest.raises(RuntimeError):
        run_migrations(failing_driver, fake_pg, mig_dir)

    # Failed mid-file: no tracking row recorded, and only the first (pre-failure)
    # statement was actually issued to Neo4j.
    assert 1 not in fake_pg.rows
    assert failing_driver.calls == ["MERGE (:A {uid:'x', org_id:'0'})"]

    # A clean re-run (no failure this time) completes and records it -- no duplicates
    # from the partially-run first attempt (the file's statements are individually
    # idempotent, so re-running both is safe).
    clean_driver = _FakeDriver()
    results = run_migrations(clean_driver, fake_pg, mig_dir)

    assert results[0].skipped is False
    assert 1 in fake_pg.rows
    assert clean_driver.calls == [
        "MERGE (:A {uid:'x', org_id:'0'})",
        "MERGE (:B {uid:'x', org_id:'0'})",
    ]


def test_dry_run_mutates_neither_store(fake_pg):
    driver = _FakeDriver()

    results = run_migrations(driver, fake_pg, dry_run=True)

    assert all(r.skipped for r in results)
    assert driver.calls == []
    assert fake_pg.rows == {}
    # ensure_tracking_table is still idempotent bookkeeping, not migration data:
    assert fake_pg.table_ensured is True


def test_target_neptune_skips_version_3_and_does_not_record_it(fake_pg):
    driver = _FakeDriver()

    results = run_migrations(driver, fake_pg, target="neptune")

    by_version = {r.version: r for r in results}
    assert by_version[1].skipped is False
    assert by_version[2].skipped is False
    assert by_version[3].skipped is True
    assert by_version[4].skipped is False
    assert set(fake_pg.rows.keys()) == {1, 2, 4}


def test_invalid_target_raises_value_error(fake_pg):
    driver = _FakeDriver()
    with pytest.raises(ValueError):
        run_migrations(driver, fake_pg, target="bogus")


# --- env-config fail-fast (neo4j_driver_from_env / pg_connection_from_env) ---------


async def test_neo4j_driver_from_env_fails_fast_without_password(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.delenv("NEO4J_PASSWORD", raising=False)
    reset_secrets_for_tests()
    with pytest.raises(RuntimeError, match="NEO4J_PASSWORD"):
        await runner.neo4j_driver_from_env()


async def test_pg_connection_from_env_fails_fast_without_database_url(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.delenv("DATABASE_ADMIN_URL", raising=False)
    reset_secrets_for_tests()
    with pytest.raises(RuntimeError, match="DATABASE_ADMIN_URL"):
        await runner.pg_connection_from_env()


async def test_pg_constructor_failure_redacts_resolved_database_admin_url(monkeypatch):
    import psycopg

    sentinel = "postgresql://admin:W0_07_DSN_SENTINEL@db.invalid/sayre"
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("DATABASE_ADMIN_URL", sentinel)
    reset_secrets_for_tests()

    def fail_with_resolved_url(url: str):
        assert url == sentinel
        raise RuntimeError(f"psycopg rejected resolved DSN: {url}")

    monkeypatch.setattr(psycopg, "connect", fail_with_resolved_url)
    try:
        with pytest.raises(runner.PostgresMigrationStartupError) as exc_info:
            await runner.pg_connection_from_env()
    finally:
        reset_secrets_for_tests()

    error = exc_info.value
    visible_error = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    assert str(error) == runner.POSTGRES_STARTUP_ERROR
    assert error.__suppress_context__ is True
    assert sentinel not in str(error)
    assert sentinel not in repr(error)
    assert sentinel not in visible_error


@pytest.mark.parametrize("args", [[], ["--dry-run"], ["--status"]])
async def test_cli_all_postgres_startup_paths_redact_resolved_admin_url(
    monkeypatch,
    capsys,
    args,
):
    import psycopg
    from scripts import run_graph_migrations as migration_cli

    sentinel = "postgresql://admin:W0_07_CLI_DSN_SENTINEL@db.invalid/sayre"
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("DATABASE_ADMIN_URL", sentinel)
    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py", *args])
    reset_secrets_for_tests()

    def fail_with_resolved_url(url: str):
        assert url == sentinel
        raise RuntimeError(f"startup leaked resolved DSN: {url}")

    monkeypatch.setattr(psycopg, "connect", fail_with_resolved_url)
    try:
        result = await migration_cli.main()
    finally:
        reset_secrets_for_tests()

    captured = capsys.readouterr()
    assert result == 1
    assert captured.out == ""
    assert captured.err.strip() == (
        f"Graph migration startup FAILED: {runner.POSTGRES_STARTUP_ERROR}"
    )
    assert sentinel not in captured.out
    assert sentinel not in captured.err


async def test_cli_neo4j_startup_error_is_fixed_and_closes_postgres(
    monkeypatch,
    capsys,
):
    import neo4j
    import psycopg
    from scripts import run_graph_migrations as migration_cli

    password_sentinel = "W0_07_NEO4J_PASSWORD_SENTINEL"
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("DATABASE_ADMIN_URL", "postgresql://admin@db.invalid/sayre")
    monkeypatch.setenv("NEO4J_URI", "bolt://graph.invalid:7687")
    monkeypatch.setenv("NEO4J_USER", "neo4j")
    monkeypatch.setenv("NEO4J_PASSWORD", password_sentinel)
    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py"])
    reset_secrets_for_tests()

    class FakeConnection:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    connection = FakeConnection()

    def graph_factory(_uri: str, *, auth):
        assert auth == ("neo4j", password_sentinel)
        raise RuntimeError(f"driver rejected password {password_sentinel}")

    monkeypatch.setattr(psycopg, "connect", lambda _url: connection)
    monkeypatch.setattr(neo4j.GraphDatabase, "driver", graph_factory)
    try:
        result = await migration_cli.main()
    finally:
        reset_secrets_for_tests()

    captured = capsys.readouterr()
    assert result == 1
    assert connection.close_calls == 1
    assert captured.out == ""
    assert captured.err.strip() == (
        f"Graph migration startup FAILED: {runner.NEO4J_STARTUP_ERROR}"
    )
    assert password_sentinel not in captured.err


def test_cli_teardown_error_text_redacts_both_close_failures():
    from scripts import run_graph_migrations as migration_cli

    neo4j_sentinel = "W0_07_NEO4J_CLOSE_SENTINEL"
    postgres_sentinel = "W0_07_POSTGRES_CLOSE_SENTINEL"
    close_order: list[str] = []

    class FailingResource:
        def __init__(self, name: str, sentinel: str) -> None:
            self.name = name
            self.sentinel = sentinel

        def close(self) -> None:
            close_order.append(self.name)
            raise RuntimeError(f"{self.name} close leaked {self.sentinel}")

    neo4j_driver = FailingResource("neo4j", neo4j_sentinel)
    pg_conn = FailingResource("postgres", postgres_sentinel)

    with pytest.raises(migration_cli.GraphMigrationTeardownError) as exc_info:
        migration_cli._close_resources(neo4j_driver, pg_conn)

    error = exc_info.value
    visible_error = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    assert close_order == ["neo4j", "postgres"]
    assert str(error) == migration_cli.TEARDOWN_ERROR
    assert error.__suppress_context__ is True
    for sentinel in (neo4j_sentinel, postgres_sentinel):
        assert sentinel not in str(error)
        assert sentinel not in repr(error)
        assert sentinel not in visible_error


@pytest.mark.parametrize("args", [[], ["--dry-run"]])
async def test_cli_default_and_dry_run_teardown_are_independent_and_redacted(
    monkeypatch,
    capsys,
    args,
):
    from scripts import run_graph_migrations as migration_cli

    neo4j_sentinel = "W0_07_CLI_NEO4J_CLOSE_SENTINEL"
    postgres_sentinel = "W0_07_CLI_POSTGRES_CLOSE_SENTINEL"
    close_order: list[str] = []

    class FailingResource:
        def __init__(self, name: str, sentinel: str) -> None:
            self.name = name
            self.sentinel = sentinel

        def close(self) -> None:
            close_order.append(self.name)
            raise RuntimeError(f"{self.name} close leaked {self.sentinel}")

    neo4j_driver = FailingResource("neo4j", neo4j_sentinel)
    pg_conn = FailingResource("postgres", postgres_sentinel)

    async def open_postgres():
        return pg_conn

    async def open_neo4j():
        return neo4j_driver

    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py", *args])
    monkeypatch.setattr(migration_cli, "pg_connection_from_env", open_postgres)
    monkeypatch.setattr(migration_cli, "neo4j_driver_from_env", open_neo4j)
    monkeypatch.setattr(migration_cli, "run_migrations", lambda *_args, **_kwargs: [])

    result = await migration_cli.main()
    captured = capsys.readouterr()

    assert result == 1
    assert close_order == ["neo4j", "postgres"]
    assert "Graph migration run (target=neo4j):" in captured.out
    assert captured.err.strip() == (
        f"Graph migration teardown FAILED: {migration_cli.TEARDOWN_ERROR}"
    )
    for sentinel in (neo4j_sentinel, postgres_sentinel):
        assert sentinel not in captured.out
        assert sentinel not in captured.err


@pytest.mark.parametrize("args", [[], ["--dry-run"], ["--status"]])
async def test_cli_operational_failures_are_fixed_redacted_and_close_resources(
    monkeypatch,
    capsys,
    args,
):
    from scripts import run_graph_migrations as migration_cli

    sentinel = "SENTINEL_GRAPH_OPERATION_SECRET"

    class Resource:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    neo4j_driver = Resource()
    pg_conn = Resource()

    async def open_postgres():
        return pg_conn

    async def open_neo4j():
        return neo4j_driver

    def fail_operation(*_args, **_kwargs):
        raise RuntimeError(f"operation leaked {sentinel}")

    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py", *args])
    monkeypatch.setattr(migration_cli, "pg_connection_from_env", open_postgres)
    monkeypatch.setattr(migration_cli, "neo4j_driver_from_env", open_neo4j)
    if args == ["--status"]:
        monkeypatch.setattr(migration_cli, "ensure_tracking_table", fail_operation)
    else:
        monkeypatch.setattr(migration_cli, "run_migrations", fail_operation)

    escaped_error = None
    try:
        result = await migration_cli.main()
    except BaseException as error:  # regression guard: operations must never escape main
        escaped_error = error
        result = None
    captured = capsys.readouterr()

    assert escaped_error is None
    assert result == 1
    assert pg_conn.close_calls == 1
    assert neo4j_driver.close_calls == (0 if args == ["--status"] else 1)
    assert captured.err.strip() == (
        f"Graph migration operation FAILED: {migration_cli.OPERATION_ERROR}"
    )
    escaped_outputs = []
    if escaped_error is not None:
        escaped_outputs.extend(
            [
                str(escaped_error),
                repr(escaped_error),
                "".join(
                    traceback.format_exception(
                        type(escaped_error),
                        escaped_error,
                        escaped_error.__traceback__,
                    )
                ),
            ]
        )
    for output in [captured.out, captured.err, *escaped_outputs]:
        assert sentinel not in output


async def test_client_factories_receive_resolved_values_before_construction(monkeypatch):
    import neo4j
    import psycopg

    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("NEO4J_URI", "bolt://graph.invalid:7687")
    monkeypatch.setenv("NEO4J_USER", "resolved-user")
    monkeypatch.setenv("NEO4J_PASSWORD", "resolved-password")
    monkeypatch.setenv("DATABASE_ADMIN_URL", "postgresql://resolved.invalid/db")
    reset_secrets_for_tests()
    graph_calls = []
    postgres_calls = []
    fake_driver = object()
    fake_connection = object()

    def graph_factory(uri, *, auth):
        graph_calls.append((uri, auth))
        return fake_driver

    def postgres_factory(url):
        postgres_calls.append(url)
        return fake_connection

    monkeypatch.setattr(neo4j.GraphDatabase, "driver", graph_factory)
    monkeypatch.setattr(psycopg, "connect", postgres_factory)
    try:
        assert await runner.neo4j_driver_from_env() is fake_driver
        assert await runner.pg_connection_from_env() is fake_connection
        assert graph_calls == [
            ("bolt://graph.invalid:7687", ("resolved-user", "resolved-password"))
        ]
        assert postgres_calls == ["postgresql://resolved.invalid/db"]
    finally:
        reset_secrets_for_tests()


# --- Real-infra integration smoke test (skips cleanly if Neo4j/Postgres unreachable) -


@functools.lru_cache(maxsize=1)
def _infra_config() -> tuple[str, str, str, str]:
    async def resolve() -> tuple[str, str, str, str]:
        password, database_url = await asyncio.gather(
            get_secret("env://NEO4J_PASSWORD"),
            get_secret("env://DATABASE_ADMIN_URL"),
        )
        return get_config("NEO4J_URI"), get_config("NEO4J_USER"), password, database_url

    return asyncio.run(resolve())


@functools.lru_cache(maxsize=1)
def _neo4j_reachable() -> bool:
    try:
        import neo4j

        uri, user, password, _ = _infra_config()
        driver = neo4j.GraphDatabase.driver(
            uri, auth=(user, password), connection_timeout=2
        )
        try:
            driver.verify_connectivity()
            return True
        finally:
            driver.close()
    except Exception:
        return False


@functools.lru_cache(maxsize=1)
def _postgres_reachable() -> bool:
    try:
        import psycopg

        _, _, _, url = _infra_config()
        conn = psycopg.connect(url, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


pytestmark_integration = pytest.mark.skipif(
    not (_neo4j_reachable() and _postgres_reachable()),
    reason="Neo4j and/or Postgres unreachable -- skipping real-infra graph migration smoke test",
)


@pytestmark_integration
def test_real_double_apply_produces_no_duplicate_anchors_constraints_or_indexes():
    """Headline acceptance test (spec.md AC2 / Edge cases "Double / triple apply"),
    run only when a real Neo4j + Postgres are reachable. Expanded further by the
    tester stage; this proves the wiring end-to-end against live infra."""
    import neo4j
    import psycopg

    uri, user, password, database_url = _infra_config()
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
    pg_conn = psycopg.connect(database_url)

    try:
        with pg_conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS graph_migrations")
        pg_conn.commit()
        with driver.session() as session:
            session.run(
                "MATCH (n {uid: '__schema_anchor__'}) DETACH DELETE n"
            )

        # "Fresh DB, no tracking table" edge case: confirm the table really is
        # absent before the first-ever run (dropped above), and gets created by it.
        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT to_regclass('public.graph_migrations') IS NOT NULL AS exists"
            )
            assert cur.fetchone()[0] is False

        run_migrations(driver, pg_conn)

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT to_regclass('public.graph_migrations') IS NOT NULL AS exists"
            )
            assert cur.fetchone()[0] is True

        with driver.session() as session:
            node_count_1 = session.run(
                "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
            ).single()["c"]
            edge_count_1 = session.run(
                "MATCH ()-[r]->() WHERE r.org_id = '00000000-0000-0000-0000-000000000000' "
                "RETURN count(r) AS c"
            ).single()["c"]
            constraints_1 = list(session.run("SHOW CONSTRAINTS"))
            indexes_1 = list(session.run("SHOW INDEXES"))

        run_migrations(driver, pg_conn)
        run_migrations(driver, pg_conn)  # triple-apply

        with driver.session() as session:
            node_count_2 = session.run(
                "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
            ).single()["c"]
            edge_count_2 = session.run(
                "MATCH ()-[r]->() WHERE r.org_id = '00000000-0000-0000-0000-000000000000' "
                "RETURN count(r) AS c"
            ).single()["c"]
            constraints_2 = list(session.run("SHOW CONSTRAINTS"))
            indexes_2 = list(session.run("SHOW INDEXES"))

        assert node_count_1 == node_count_2 == 13
        assert edge_count_1 == edge_count_2 == 13
        assert len(constraints_1) == len(constraints_2)
        assert len(indexes_1) == len(indexes_2)

        # "Tracking table already exists" edge case: a second/third process calling
        # ensure_tracking_table (as every run_migrations call above just did via its
        # own internal call) must not error on CREATE TABLE IF NOT EXISTS.
        runner.ensure_tracking_table(pg_conn)
        runner.ensure_tracking_table(pg_conn)
    finally:
        driver.close()
        pg_conn.close()


# --- Real-infra edge cases requiring a live Neo4j + Postgres --------------------------
#
# These share one function-scoped fixture that resets both stores to a clean slate
# (drops the Postgres tracking table, deletes any schema-anchor nodes/edges) before
# each test, then hands back the live driver/connection. Constraints/indexes created
# by 003 are intentionally NOT dropped between tests -- they're global Neo4j schema
# objects and `IF NOT EXISTS` makes re-creating them across tests a no-op, which is
# itself part of what's being verified.


@pytest.fixture()
def real_infra():
    if not (_neo4j_reachable() and _postgres_reachable()):
        pytest.skip("Neo4j and/or Postgres unreachable -- skipping real-infra graph migration test")

    import neo4j
    import psycopg

    uri, user, password, database_url = _infra_config()
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
    pg_conn = psycopg.connect(database_url)

    with pg_conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS graph_migrations")
    pg_conn.commit()
    with driver.session() as session:
        session.run("MATCH (n {uid: '__schema_anchor__'}) DETACH DELETE n")

    try:
        yield driver, pg_conn
    finally:
        driver.close()
        pg_conn.close()


REAL_ORG_A = "11111111-1111-1111-1111-111111111111"
REAL_ORG_B = "22222222-2222-2222-2222-222222222222"


@pytestmark_integration
def test_real_tenant_sentinel_invisible_to_real_org_id_query(real_infra):
    """Edge case: 'Tenant-sentinel invisibility' -- a query filtered by a real
    (non-zero) org_id must return zero schema-anchor nodes/edges."""
    driver, pg_conn = real_infra
    run_migrations(driver, pg_conn)

    with driver.session() as session:
        node_count = session.run(
            "MATCH (n) WHERE n.org_id = $org RETURN count(n) AS c", org=REAL_ORG_A
        ).single()["c"]
        edge_count = session.run(
            "MATCH ()-[r]->() WHERE r.org_id = $org RETURN count(r) AS c", org=REAL_ORG_A
        ).single()["c"]

    assert node_count == 0
    assert edge_count == 0


@pytestmark_integration
def test_real_composite_uniqueness_tenant_safety(real_infra):
    """Edge case: 'Composite-uniqueness tenant safety' -- two nodes of the same label
    with the same uid but different org_id can both exist (constraint is on the pair);
    the same (org_id, uid) pair cannot duplicate (constraint rejects a second CREATE,
    and a MERGE on that pair matches the existing node instead)."""
    from neo4j.exceptions import ConstraintError

    driver, pg_conn = real_infra
    run_migrations(driver, pg_conn)  # ensures the (org_id, uid) constraint exists

    try:
        with driver.session() as session:
            session.run(
                "MATCH (n:Project {uid: 'tenant-safety-test'}) DETACH DELETE n"
            ).consume()

            # Same uid, different org_id -- both must be allowed to coexist.
            session.run(
                "CREATE (:Project {uid: 'tenant-safety-test', org_id: $org})", org=REAL_ORG_A
            ).consume()
            session.run(
                "CREATE (:Project {uid: 'tenant-safety-test', org_id: $org})", org=REAL_ORG_B
            ).consume()
            count = session.run(
                "MATCH (n:Project {uid: 'tenant-safety-test'}) RETURN count(n) AS c"
            ).single()["c"]
            assert count == 2

            # Same (org_id, uid) pair must not duplicate: a second CREATE (not MERGE)
            # is rejected outright by the uniqueness constraint.
            with pytest.raises(ConstraintError):
                session.run(
                    "CREATE (:Project {uid: 'tenant-safety-test', org_id: $org})", org=REAL_ORG_A
                ).consume()

            # A MERGE on the same (org_id, uid) pair matches the existing node instead
            # of duplicating.
            session.run(
                "MERGE (:Project {uid: 'tenant-safety-test', org_id: $org})", org=REAL_ORG_A
            ).consume()
            count_after_merge = session.run(
                "MATCH (n:Project {uid: 'tenant-safety-test'}) RETURN count(n) AS c"
            ).single()["c"]
            assert count_after_merge == 2
    finally:
        with driver.session() as session:
            session.run("MATCH (n:Project {uid: 'tenant-safety-test'}) DETACH DELETE n").consume()


@pytestmark_integration
def test_real_dry_run_mutates_neither_store(real_infra):
    """Edge case: '--dry-run' -- neither Neo4j nor Postgres is mutated."""
    driver, pg_conn = real_infra

    results = run_migrations(driver, pg_conn, dry_run=True)

    assert all(r.skipped for r in results)
    with driver.session() as session:
        anchor_count = session.run(
            "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
        ).single()["c"]
    assert anchor_count == 0

    with pg_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM graph_migrations")
        (row_count,) = cur.fetchone()
    assert row_count == 0


@pytestmark_integration
def test_real_target_neptune_skips_003_and_records_portable_migrations(real_infra):
    """Edge case: '--target neptune' skips DDL 003 but applies portable 001/002/004."""
    driver, pg_conn = real_infra

    results = run_migrations(driver, pg_conn, target="neptune")

    by_version = {r.version: r for r in results}
    assert by_version[1].skipped is False
    assert by_version[2].skipped is False
    assert by_version[3].skipped is True
    assert by_version[4].skipped is False

    with pg_conn.cursor() as cur:
        cur.execute("SELECT version FROM graph_migrations ORDER BY version")
        versions = [row[0] for row in cur.fetchall()]
    assert versions == [1, 2, 4]

    with driver.session() as session:
        anchor_count = session.run(
            "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
        ).single()["c"]
    assert anchor_count == 13  # 001 still applied


@pytestmark_integration
def test_real_partial_failure_leaves_no_tracking_row_and_clean_rerun_recovers(real_infra, tmp_path):
    """Edge case: 'Partial-failure re-run' against a genuine Neo4j syntax error (not a
    fake), proving the auto-commit-per-statement + tracking-after-all-succeed contract
    holds against the real driver: the tracking row is not written, and a subsequent
    clean re-run (bad statement removed) completes and records it, with no duplicate
    node from the already-idempotent first (successful) statement."""
    driver, pg_conn = real_infra
    mig_dir = tmp_path
    (mig_dir / "099_broken.cypher").write_text(
        "MERGE (:RealPartialFailureTestNode {uid:'x', org_id:'99'});\n"
        "THIS IS NOT VALID CYPHER AT ALL;\n"
    )

    try:
        with pytest.raises(Exception):
            run_migrations(driver, pg_conn, mig_dir)

        with pg_conn.cursor() as cur:
            cur.execute("SELECT 1 FROM graph_migrations WHERE version = 99")
            assert cur.fetchone() is None

        with driver.session() as session:
            count = session.run(
                "MATCH (n:RealPartialFailureTestNode {uid:'x', org_id:'99'}) RETURN count(n) AS c"
            ).single()["c"]
        assert count == 1, "the first (pre-failure) statement should still have run once"

        # Clean re-run: bad statement removed.
        (mig_dir / "099_broken.cypher").write_text(
            "MERGE (:RealPartialFailureTestNode {uid:'x', org_id:'99'});\n"
        )
        results = run_migrations(driver, pg_conn, mig_dir)
        applied = {r.version: r for r in results}
        assert applied[99].skipped is False

        with pg_conn.cursor() as cur:
            cur.execute("SELECT 1 FROM graph_migrations WHERE version = 99")
            assert cur.fetchone() is not None

        with driver.session() as session:
            count_after_rerun = session.run(
                "MATCH (n:RealPartialFailureTestNode {uid:'x', org_id:'99'}) RETURN count(n) AS c"
            ).single()["c"]
        assert count_after_rerun == 1, "no duplicate from the partially-run first attempt"
    finally:
        with driver.session() as session:
            session.run("MATCH (n:RealPartialFailureTestNode) DETACH DELETE n").consume()


@pytestmark_integration
def test_real_comment_and_blank_statements_are_not_sent_to_neo4j(real_infra, tmp_path):
    """Edge case: 'Empty / comment-only statement handling' against a live Neo4j -- if
    split_statements let a blank statement through, session.run("") would raise a
    real Cypher syntax error here."""
    driver, pg_conn = real_infra
    mig_dir = tmp_path
    (mig_dir / "050_comments.cypher").write_text(
        "// a leading comment-only line\n"
        "\n"
        "   ;\n"
        "MERGE (:RealCommentTestNode {uid:'y', org_id:'50'}); // trailing inline comment\n"
        "// a trailing comment-only line\n"
    )

    try:
        results = run_migrations(driver, pg_conn, mig_dir)
        assert results[0].statements_run == 1

        with driver.session() as session:
            count = session.run(
                "MATCH (n:RealCommentTestNode {uid:'y', org_id:'50'}) RETURN count(n) AS c"
            ).single()["c"]
        assert count == 1
    finally:
        with driver.session() as session:
            session.run("MATCH (n:RealCommentTestNode) DETACH DELETE n").consume()


@pytestmark_integration
def test_real_cli_status_and_dry_run_do_not_mutate(real_infra):
    """Edge case: '--status' / '--dry-run' via the actual CLI entrypoint (not just the
    library function) -- both must apply nothing and report sensibly against a fresh
    (post-fixture-reset) DB."""
    import subprocess
    import sys

    driver, pg_conn = real_infra
    workers_dir = Path(__file__).resolve().parents[1]

    status_result = subprocess.run(
        [sys.executable, "scripts/run_graph_migrations.py", "--status"],
        cwd=workers_dir,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert status_result.returncode == 0, status_result.stderr
    assert "[pending]" in status_result.stdout
    assert "[applied]" not in status_result.stdout

    with pg_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM graph_migrations")
        (row_count,) = cur.fetchone()
    assert row_count == 0, "--status must not write tracking rows"

    dry_run_result = subprocess.run(
        [sys.executable, "scripts/run_graph_migrations.py", "--dry-run"],
        cwd=workers_dir,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert dry_run_result.returncode == 0, dry_run_result.stderr

    with driver.session() as session:
        anchor_count = session.run(
            "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
        ).single()["c"]
    assert anchor_count == 0, "--dry-run must not apply anything to Neo4j"

    with pg_conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM graph_migrations")
        (row_count_after_dry_run,) = cur.fetchone()
    assert row_count_after_dry_run == 0, "--dry-run must not write tracking rows"

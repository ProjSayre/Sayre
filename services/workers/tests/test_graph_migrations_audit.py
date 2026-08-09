"""Red-stage behavioral tests for W0-02's re-derivation / audit (`.pipeline/spec.md`).

Authored by the `red` pipeline stage **before** `dev` implements anything, from
spec.md's `AC-*` / `EC-*` items alone. Every test carries a `# @spec <ID>` marker
naming the acceptance criterion or edge case it exercises.

Kept in a file of its own (rather than appended to `tests/test_graph_migrations.py`)
so the red suite's content hashes stay stable while `dev` edits the pre-existing
file. Two tiers, mirroring `tests/test_graph_migrations.py`:

1. Static / pure-function / fake-store tests that need no infrastructure.
2. Live-infra tests gated on a reachable Neo4j **and** Postgres. These are the tests
   audit finding A is about: with infra down they skip and the suite still reports
   green. AC-1's zero-skip CI gate is what stops that from being invisible, and
   `test_ci_zero_skip_gate_covers_every_graph_migration_test_file` asserts the gate
   covers *this* file too -- a gate that covered only the older file would recreate
   finding A for every test added here.
"""

from __future__ import annotations

import hashlib
import inspect
import re
import shlex
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from sayre_workers.graph_migrations import runner
from sayre_workers.graph_migrations.runner import (
    MigrationChecksumMismatchError,
    discover_migrations,
    run_migrations,
    split_statements,
)
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.ingestion.projection import stable_uid
from tests.test_graph_migrations import (
    _infra_config,
    _neo4j_reachable,
    _postgres_reachable,
)

WORKERS_DIR = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS_DIR = runner.DEFAULT_MIGRATIONS_DIR
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
SCHEMA_MD = REPO_ROOT / "packages" / "graph-schema" / "schema.md"
GRAPH_SCHEMA_RULE = REPO_ROOT / ".claude" / "rules" / "graph-schema.md"

SENTINEL_ORG = "00000000-0000-0000-0000-000000000000"

# spec.md "Affected files" -- 005 is created by this ticket.
EXPECTED_MIGRATION_FILES = frozenset(
    {
        "001_init_node_labels.cypher",
        "002_init_edge_types.cypher",
        "003_constraints_and_indexes.cypher",
        "004_test_covers_contract.cypher",
        "005_scope_identity_indexes.cypher",
    }
)
# spec.md Interfaces section 2 / AC-7.
LOGICAL_FILES = frozenset(
    {
        "001_init_node_labels.cypher",
        "002_init_edge_types.cypher",
        "004_test_covers_contract.cypher",
    }
)
PHYSICAL_FILES = frozenset(
    {"003_constraints_and_indexes.cypher", "005_scope_identity_indexes.cypher"}
)
# spec.md Interfaces section 4.
SCOPE_BEARING_LABELS = ("Folder", "File", "Function", "Class", "Test", "Feature", "EnvStep")
NON_SCOPE_LABELS = ("Project", "Repo", "Module", "Person", "Commit", "Ticket")

PYTHON_GRAPH_WRITERS = (
    "sayre_workers/ingestion/graph.py",
    "sayre_workers/enrichment/enrichment_graph.py",
    "sayre_workers/dynamic_coverage/graph.py",
)


def _read_migration(filename: str) -> str:
    return (MIGRATIONS_DIR / filename).read_text()


def _header_directive(text: str, name: str) -> str | None:
    """Read a `// <name>: <value>` machine-readable header directive (Interfaces 2)."""
    match = re.search(rf"^//\s*{name}:\s*(.+?)\s*$", text, flags=re.MULTILINE)
    return match.group(1) if match else None


def _declared_targets(text: str) -> frozenset[str]:
    raw = _header_directive(text, "Targets") or ""
    return frozenset(part.strip() for part in raw.split(",") if part.strip())


# --- CI wiring (finding A) ------------------------------------------------------------


def _workers_job() -> dict:
    return yaml.safe_load(CI_WORKFLOW.read_text())["jobs"]["workers"]


def _workers_steps() -> list[dict]:
    return _workers_job()["steps"]


def _run_of(step: dict) -> str:
    return step.get("run") or ""


def _graph_migration_junit_step(steps: list[dict]) -> dict | None:
    for step in steps:
        run = _run_of(step)
        if "pytest" in run and "--junitxml" in run and "test_graph_migrations" in run:
            return step
    return None


def _junit_path_from(run: str) -> str | None:
    match = re.search(r"--junitxml[=\s]+([\w./-]+\.xml)", run)
    return match.group(1) if match else None


def _zero_skip_gate_step(steps: list[dict], junit_path: str) -> dict | None:
    for step in steps:
        run = _run_of(step)
        if junit_path in run and "skipped" in run and "pytest" not in run:
            return step
    return None


# @spec AC-1
def test_ci_workers_job_declares_a_neo4j_service_and_passes_its_env_to_pytest():
    """The `workers` job must run a real Neo4j and hand its connection env to the
    pytest step, so `_neo4j_reachable()` is True in CI instead of False forever."""
    job = _workers_job()
    services = job.get("services") or {}

    neo4j_services = [
        (name, service)
        for name, service in services.items()
        if str(service.get("image", "")).startswith("neo4j:")
    ]
    assert neo4j_services, (
        "ci.yml jobs.workers.services declares no neo4j service -- every real-infra "
        f"graph-migration test skips in CI (finding A). Services present: {sorted(services)}"
    )
    _, neo4j_service = neo4j_services[0]
    assert "5.24-community" in str(neo4j_service["image"]), (
        f"expected the neo4j:5.24-community image, got {neo4j_service['image']!r}"
    )
    assert "--health-cmd" in str(neo4j_service.get("options", "")), (
        "the neo4j service needs a healthcheck, or pytest can start before it is ready"
    )

    required_env = {"NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"}
    full_suite_steps = [
        step for step in _workers_steps() if _run_of(step).strip() == "poetry run pytest"
    ]
    assert full_suite_steps, "expected a `poetry run pytest` full-suite step in the workers job"
    for step in full_suite_steps:
        missing = required_env - set(step.get("env") or {})
        assert not missing, (
            f"the full pytest step is missing {sorted(missing)}; without it the "
            "real-infra graph-migration tests skip even when the service is running"
        )


# @spec AC-1
def test_ci_zero_skip_gate_covers_every_graph_migration_test_file():
    """A dedicated step must fail the build when any graph-migration test skips --
    mirroring `Assert no Python broker tests skipped`. It has to cover *every*
    tests/test_graph_migrations*.py file, or finding A simply moves to the file it
    does not cover."""
    steps = _workers_steps()
    junit_step = _graph_migration_junit_step(steps)
    assert junit_step is not None, (
        "ci.yml jobs.workers has no step running the graph-migration tests with "
        "--junitxml; there is nothing for a zero-skip gate to inspect (finding A)"
    )

    run = _run_of(junit_step)
    junit_path = _junit_path_from(run)
    assert junit_path, f"could not read a --junitxml path out of: {run!r}"

    graph_test_files = sorted(p.name for p in TESTS_DIR.glob("test_graph_migrations*.py"))
    assert graph_test_files, "expected at least one tests/test_graph_migrations*.py file"
    for name in graph_test_files:
        assert f"tests/{name}" in run, (
            f"the zero-skip pytest invocation does not include tests/{name}; any test "
            "in that file could skip in CI unnoticed, which is finding A again"
        )

    gate_step = _zero_skip_gate_step(steps, junit_path)
    assert gate_step is not None, (
        f"no step asserts zero skips against {junit_path}; a junit file nobody checks "
        "is not a gate"
    )


# @spec EC-16
def test_ci_zero_skip_gate_actually_fails_when_a_test_is_skipped(tmp_path: Path):
    """A gate that cannot fail is finding A again. Run the gate's own command against
    a junit report containing a skip and require a non-zero exit, then against a clean
    report and require success."""
    steps = _workers_steps()
    junit_step = _graph_migration_junit_step(steps)
    assert junit_step is not None, (
        "no graph-migration --junitxml step exists yet, so its zero-skip gate cannot "
        "be self-tested (see AC-1)"
    )
    junit_path = _junit_path_from(_run_of(junit_step))
    assert junit_path
    gate_step = _zero_skip_gate_step(steps, junit_path)
    assert gate_step is not None, f"no zero-skip gate step found for {junit_path}"

    command = re.sub(r"^python\b", shlex.quote(sys.executable), _run_of(gate_step).strip())
    report = tmp_path / junit_path
    report.parent.mkdir(parents=True, exist_ok=True)

    report.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="1" '
        'tests="2"><testcase classname="t" name="ran"/>'
        '<testcase classname="t" name="skipped_one"><skipped type="pytest.skip"/>'
        "</testcase></testsuite></testsuites>\n"
    )
    skipped_result = subprocess.run(
        command, shell=True, cwd=tmp_path, capture_output=True, text=True, timeout=60
    )
    assert skipped_result.returncode != 0, (
        "the zero-skip gate passed against a junit report containing a skipped test -- "
        f"it can never fail. stdout={skipped_result.stdout!r} stderr={skipped_result.stderr!r}"
    )

    report.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" '
        'tests="1"><testcase classname="t" name="ran"/></testsuite></testsuites>\n'
    )
    clean_result = subprocess.run(
        command, shell=True, cwd=tmp_path, capture_output=True, text=True, timeout=60
    )
    assert clean_result.returncode == 0, (
        "the zero-skip gate failed against a clean junit report -- it would block every "
        f"green build. stdout={clean_result.stdout!r} stderr={clean_result.stderr!r}"
    )


# --- Migration-set contract (findings B, C, F) ----------------------------------------


# @spec AC-3
def test_no_migration_statement_writes_a_source_property_on_covers():
    """002 and 004 must agree on the COVERS contract: `source` survives only inside
    004's pre-existing legacy migration -- its `REMOVE r.source` statement, and the
    `SET r.status = CASE r.source ...` statement immediately before it, which READS
    (never writes) the legacy property to derive `status` before removing it. Neither
    is a *write* of a `source` property, which is the actual invariant AC-3 states
    ("No .cypher file writes a source property on a COVERS relationship"); 002's
    anchor carries `status` instead (finding B). [Dev-stage note: the original form of
    this assertion required every `source`-referencing statement in 004 to literally
    contain `REMOVE r.source`, which does not hold for 004's SET/CASE statement -- a
    legitimate pre-existing read, not a new write, and 004 is out of this ticket's
    scope to change. Narrowed to the two specific statements 004 actually has, per
    dev.md's "spec was wrong" allowance; the regression guard for finding B (any
    *write* of `source`, anywhere, including a new anchor property map) is unchanged.]
    """
    for path in sorted(MIGRATIONS_DIR.glob("*.cypher")):
        for statement in split_statements(path.read_text()):
            if "source" not in statement:
                continue
            assert path.name == "004_test_covers_contract.cypher", (
                f"{path.name} still references a COVERS `source` property, which "
                f"004 removes: {statement!r}"
            )
            allowed = "REMOVE r.source" in statement or "CASE r.source" in statement
            assert allowed, (
                "004 may only reference `source` in its legacy-migration READ "
                f"(`CASE r.source`) or its REMOVE statement: {statement!r}"
            )

    covers_statements = [
        statement
        for statement in split_statements(_read_migration("002_init_edge_types.cypher"))
        if ":COVERS" in statement
    ]
    assert len(covers_statements) == 1, (
        f"expected exactly one COVERS anchor statement in 002, got {len(covers_statements)}"
    )
    anchor = covers_statements[0]
    assert re.search(r"status:\s*'inferred'", anchor), (
        f"002's COVERS anchor must carry the post-004 `status:'inferred'` property: {anchor!r}"
    )


# @spec AC-12
def test_migration_set_is_exactly_five_files_and_stays_opencypher_pure():
    """The closed 13-label / 13-edge sets and the openCypher purity guards must still
    hold once 005 joins the set."""
    names = {path.name for path in MIGRATIONS_DIR.glob("*.cypher")}
    assert names == set(EXPECTED_MIGRATION_FILES), (
        f"unexpected migration set: {sorted(names)}"
    )

    for name in sorted(names):
        text = _read_migration(name)
        assert "apoc." not in text, f"{name} must not use APOC (openCypher only)"
        assert "CALL db." not in text, f"{name} must not call db.* procedures"

    for name in sorted(LOGICAL_FILES):
        for statement in split_statements(_read_migration(name)):
            keyword = statement.strip().split(None, 1)[0].upper()
            assert keyword in ("MERGE", "MATCH"), (
                f"{name} statement does not start with MERGE/MATCH: {statement!r}"
            )

    rules = GRAPH_SCHEMA_RULE.read_text()
    label_match = re.search(r"Node labels are fixed:\s*([^.]+)\.", rules)
    edge_match = re.search(r"the edge list \(([^)]+)\)", rules)
    assert label_match and edge_match, "could not read the closed sets out of the rule file"
    rule_labels = {part.strip() for part in label_match.group(1).split(",")}
    rule_edges = {part.strip() for part in edge_match.group(1).split(",")}
    assert len(rule_labels) == 13 and len(rule_edges) == 13

    declared_labels = set(
        re.findall(r"MERGE\s*\(:(\w+)\s*\{", _read_migration("001_init_node_labels.cypher"))
    )
    declared_edges = set(
        re.findall(r"\[:(\w+)\s*\{", _read_migration("002_init_edge_types.cypher"))
    )
    assert declared_labels == rule_labels
    assert declared_edges == rule_edges


# @spec AC-6
def test_layer_and_targets_come_from_file_headers_not_a_hardcoded_version_set():
    assert not hasattr(runner, "NEPTUNE_INCOMPATIBLE_VERSIONS"), (
        "NEPTUNE_INCOMPATIBLE_VERSIONS is a hardcoded version skip list; layer/target "
        "compatibility must be declared per file (finding C2)"
    )

    for name in sorted(EXPECTED_MIGRATION_FILES):
        path = MIGRATIONS_DIR / name
        assert path.exists(), f"{name} is missing from {MIGRATIONS_DIR}"
        text = path.read_text()
        layer = _header_directive(text, "Layer")
        targets = _declared_targets(text)
        assert layer in ("logical", "physical"), (
            f"{name} must declare `// Layer: logical` or `// Layer: physical`, got {layer!r}"
        )
        assert targets, f"{name} must declare a `// Targets:` header"
        assert targets <= {"neo4j", "neptune"}, f"{name} declares unknown targets: {targets}"

    discovered = {migration.filename: migration for migration in discover_migrations()}
    for name in sorted(EXPECTED_MIGRATION_FILES):
        text = _read_migration(name)
        migration = discovered[name]
        assert getattr(migration, "layer", None) == _header_directive(text, "Layer"), (
            f"discover_migrations did not parse {name}'s Layer header onto MigrationFile.layer"
        )
        assert frozenset(getattr(migration, "targets", ())) == _declared_targets(text), (
            f"discover_migrations did not parse {name}'s Targets header onto "
            "MigrationFile.targets"
        )


# @spec EC-11 AC-6
@pytest.mark.parametrize("omit", ["Layer", "Targets"])
def test_discover_migrations_raises_naming_the_file_when_a_header_is_missing(
    tmp_path: Path, omit: str
):
    headers = {"Layer": "// Layer: logical", "Targets": "// Targets: neo4j, neptune"}
    del headers[omit]
    (tmp_path / "007_missing_header.cypher").write_text(
        "\n".join([*headers.values(), "MERGE (:Project {uid:'x', org_id:'0'});", ""])
    )

    with pytest.raises(Exception) as exc_info:
        discover_migrations(tmp_path)

    message = str(exc_info.value)
    assert "007_missing_header.cypher" in message, (
        f"the error must name the offending file, got {message!r}"
    )
    assert omit.lower() in message.lower(), (
        f"the error must name the missing `{omit}` directive, got {message!r}"
    )


# @spec AC-7
def test_physical_ddl_is_separated_from_logical_data_migrations():
    ddl_pattern = re.compile(r"\b(CREATE CONSTRAINT|CREATE INDEX)\b")

    for name in sorted(LOGICAL_FILES):
        text = _read_migration(name)
        assert _header_directive(text, "Layer") == "logical", f"{name} must declare Layer: logical"
        assert _declared_targets(text) == {"neo4j", "neptune"}, (
            f"{name} is portable and must declare Targets: neo4j, neptune"
        )
        assert not ddl_pattern.search(text), f"{name} is a logical migration and must contain no DDL"

    for name in sorted(PHYSICAL_FILES):
        text = _read_migration(name)
        assert _header_directive(text, "Layer") == "physical", (
            f"{name} must declare Layer: physical"
        )
        assert _declared_targets(text) == {"neo4j"}, (
            f"{name} is Neo4j-only DDL and must not list neptune in its Targets header"
        )
        assert ddl_pattern.search(text), f"{name} is a physical migration but declares no DDL"


# @spec AC-10
def test_005_declares_a_scope_composite_index_for_each_scope_bearing_label():
    path = MIGRATIONS_DIR / "005_scope_identity_indexes.cypher"
    assert path.exists(), (
        "005_scope_identity_indexes.cypher is missing -- every (org_id, repo_id, "
        "ref_name) match in the writers is a label scan filtered in memory (finding D2)"
    )
    text = path.read_text()

    for label in SCOPE_BEARING_LABELS:
        assert re.search(
            rf"CREATE INDEX \w+ IF NOT EXISTS\s+FOR \(n:{label}\)\s+"
            rf"ON \(n\.org_id, n\.repo_id, n\.ref_name\)",
            text,
        ), f"005 is missing the (org_id, repo_id, ref_name) index for {label}"

    for label in NON_SCOPE_LABELS:
        assert not re.search(rf"FOR \(n:{label}\)", text), (
            f"{label} carries no scope triple at runtime; an index over it is dead weight"
        )

    assert text.count("CREATE INDEX") == len(SCOPE_BEARING_LABELS)
    assert "IF NOT EXISTS" in text


# --- Tracking table reshape (finding C) -----------------------------------------------


class _RecordingCursor:
    def __init__(self, log: list[tuple[str, object]], rows: list[tuple]):
        self._log = log
        self._rows = rows

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False

    def execute(self, sql: str, params: object = None) -> None:
        self._log.append((sql, params))

    def fetchall(self) -> list[tuple]:
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _RecordingPgConn:
    """Captures the SQL the runner emits, so the tracking-table shape can be asserted
    without a live Postgres."""

    def __init__(self, rows: list[tuple] | None = None):
        self.executed: list[tuple[str, object]] = []
        self.commits = 0
        self._rows = rows or []

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self.executed, self._rows)

    def commit(self) -> None:
        self.commits += 1

    @property
    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.executed)

    @property
    def params(self) -> list[object]:
        return [params for _, params in self.executed]


# @spec AC-5 AC-11
def test_tracking_table_is_keyed_by_target_layer_version_and_stays_non_tenant():
    conn = _RecordingPgConn()

    runner.ensure_tracking_table(conn)

    sql = re.sub(r"\s+", " ", conn.sql)
    assert re.search(r"\btarget\b", sql), "graph_migrations must gain a `target` column"
    assert re.search(r"\blayer\b", sql), "graph_migrations must gain a `layer` column"
    assert re.search(r"PRIMARY KEY\s*\(\s*target\s*,\s*layer\s*,\s*version\s*\)", sql), (
        "the primary key must become (target, layer, version) -- with `version` alone as "
        f"the key a second target silently no-ops (finding C1). Emitted SQL: {sql!r}"
    )
    assert "org_id" not in sql.lower(), (
        "graph_migrations is global infra bookkeeping and must never gain an org_id column"
    )
    assert "row level security" not in sql.lower(), "graph_migrations must not gain RLS"
    assert "policy" not in sql.lower(), "graph_migrations must not gain an RLS policy"


# @spec AC-5
def test_applied_versions_and_record_applied_are_target_and_layer_aware():
    for function in (runner.applied_versions, runner.record_applied, runner.run_migrations):
        parameters = inspect.signature(function).parameters
        assert "target" in parameters, (
            f"{function.__name__} takes no `target` -- migration history cannot be "
            "tracked per graph target (finding C1)"
        )
        assert parameters["target"].kind is inspect.Parameter.KEYWORD_ONLY, (
            f"{function.__name__}'s `target` must be keyword-only per spec.md Interfaces 2"
        )

    read_conn = _RecordingPgConn(rows=[("logical", 1, "checksum-one")])
    recorded = runner.applied_versions(read_conn, target="neptune")
    assert recorded == {("logical", 1): "checksum-one"}, (
        f"applied_versions must key on (layer, version), got {recorded!r}"
    )
    assert "target" in read_conn.sql.lower(), (
        "applied_versions must filter recorded rows by target"
    )
    assert any("neptune" in str(params) for params in read_conn.params), (
        f"applied_versions never passed the target through: {read_conn.params!r}"
    )

    write_conn = _RecordingPgConn()
    migration = SimpleNamespace(
        version=5,
        filename="005_scope_identity_indexes.cypher",
        checksum="deadbeef",
        layer="physical",
        targets=frozenset({"neo4j"}),
    )
    runner.record_applied(write_conn, migration, target="neo4j")
    insert_sql = write_conn.sql.lower()
    assert "target" in insert_sql and "layer" in insert_sql, (
        f"record_applied must persist target and layer: {write_conn.sql!r}"
    )
    flat_params = str(write_conn.params)
    assert "neo4j" in flat_params and "physical" in flat_params, (
        f"record_applied did not bind the target/layer values: {write_conn.params!r}"
    )


class _RecordingDriver:
    """Neo4j driver stand-in that records every statement handed to session.run()."""

    def __init__(self, *, fail_on_statement: str | None = None):
        self.calls: list[str] = []
        self._fail_on_statement = fail_on_statement

    class _Session:
        def __init__(self, driver: "_RecordingDriver"):
            self._driver = driver

        def __enter__(self) -> "_RecordingDriver._Session":
            return self

        def __exit__(self, *exc_info) -> bool:
            return False

        def run(self, statement: str) -> None:
            fail_on = self._driver._fail_on_statement
            if fail_on is not None and fail_on in statement:
                raise RuntimeError(f"simulated failure on statement: {statement!r}")
            self._driver.calls.append(statement)

    def session(self) -> "_RecordingDriver._Session":
        return _RecordingDriver._Session(self)


class _FakeTrackingStore:
    """In-memory tracking table keyed the way spec.md Interfaces 1 requires:
    (target, layer, version) -> (filename, checksum)."""

    def __init__(self) -> None:
        self.table_ensured = False
        self.rows: dict[tuple[str, str | None, int], tuple[str, str]] = {}

    def keys_for(self, target: str) -> set[tuple[str | None, int]]:
        return {(layer, version) for (t, layer, version) in self.rows if t == target}


@pytest.fixture
def fake_tracking_store(monkeypatch) -> _FakeTrackingStore:
    """Patches the three tracking-table helpers with target/layer-aware fakes. The
    keyword defaults keep the fakes callable by a not-yet-target-aware runner, so a
    failure surfaces as an assertion about behaviour rather than a TypeError."""
    store = _FakeTrackingStore()

    def fake_ensure_tracking_table(pg_conn: _FakeTrackingStore) -> None:
        pg_conn.table_ensured = True

    def fake_applied_versions(
        pg_conn: _FakeTrackingStore, *, target: str = "neo4j"
    ) -> dict[tuple[str | None, int], str]:
        return {
            (layer, version): checksum
            for (row_target, layer, version), (_filename, checksum) in pg_conn.rows.items()
            if row_target == target
        }

    def fake_record_applied(
        pg_conn: _FakeTrackingStore, migration, *, target: str = "neo4j"
    ) -> None:
        layer = getattr(migration, "layer", None)
        pg_conn.rows[(target, layer, migration.version)] = (
            migration.filename,
            migration.checksum,
        )

    monkeypatch.setattr(runner, "ensure_tracking_table", fake_ensure_tracking_table)
    monkeypatch.setattr(runner, "applied_versions", fake_applied_versions)
    monkeypatch.setattr(runner, "record_applied", fake_record_applied)
    return store


# @spec AC-5
def test_a_second_target_run_applies_the_logical_files_instead_of_reporting_all_skipped(
    fake_tracking_store,
):
    """Finding C1: with `version` as the sole key, `--target neptune` after a completed
    `--target neo4j` run reports everything already applied and sends Neptune nothing."""
    driver = _RecordingDriver()

    neo4j_results = run_migrations(driver, fake_tracking_store, target="neo4j")
    assert all(not result.skipped for result in neo4j_results)

    neptune_driver = _RecordingDriver()
    neptune_results = run_migrations(neptune_driver, fake_tracking_store, target="neptune")

    assert fake_tracking_store.keys_for("neptune") == {
        ("logical", 1),
        ("logical", 2),
        ("logical", 4),
    }, (
        "neptune history must record exactly the logical files applied to it; got "
        f"{sorted(fake_tracking_store.keys_for('neptune'))!r}. An empty set means the "
        "second-target run reported everything already applied (finding C1)"
    )
    assert fake_tracking_store.keys_for("neo4j") == {
        ("logical", 1),
        ("logical", 2),
        ("physical", 3),
        ("logical", 4),
        ("physical", 5),
    }
    assert neptune_driver.calls, "nothing at all was sent to the neptune target"

    by_version = {result.version: result for result in neptune_results}
    for version in (1, 2, 4):
        assert by_version[version].skipped is False, (
            f"logical migration {version} was reported as already applied against the "
            "neptune target, but it has only ever been applied to neo4j (finding C1)"
        )
    for version in (3, 5):
        assert by_version[version].skipped is True, (
            f"physical migration {version} is Neo4j-only and must be skipped for neptune"
        )


# @spec AC-14
def test_checksum_protection_still_fires_under_the_layer_target_tracking_model(
    fake_tracking_store, tmp_path: Path
):
    """The 002 edit is expected to trip MigrationChecksumMismatchError for existing
    installs; the reshape must not weaken that check into silence."""
    migration = tmp_path / "001_seed.cypher"
    migration.write_text(
        "// Layer: logical\n// Targets: neo4j, neptune\nMERGE (:Project {uid:'x', org_id:'0'});\n"
    )
    driver = _RecordingDriver()

    run_migrations(driver, fake_tracking_store, tmp_path)
    assert fake_tracking_store.keys_for("neo4j") == {("logical", 1)}

    migration.write_text(
        "// Layer: logical\n// Targets: neo4j, neptune\nMERGE (:Project {uid:'y', org_id:'0'});\n"
    )

    with pytest.raises(MigrationChecksumMismatchError):
        run_migrations(driver, fake_tracking_store, tmp_path)


# @spec EC-7
def test_targets_is_a_declared_set_and_an_unknown_target_raises_value_error(
    fake_tracking_store,
):
    assert hasattr(runner, "TARGETS"), (
        "runner must declare TARGETS = ('neo4j', 'neptune') per spec.md Interfaces 2"
    )
    assert tuple(runner.TARGETS) == ("neo4j", "neptune")

    with pytest.raises(ValueError):
        run_migrations(_RecordingDriver(), fake_tracking_store, target="bogus")


# @spec EC-8
def test_discovery_sorts_numerically_across_gaps_and_parses_layer_and_targets(tmp_path: Path):
    logical_header = "// Layer: logical\n// Targets: neo4j, neptune\n"
    physical_header = "// Layer: physical\n// Targets: neo4j\n"
    (tmp_path / "002_second.cypher").write_text(logical_header + "MERGE (:A {uid:'x'});")
    (tmp_path / "010_tenth.cypher").write_text(physical_header + "CREATE INDEX a IF NOT EXISTS;")
    (tmp_path / "009_ninth.cypher").write_text(logical_header + "MERGE (:C {uid:'x'});")

    migrations = discover_migrations(tmp_path)

    assert [migration.version for migration in migrations] == [2, 9, 10]
    layers = {migration.filename: getattr(migration, "layer", None) for migration in migrations}
    targets = {
        migration.filename: frozenset(getattr(migration, "targets", ()))
        for migration in migrations
    }
    assert layers == {
        "002_second.cypher": "logical",
        "009_ninth.cypher": "logical",
        "010_tenth.cypher": "physical",
    }
    assert targets == {
        "002_second.cypher": frozenset({"neo4j", "neptune"}),
        "009_ninth.cypher": frozenset({"neo4j", "neptune"}),
        "010_tenth.cypher": frozenset({"neo4j"}),
    }


# @spec EC-10
def test_header_directives_never_leak_into_the_statement_stream(tmp_path: Path):
    (tmp_path / "011_directives.cypher").write_text(
        "// 011_directives.cypher\n"
        "// Layer: logical\n"
        "// Targets: neo4j, neptune\n"
        "// Neptune-replayable: YES\n"
        "\n"
        "   ;\n"
        "MERGE (:Project {uid:'z', org_id:'0'}); // trailing comment\n"
        "// trailing comment-only line\n"
    )

    [migration] = discover_migrations(tmp_path)

    assert migration.statements == ["MERGE (:Project {uid:'z', org_id:'0'})"]
    for statement in migration.statements:
        assert "Layer:" not in statement and "Targets:" not in statement
    assert getattr(migration, "layer", None) == "logical", (
        "the directives must be consumed as metadata, not merely stripped as comments"
    )
    assert frozenset(getattr(migration, "targets", ())) == frozenset({"neo4j", "neptune"})


# @spec EC-6
@pytest.mark.parametrize("cli_args", [["--status"], ["--dry-run"]])
def test_cli_status_and_dry_run_report_layer_and_target_and_mutate_nothing(
    monkeypatch, capsys, fake_tracking_store, cli_args
):
    from scripts import run_graph_migrations as migration_cli

    driver = _RecordingDriver()

    async def open_postgres():
        return fake_tracking_store

    async def open_neo4j():
        return driver

    monkeypatch.setattr(sys, "argv", ["run_graph_migrations.py", *cli_args])
    monkeypatch.setattr(migration_cli, "pg_connection_from_env", open_postgres)
    monkeypatch.setattr(migration_cli, "neo4j_driver_from_env", open_neo4j)
    monkeypatch.setattr(migration_cli, "ensure_tracking_table", lambda conn, **kwargs: None)
    monkeypatch.setattr(migration_cli, "applied_versions", lambda conn, **kwargs: {})
    monkeypatch.setattr(fake_tracking_store, "close", lambda: None, raising=False)
    monkeypatch.setattr(driver, "close", lambda: None, raising=False)

    import asyncio

    result = asyncio.run(migration_cli.main())
    captured = capsys.readouterr()

    assert result == 0, f"CLI {cli_args} failed: {captured.err!r}"
    assert driver.calls == [], f"{cli_args} must send no Cypher to Neo4j"
    assert fake_tracking_store.rows == {}, f"{cli_args} must write no tracking rows"

    for migration in discover_migrations():
        lines = [line for line in captured.out.splitlines() if migration.filename in line]
        assert lines, f"{cli_args} printed no line for {migration.filename}"
        for line in lines:
            assert "layer=" in line, (
                f"{cli_args} output must name each file's layer, got {line!r}"
            )
            assert "target=" in line, (
                f"{cli_args} output must name each file's target, got {line!r}"
            )


# @spec EC-15
def test_split_statements_does_not_silently_corrupt_a_string_literal(tmp_path: Path):
    """finding F4 / O-7: a `//` or `;` inside a string literal currently splits a
    statement in half with no error. Either it is handled correctly or it fails
    loudly -- silent corruption is not an acceptable third option."""
    statement = "MERGE (:Repo {org_id:'0', uid:'r', url:'https://example.com/a;b'})"

    try:
        parsed = split_statements(statement + ";")
    except Exception:
        return  # failing loudly is an acceptable outcome per EC-15

    assert parsed == [statement], (
        "split_statements silently corrupted a statement containing '//' and ';' inside "
        f"a string literal: {parsed!r}"
    )


# --- Identity contract (finding D) ----------------------------------------------------


# @spec AC-8
def test_schema_md_documents_the_uid_derivation_and_it_matches_stable_uid():
    text = SCHEMA_MD.read_text()

    for prop in ("repo_id", "ref_name", "revision_sha"):
        assert prop in text, (
            f"schema.md never documents `{prop}`, which every real node carries "
            "(finding D1)"
        )

    match = re.search(r"uid\s*=\s*sha256\(([^)]*)\)", text)
    assert match, (
        "schema.md must document the uid derivation as `uid = sha256(...)` so the doc "
        "cannot drift from sayre_workers.ingestion.projection.stable_uid (finding D)"
    )
    components = [
        component.strip().strip("`")
        for component in re.split(r"\\+0", match.group(1))
        if component.strip()
    ]
    assert components == ["repository_id", "ref_name", "label", "identity"], (
        f"documented uid components do not match stable_uid's order: {components!r}"
    )

    scope = GraphScope(
        org_id="11111111-1111-1111-1111-111111111111",
        repository_id="repo-42",
        ref_name="refs/heads/main",
        revision_sha="0" * 40,
    )
    values = {
        "repository_id": scope.repository_id,
        "ref_name": scope.ref_name,
        "label": "File",
        "identity": "src/app/index.ts",
    }
    expected = hashlib.sha256(
        "\0".join(values[component] for component in components).encode("utf-8")
    ).hexdigest()
    assert stable_uid(scope, "File", "src/app/index.ts") == expected, (
        "the derivation documented in schema.md does not reproduce stable_uid's digest"
    )

    assert re.search(r"qualified_name", text), (
        "schema.md must document the Function/Class identity form "
        "(`<file_path>\\0<qualified_name>`)"
    )


# @spec AC-13
def test_schema_md_cites_nothing_transient_and_documents_every_property_the_writers_set():
    text = SCHEMA_MD.read_text()

    assert ".pipeline/" not in text, (
        "schema.md cites `.pipeline/spec.md`, which is transient per-run working state "
        "(finding F7) -- cite `.sdd/ledger/` or `docs/` instead"
    )

    written: set[str] = set()
    for relative in PYTHON_GRAPH_WRITERS:
        source = (WORKERS_DIR / relative).read_text()
        written |= set(re.findall(r"\b(?:SET|,)\s+\w+\.(\w+)\s*=", source))

    assert {"repo_id", "ref_name", "revision_sha"} <= written, (
        "the scope triple should be written by the graph writers; re-check the "
        f"extraction, got {sorted(written)!r}"
    )
    undocumented = sorted(prop for prop in written if prop not in text)
    assert not undocumented, (
        "schema.md is missing properties the Python graph writers actually set: "
        f"{undocumented}"
    )


# --- Live-infra tier: RED-DEFERRED without a reachable Neo4j + Postgres ---------------
#
# Everything below needs `infra/docker-compose.yml`'s `neo4j` + `postgres` services up.
# They are the tests audit finding A is about, and AC-1's zero-skip CI gate is what
# keeps them from skipping unnoticed once CI declares a Neo4j service.

LIVE_INFRA_SKIP_REASON = (
    "Neo4j and/or Postgres unreachable -- W0-02 real-infra graph migration test"
)
REAL_ORG_A = "11111111-1111-1111-1111-111111111111"
REAL_ORG_B = "22222222-2222-2222-2222-222222222222"


def _reset_both_stores(driver, pg_conn) -> None:
    with pg_conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS graph_migrations")
    pg_conn.commit()
    with driver.session() as session:
        session.run("MATCH (n {uid: '__schema_anchor__'}) DETACH DELETE n")


def _drop_tracker_only(pg_conn) -> None:
    with pg_conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS graph_migrations")
    pg_conn.commit()


def _anchor_counts(driver) -> tuple[int, int, int]:
    with driver.session() as session:
        nodes = session.run(
            "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
        ).single()["c"]
        edges = session.run(
            "MATCH ()-[r]->() WHERE r.org_id = $org RETURN count(r) AS c", org=SENTINEL_ORG
        ).single()["c"]
        covers = session.run(
            "MATCH (:Test {uid: '__schema_anchor__'})-[r:COVERS]->"
            "(:File {uid: '__schema_anchor__'}) WHERE r.org_id = $org RETURN count(r) AS c",
            org=SENTINEL_ORG,
        ).single()["c"]
    return nodes, edges, covers


def _schema_object_counts(driver) -> tuple[int, int]:
    with driver.session() as session:
        constraints = len(list(session.run("SHOW CONSTRAINTS")))
        indexes = len(list(session.run("SHOW INDEXES")))
    return constraints, indexes


@pytest.fixture()
def live_stores():
    if not (_neo4j_reachable() and _postgres_reachable()):
        pytest.skip(LIVE_INFRA_SKIP_REASON)

    import neo4j
    import psycopg

    uri, user, password, database_url = _infra_config()
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))
    pg_conn = psycopg.connect(database_url)
    try:
        yield driver, pg_conn
    finally:
        driver.close()
        pg_conn.close()


# @spec AC-2 EC-1
def test_real_rerun_with_an_emptied_tracker_creates_no_duplicate_anchors(live_stores):
    """Finding B: the tracker lives in Postgres, the anchors live in Neo4j, and nothing
    reconciles them. Drop the tracker *without* deleting the anchors and re-run: 002's
    COVERS anchor must still match post-004's property map rather than creating a
    second edge."""
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    run_migrations(driver, pg_conn)
    nodes_before, edges_before, covers_before = _anchor_counts(driver)
    constraints_before, indexes_before = _schema_object_counts(driver)
    assert (nodes_before, edges_before, covers_before) == (13, 13, 1)

    _drop_tracker_only(pg_conn)
    run_migrations(driver, pg_conn)

    nodes_after, edges_after, covers_after = _anchor_counts(driver)
    constraints_after, indexes_after = _schema_object_counts(driver)
    assert covers_after == 1, (
        f"re-running against a post-004 graph created {covers_after} COVERS anchor edges"
    )
    assert (nodes_after, edges_after) == (13, 13)
    assert (constraints_after, indexes_after) == (constraints_before, indexes_before)


# @spec AC-4
def test_real_double_and_triple_apply_with_the_tracker_intact_is_a_noop(live_stores):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    run_migrations(driver, pg_conn)
    counts_1 = _anchor_counts(driver)
    schema_1 = _schema_object_counts(driver)

    second = run_migrations(driver, pg_conn)
    third = run_migrations(driver, pg_conn)

    assert all(result.skipped for result in second)
    assert all(result.skipped for result in third)
    assert _anchor_counts(driver) == counts_1 == (13, 13, 1)
    assert _schema_object_counts(driver) == schema_1


# @spec AC-5 EC-4
def test_real_migration_history_is_recorded_per_target_and_layer(live_stores):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    run_migrations(driver, pg_conn, target="neo4j")
    run_migrations(driver, pg_conn, target="neptune")

    with pg_conn.cursor() as cur:
        cur.execute("SELECT target, layer, version FROM graph_migrations ORDER BY target, version")
        rows = {(target, layer, version) for target, layer, version in cur.fetchall()}

    assert ("neo4j", "physical", 3) in rows
    assert ("neo4j", "physical", 5) in rows
    for version in (1, 2, 4):
        assert ("neo4j", "logical", version) in rows
        assert ("neptune", "logical", version) in rows, (
            "the logical files were never recorded against the neptune target -- the "
            "second-target run silently no-opped (finding C1)"
        )
    assert not any(target == "neptune" and layer == "physical" for target, layer, _ in rows)

    # EC-4: the same version number in two layers must both be recordable.
    with pg_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO graph_migrations (target, layer, version, filename, checksum) "
            "VALUES ('neo4j', 'logical', 907, '907_l.cypher', 'a'), "
            "       ('neo4j', 'physical', 907, '907_p.cypher', 'b')"
        )
        pg_conn.commit()
        cur.execute("SELECT count(*) FROM graph_migrations WHERE version = 907")
        (count,) = cur.fetchone()
    assert count == 2, "(target, layer, version) is not the real primary key"


# @spec AC-9
def test_real_covers_edge_is_created_only_when_both_endpoints_share_scope(live_stores):
    """The writer shape from `dynamic_coverage/graph.py` matches both endpoints on the
    full (org_id, repo_id, ref_name, revision_sha) tuple before MERGEing COVERS."""
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)
    run_migrations(driver, pg_conn)

    writer_source = (WORKERS_DIR / "sayre_workers/dynamic_coverage/graph.py").read_text()
    assert "MERGE (test)-[coverage:COVERS {org_id: $org_id}]->(file)" in writer_source, (
        "the COVERS writer shape changed; re-derive this test from the writer"
    )

    covers_writer_cypher = """
    MATCH (test:Test {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                      revision_sha: $revision_sha, uid: $test_uid})
    MATCH (file:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                      revision_sha: $revision_sha, path: $file_path})
    MERGE (test)-[coverage:COVERS {org_id: $org_id}]->(file)
    SET coverage.repo_id = $repo_id,
        coverage.ref_name = $ref_name,
        coverage.revision_sha = $revision_sha,
        coverage.status = 'measured'
    """
    scope = {
        "org_id": REAL_ORG_A,
        "repo_id": "repo-scope-test",
        "ref_name": "refs/heads/main",
        "revision_sha": "a" * 40,
    }

    try:
        with driver.session() as session:
            session.run(
                "CREATE (:Test {org_id:$org_id, uid:'covers-scope-test', repo_id:$repo_id, "
                "ref_name:$ref_name, revision_sha:$revision_sha, path:'t/a_test.py', "
                "name:'a', coverage_status:'unknown'})",
                **scope,
            ).consume()
            session.run(
                "CREATE (:File {org_id:$org_id, uid:'covers-scope-file', repo_id:$repo_id, "
                "ref_name:$ref_name, revision_sha:$revision_sha, path:'src/a.py', name:'a.py'})",
                **scope,
            ).consume()

            session.run(
                covers_writer_cypher,
                test_uid="covers-scope-test",
                file_path="src/a.py",
                **scope,
            ).consume()
            same_scope = session.run(
                "MATCH (:Test {uid:'covers-scope-test'})-[r:COVERS]->"
                "(:File {uid:'covers-scope-file'}) RETURN count(r) AS c"
            ).single()["c"]
            assert same_scope == 1, "no COVERS edge was created for a same-scope Test/File pair"

            # A File on a different ref must not be reachable by the same writer shape.
            session.run(
                "CREATE (:File {org_id:$org_id, uid:'covers-other-ref-file', repo_id:$repo_id, "
                "ref_name:'refs/heads/other', revision_sha:$revision_sha, path:'src/b.py', "
                "name:'b.py'})",
                **scope,
            ).consume()
            session.run(
                covers_writer_cypher,
                test_uid="covers-scope-test",
                file_path="src/b.py",
                **scope,
            ).consume()
            cross_scope = session.run(
                "MATCH ()-[r:COVERS]->(:File {uid:'covers-other-ref-file'}) RETURN count(r) AS c"
            ).single()["c"]
            assert cross_scope == 0, (
                "a COVERS edge was created across differing ref_name scope"
            )
    finally:
        with driver.session() as session:
            session.run(
                "MATCH (n) WHERE n.uid IN ['covers-scope-test', 'covers-scope-file', "
                "'covers-other-ref-file'] DETACH DELETE n"
            ).consume()


# @spec AC-10 EC-14
def test_real_scope_indexes_exist_after_a_full_run_and_005_does_not_conflict_with_003(
    live_stores,
):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    run_migrations(driver, pg_conn)
    with driver.session() as session:
        rows = [record.data() for record in session.run("SHOW INDEXES")]

    scope_triple = ["org_id", "repo_id", "ref_name"]
    for label in SCOPE_BEARING_LABELS:
        matching = [
            row
            for row in rows
            if label in (row.get("labelsOrTypes") or [])
            and (row.get("properties") or []) == scope_triple
        ]
        assert matching, f"no (org_id, repo_id, ref_name) index present for {label}"

    # EC-14: replaying 005 over an existing 003 index set must not error.
    _drop_tracker_only(pg_conn)
    run_migrations(driver, pg_conn)
    with driver.session() as session:
        rows_after = [record.data() for record in session.run("SHOW INDEXES")]
    assert len(rows_after) == len(rows)


# @spec EC-2
def test_real_reverse_desync_reports_all_skipped_and_status_shows_it(live_stores):
    """Tracker rows present, graph wiped: current behaviour is a healthy-looking no-op
    against an empty graph. Assert it (O-5 decides whether to detect it)."""
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)
    run_migrations(driver, pg_conn)

    with driver.session() as session:
        session.run("MATCH (n {uid: '__schema_anchor__'}) DETACH DELETE n").consume()

    results = run_migrations(driver, pg_conn)
    assert all(result.skipped for result in results)
    nodes, _edges, _covers = _anchor_counts(driver)
    assert nodes == 0, "the runner unexpectedly rebuilt the anchors"

    status = subprocess.run(
        [sys.executable, "scripts/run_graph_migrations.py", "--status"],
        cwd=WORKERS_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert status.returncode == 0, status.stderr
    assert "[applied]" in status.stdout, (
        "--status must make the tracker's view visible even when the graph is empty"
    )
    for migration in discover_migrations():
        lines = [line for line in status.stdout.splitlines() if migration.filename in line]
        assert lines and all("layer=" in line and "target=" in line for line in lines)


# @spec EC-3
def test_real_legacy_tracking_table_is_migrated_in_place(live_stores):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE graph_migrations (
              version    integer PRIMARY KEY,
              filename   text NOT NULL,
              checksum   text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        cur.execute(
            "INSERT INTO graph_migrations (version, filename, checksum) "
            "VALUES (1, '001_init_node_labels.cypher', 'legacy-checksum')"
        )
    pg_conn.commit()

    runner.ensure_tracking_table(pg_conn)
    runner.ensure_tracking_table(pg_conn)  # second call must not error

    with pg_conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'graph_migrations'"
        )
        columns = {row[0] for row in cur.fetchall()}
        cur.execute("SELECT target, layer, version, checksum FROM graph_migrations")
        rows = cur.fetchall()

    assert {"target", "layer", "version", "filename", "checksum", "applied_at"} <= columns
    assert rows == [("neo4j", "logical", 1, "legacy-checksum")], (
        f"the legacy row was lost or mis-backfilled during the reshape: {rows!r}"
    )

    with pg_conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.attname
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'graph_migrations'::regclass AND i.indisprimary
            """
        )
        pk_columns = {row[0] for row in cur.fetchall()}
    assert pk_columns == {"target", "layer", "version"}


# @spec EC-5
def test_real_partial_failure_records_nothing_for_that_target_and_layer(live_stores, tmp_path):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)
    header = "// Layer: logical\n// Targets: neo4j, neptune\n"
    broken = tmp_path / "099_broken.cypher"
    broken.write_text(
        header
        + "MERGE (:RealPartialFailureAuditNode {uid:'x', org_id:'99'});\n"
        + "THIS IS NOT VALID CYPHER AT ALL;\n"
    )

    try:
        with pytest.raises(Exception):
            run_migrations(driver, pg_conn, tmp_path)

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM graph_migrations "
                "WHERE version = 99 AND target = 'neo4j' AND layer = 'logical'"
            )
            assert cur.fetchone() is None

        broken.write_text(header + "MERGE (:RealPartialFailureAuditNode {uid:'x', org_id:'99'});\n")
        results = run_migrations(driver, pg_conn, tmp_path)
        assert {result.version: result.skipped for result in results} == {99: False}

        with pg_conn.cursor() as cur:
            cur.execute(
                "SELECT target, layer FROM graph_migrations WHERE version = 99"
            )
            assert cur.fetchall() == [("neo4j", "logical")]

        with driver.session() as session:
            count = session.run(
                "MATCH (n:RealPartialFailureAuditNode {uid:'x', org_id:'99'}) RETURN count(n) AS c"
            ).single()["c"]
        assert count == 1, "no duplicate from the partially-run first attempt"
    finally:
        with driver.session() as session:
            session.run("MATCH (n:RealPartialFailureAuditNode) DETACH DELETE n").consume()


# @spec EC-9
def test_real_fresh_database_creates_the_new_table_shape_and_applies_all_five_files(live_stores):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)

    with pg_conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.graph_migrations') IS NOT NULL")
        assert cur.fetchone()[0] is False

    results = run_migrations(driver, pg_conn)

    assert {result.version for result in results} == {1, 2, 3, 4, 5}
    assert all(not result.skipped for result in results)
    with pg_conn.cursor() as cur:
        cur.execute("SELECT target, layer, version FROM graph_migrations ORDER BY version")
        rows = cur.fetchall()
    assert rows == [
        ("neo4j", "logical", 1),
        ("neo4j", "logical", 2),
        ("neo4j", "physical", 3),
        ("neo4j", "logical", 4),
        ("neo4j", "physical", 5),
    ]


# @spec EC-12
def test_real_schema_anchors_stay_invisible_to_a_real_org_id_query(live_stores):
    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)
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


# @spec EC-13
def test_real_composite_uniqueness_stays_tenant_safe(live_stores):
    from neo4j.exceptions import ConstraintError

    driver, pg_conn = live_stores
    _reset_both_stores(driver, pg_conn)
    run_migrations(driver, pg_conn)

    try:
        with driver.session() as session:
            session.run("MATCH (n:Project {uid: 'audit-tenant-safety'}) DETACH DELETE n").consume()
            session.run(
                "CREATE (:Project {uid: 'audit-tenant-safety', org_id: $org})", org=REAL_ORG_A
            ).consume()
            session.run(
                "CREATE (:Project {uid: 'audit-tenant-safety', org_id: $org})", org=REAL_ORG_B
            ).consume()
            assert (
                session.run(
                    "MATCH (n:Project {uid: 'audit-tenant-safety'}) RETURN count(n) AS c"
                ).single()["c"]
                == 2
            )

            with pytest.raises(ConstraintError):
                session.run(
                    "CREATE (:Project {uid: 'audit-tenant-safety', org_id: $org})", org=REAL_ORG_A
                ).consume()

            session.run(
                "MERGE (:Project {uid: 'audit-tenant-safety', org_id: $org})", org=REAL_ORG_A
            ).consume()
            assert (
                session.run(
                    "MATCH (n:Project {uid: 'audit-tenant-safety'}) RETURN count(n) AS c"
                ).single()["c"]
                == 2
            )
    finally:
        with driver.session() as session:
            session.run("MATCH (n:Project {uid: 'audit-tenant-safety'}) DETACH DELETE n").consume()

"""W4-03 dynamic coverage planning, refresh, and tenant-scope acceptance tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sys

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.dynamic_coverage import (
    CoverageMeasurement,
    CommandCoverageRunExecutor,
    CoverageNightlyJob,
    CoverageRefreshService,
    CoverageRunReport,
    CoverageRunnerError,
    CoverageTopologyEdge,
    ImpactPlan,
    InvalidCoverageReportError,
    Neo4jCoverageGraphStore,
    parse_report_envelope,
    plan_impacted_tests,
)
from sayre_workers.ingestion.models import GraphScope

NOW = datetime(2026, 7, 23, 12, tzinfo=timezone.utc)
SHA = "a" * 40


def edge(
    *,
    test_path: str = "tests/test_app.py",
    file_path: str = "src/app.py",
    status: str = "measured",
    last_run: datetime | None = NOW - timedelta(hours=1),
) -> CoverageTopologyEdge:
    return CoverageTopologyEdge(
        test_path=test_path,
        file_path=file_path,
        status=status,  # type: ignore[arg-type]
        last_run=last_run,
    )


@pytest.mark.parametrize(
    ("changed_paths", "parse_complete", "topology", "reason"),
    [
        (("package-lock.json",), True, (), "build_or_test_config_changed"),
        (("src/app.py",), False, (), "partial_parse"),
        ((), True, (), "missing_changed_paths"),
        (("src/app.py",), True, (), "missing_coverage_topology"),
        (
            ("src/app.py",),
            True,
            (edge(status="inferred", last_run=None),),
            "stale_coverage_topology",
        ),
        (
            ("src/app.py",),
            True,
            (edge(last_run=NOW - timedelta(days=8)),),
            "stale_coverage_topology",
        ),
    ],
)
def test_inconclusive_impact_analysis_falls_back_to_full_suite(
    changed_paths: tuple[str, ...],
    parse_complete: bool,
    topology: tuple[CoverageTopologyEdge, ...],
    reason: str,
) -> None:
    plan = plan_impacted_tests(
        changed_paths=changed_paths,
        parse_complete=parse_complete,
        topology=topology,
        now=NOW,
    )

    assert plan.mode == "full_suite"
    assert plan.tests == ()
    assert plan.reason == reason


def test_fresh_measured_topology_selects_only_impacted_tests() -> None:
    plan = plan_impacted_tests(
        changed_paths=("src/app.py", "tests/test_changed.py"),
        parse_complete=True,
        topology=(
            edge(test_path="tests/test_app.py"),
            edge(test_path="tests/test_app_edge.py"),
            edge(test_path="tests/test_unrelated.py", file_path="src/other.py"),
        ),
        now=NOW,
    )

    assert plan == ImpactPlan(
        mode="targeted",
        tests=(
            "tests/test_app.py",
            "tests/test_app_edge.py",
            "tests/test_changed.py",
        ),
    )


class FakeGraphStore:
    def __init__(
        self,
        topology: tuple[CoverageTopologyEdge, ...],
        *,
        apply_result: bool = True,
    ) -> None:
        self.topology = topology
        self.apply_result = apply_result
        self.loaded_scope: GraphScope | None = None
        self.reports: list[CoverageRunReport] = []

    async def load_topology(self, scope: GraphScope) -> tuple[CoverageTopologyEdge, ...]:
        self.loaded_scope = scope
        return self.topology

    async def apply_report(self, report: CoverageRunReport) -> bool:
        self.reports.append(report)
        return self.apply_result


class FakeRunner:
    def __init__(self, report: CoverageRunReport) -> None:
        self.report = report
        self.calls: list[tuple[CoverageNightlyJob, ImpactPlan]] = []

    async def run(
        self,
        job: CoverageNightlyJob,
        plan: ImpactPlan,
    ) -> CoverageRunReport:
        self.calls.append((job, plan))
        return self.report


def job(*, changed_paths: tuple[str, ...] = ("src/app.py",)) -> CoverageNightlyJob:
    return CoverageNightlyJob(
        org_id="org-1",
        repository_id="repo-1",
        ref_name="refs/heads/main",
        revision_sha=SHA,
        changed_paths=changed_paths,
        parse_complete=True,
        triggered_at=NOW,
    )


def report() -> CoverageRunReport:
    return CoverageRunReport(
        org_id="org-1",
        repository_id="repo-1",
        ref_name="refs/heads/main",
        revision_sha=SHA,
        completed_at=NOW,
        measurements=(
            CoverageMeasurement(
                test_path="tests/test_app.py",
                file_paths=("src/app.py",),
                outcome="pass",
            ),
        ),
    )


@pytest.mark.asyncio
async def test_full_suite_fallback_is_passed_to_the_isolated_runner_and_applied() -> None:
    graph = FakeGraphStore(())
    runner = FakeRunner(report())
    service = CoverageRefreshService(graph_store=graph, runner=runner)

    result = await service.run_nightly(job())

    assert runner.calls[0][1].mode == "full_suite"
    assert runner.calls[0][1].tests == ()
    assert result.status == "applied"
    assert result.measurement_count == 1
    assert graph.reports == [runner.report]


@pytest.mark.asyncio
async def test_stale_revision_report_is_a_harmless_noop() -> None:
    graph = FakeGraphStore((edge(),), apply_result=False)
    runner = FakeRunner(report())
    service = CoverageRefreshService(graph_store=graph, runner=runner)

    result = await service.run_nightly(job())

    assert result.status == "stale"
    assert result.measurement_count == 0


def test_report_envelope_uses_only_server_resolved_org() -> None:
    measured = report().model_dump(mode="json")
    measured["org_id"] = "forged-org"
    envelope = MessageEnvelope(
        org_id="server-org",
        type="coverage.report",
        source="coverage-ci",
        idempotency_key="coverage:repo-1:main:a",
        payload=measured,
    )

    parsed = parse_report_envelope(envelope)

    assert parsed.org_id == "server-org"


def test_report_rejects_noncanonical_or_duplicate_paths() -> None:
    with pytest.raises(ValueError, match="canonical"):
        CoverageMeasurement(
            test_path="../escape.py",
            file_paths=("src/app.py",),
            outcome="pass",
        )

    with pytest.raises(ValueError, match="one result"):
        CoverageRunReport(
            org_id="org-1",
            repository_id="repo-1",
            ref_name="refs/heads/main",
            revision_sha=SHA,
            completed_at=NOW,
            measurements=(
                CoverageMeasurement(
                    test_path="tests/test_app.py",
                    file_paths=("src/app.py",),
                    outcome="pass",
                ),
                CoverageMeasurement(
                    test_path="tests/test_app.py",
                    file_paths=("src/app.py",),
                    outcome="fail",
                ),
            ),
        )


@pytest.mark.asyncio
async def test_command_runner_executes_full_suite_plan_and_parses_normalized_report() -> None:
    script = (
        "import json,sys;"
        "p=json.load(sys.stdin);"
        "assert p['mode']=='full_suite' and p['tests']==[];"
        "json.dump({"
        "'org_id':p['org_id'],"
        "'repository_id':p['repository_id'],"
        "'ref_name':p['ref_name'],"
        "'revision_sha':p['revision_sha'],"
        "'completed_at':'2026-07-23T12:30:00Z',"
        "'measurements':[{'test_path':'tests/test_app.py',"
        "'file_paths':['src/app.py'],'outcome':'pass'}]},sys.stdout)"
    )
    runner = CommandCoverageRunExecutor(
        (sys.executable, "-c", script),
        timeout_seconds=10,
    )

    measured = await runner.run(
        job(),
        ImpactPlan(
            mode="full_suite",
            tests=(),
            reason="missing_coverage_topology",
        ),
    )

    assert measured.measurements[0].test_path == "tests/test_app.py"


@pytest.mark.asyncio
async def test_command_runner_failure_never_exposes_stderr() -> None:
    runner = CommandCoverageRunExecutor(
        (
            sys.executable,
            "-c",
            "import sys;sys.stderr.write('secret-token');raise SystemExit(1)",
        ),
        timeout_seconds=10,
    )

    with pytest.raises(CoverageRunnerError, match="coverage runner failed") as error:
        await runner.run(
            job(),
            ImpactPlan(
                mode="full_suite",
                tests=(),
                reason="missing_coverage_topology",
            ),
        )
    assert "secret-token" not in str(error.value)


class FakeQueryResult:
    def __init__(
        self,
        *,
        single_record: dict[str, object] | None = None,
        data_records: list[dict[str, object]] | None = None,
    ) -> None:
        self._single_record = single_record
        self._data_records = data_records or []

    async def single(self) -> dict[str, object] | None:
        return self._single_record

    async def data(self) -> list[dict[str, object]]:
        return self._data_records


class FakeCoverageTransaction:
    def __init__(
        self,
        *,
        root_exists: bool = True,
        missing_paths: set[str] | None = None,
    ) -> None:
        self.root_exists = root_exists
        self.missing_paths = missing_paths or set()
        self.calls: list[tuple[str, dict[str, object]]] = []

    async def run(self, query: str, **parameters: object) -> FakeQueryResult:
        self.calls.append((query, parameters))
        if "RETURN root.uid AS uid" in query:
            return FakeQueryResult(
                single_record={"uid": "root"} if self.root_exists else None
            )
        if "RETURN requested_path AS requested_path" in query:
            paths = parameters["file_paths"]
            assert isinstance(paths, list)
            return FakeQueryResult(
                data_records=[
                    {
                        "requested_path": path,
                        "found_path": None if path in self.missing_paths else path,
                    }
                    for path in paths
                ]
            )
        return FakeQueryResult()


class FakeCoverageSession:
    def __init__(self, transaction: FakeCoverageTransaction) -> None:
        self.transaction = transaction

    async def __aenter__(self) -> "FakeCoverageSession":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute_write(self, callback: object) -> bool:
        return await callback(self.transaction)  # type: ignore[operator]


class FakeCoverageDriver:
    def __init__(
        self,
        transaction: FakeCoverageTransaction,
        *,
        read_records: list[dict[str, object]] | None = None,
    ) -> None:
        self.transaction = transaction
        self.read_records = read_records or []
        self.read_calls: list[tuple[str, dict[str, object]]] = []

    def session(self) -> FakeCoverageSession:
        return FakeCoverageSession(self.transaction)

    async def execute_query(
        self,
        query: str,
        **parameters: object,
    ) -> tuple[list[dict[str, object]], None, None]:
        self.read_calls.append((query, parameters))
        return self.read_records, None, None


@pytest.mark.asyncio
async def test_topology_read_is_exactly_tenant_ref_and_revision_scoped() -> None:
    driver = FakeCoverageDriver(
        FakeCoverageTransaction(),
        read_records=[
            {
                "test_path": "tests/test_app.py",
                "file_path": "src/app.py",
                "status": "measured",
                "last_run": "2026-07-23T11:00:00Z",
            }
        ],
    )
    store = Neo4jCoverageGraphStore(driver)  # type: ignore[arg-type]

    topology = await store.load_topology(report().graph_scope())

    assert topology == (
        CoverageTopologyEdge(
            test_path="tests/test_app.py",
            file_path="src/app.py",
            status="measured",
            last_run=datetime(2026, 7, 23, 11, tzinfo=timezone.utc),
        ),
    )
    query, parameters = driver.read_calls[0]
    assert "root.revision_sha = $revision_sha" in query
    assert parameters == {
        "org_id": "org-1",
        "repo_id": "repo-1",
        "ref_name": "refs/heads/main",
        "revision_sha": SHA,
    }


@pytest.mark.asyncio
async def test_measured_projection_is_atomic_scoped_and_revision_guarded() -> None:
    transaction = FakeCoverageTransaction()
    store = Neo4jCoverageGraphStore(FakeCoverageDriver(transaction))  # type: ignore[arg-type]

    applied = await store.apply_report(report())

    assert applied is True
    assert transaction.calls
    assert all(
        parameters.get("org_id") == "org-1"
        for _query, parameters in transaction.calls
    )
    covers_calls = [
        parameters
        for query, parameters in transaction.calls
        if "MERGE (test)-[coverage:COVERS" in query
    ]
    projected_edges = covers_calls[0]["edges"]
    assert isinstance(projected_edges, list)
    assert len(projected_edges[0]["source_uid"]) == 64
    assert projected_edges[0]["file_path"] == "src/app.py"
    assert projected_edges[0]["status"] == "measured"
    assert projected_edges[0]["last_run"] == "2026-07-23T12:00:00+00:00"


@pytest.mark.asyncio
async def test_measured_projection_rejects_unknown_current_head_file() -> None:
    transaction = FakeCoverageTransaction(missing_paths={"src/app.py"})
    store = Neo4jCoverageGraphStore(FakeCoverageDriver(transaction))  # type: ignore[arg-type]

    with pytest.raises(InvalidCoverageReportError, match="current graph head"):
        await store.apply_report(report())

    assert not any("MERGE (test:Test" in query for query, _parameters in transaction.calls)


@pytest.mark.asyncio
async def test_measured_projection_drops_stale_revision_before_any_mutation() -> None:
    transaction = FakeCoverageTransaction(root_exists=False)
    store = Neo4jCoverageGraphStore(FakeCoverageDriver(transaction))  # type: ignore[arg-type]

    assert await store.apply_report(report()) is False
    assert len(transaction.calls) == 1

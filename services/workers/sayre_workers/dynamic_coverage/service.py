"""Service-layer orchestration for nightly planning, execution, and projection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from messaging.envelope import MessageEnvelope

from .graph import CoverageGraphStore
from .impact import ImpactPlan, plan_impacted_tests
from .models import (
    CoverageNightlyJob,
    CoverageRunReport,
    parse_nightly_envelope,
    parse_report_envelope,
)


class CoverageRunExecutor(Protocol):
    """Adapter implemented by the isolated CI runner, never by a product read path."""

    async def run(self, job: CoverageNightlyJob, plan: ImpactPlan) -> CoverageRunReport: ...


@dataclass(frozen=True)
class CoverageRefreshResult:
    status: Literal["applied", "stale"]
    plan: ImpactPlan | None
    measurement_count: int


class CoverageRefreshService:
    def __init__(
        self,
        *,
        graph_store: CoverageGraphStore,
        runner: CoverageRunExecutor,
    ) -> None:
        self._graph_store = graph_store
        self._runner = runner

    async def run_nightly(self, job: CoverageNightlyJob) -> CoverageRefreshResult:
        topology = await self._graph_store.load_topology(job.graph_scope())
        plan = plan_impacted_tests(
            changed_paths=job.changed_paths,
            parse_complete=job.parse_complete,
            topology=topology,
            now=job.triggered_at,
        )
        report = await self._runner.run(job, plan)
        if report.graph_scope() != job.graph_scope():
            raise ValueError("coverage runner returned a report for a different graph scope")
        applied = await self._graph_store.apply_report(report)
        return CoverageRefreshResult(
            status="applied" if applied else "stale",
            plan=plan,
            measurement_count=len(report.measurements) if applied else 0,
        )

    async def apply_report(self, report: CoverageRunReport) -> CoverageRefreshResult:
        applied = await self._graph_store.apply_report(report)
        return CoverageRefreshResult(
            status="applied" if applied else "stale",
            plan=None,
            measurement_count=len(report.measurements) if applied else 0,
        )

    async def handle(self, envelope: MessageEnvelope) -> CoverageRefreshResult:
        if envelope.type == "coverage.nightly":
            return await self.run_nightly(parse_nightly_envelope(envelope))
        if envelope.type == "coverage.report":
            return await self.apply_report(parse_report_envelope(envelope))
        raise ValueError("unsupported coverage message type")

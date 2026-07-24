"""Bounded adapter for an already-isolated, coverage-instrumented CI command."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Sequence

from .impact import ImpactPlan
from .models import CoverageNightlyJob, CoverageRunReport

_MAX_REPORT_BYTES = 1_048_576


class CoverageRunnerError(RuntimeError):
    """Fixed-text runner failure that never includes command output or secrets."""


class CommandCoverageRunExecutor:
    """Run a trusted adapter command without a shell and parse one normalized report.

    The command belongs in an isolated CI task/container. It receives only the
    execution plan on stdin and must emit the ``CoverageRunReport`` JSON contract on
    stdout. The graph service never reads a live repository checkout.
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        timeout_seconds: float = 7_200,
    ) -> None:
        normalized = tuple(
            part for part in command if isinstance(part, str) and part.strip()
        )
        if not normalized or len(normalized) != len(command):
            raise ValueError("coverage runner command must contain non-blank arguments")
        if (
            isinstance(timeout_seconds, bool)
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0
        ):
            raise ValueError("coverage runner timeout must be positive")
        self._command = normalized
        self._timeout_seconds = timeout_seconds

    async def run(
        self,
        job: CoverageNightlyJob,
        plan: ImpactPlan,
    ) -> CoverageRunReport:
        payload = json.dumps(
            {
                "org_id": job.org_id,
                "repository_id": job.repository_id,
                "ref_name": job.ref_name,
                "revision_sha": job.revision_sha,
                "triggered_at": job.triggered_at.isoformat(),
                "mode": plan.mode,
                "tests": list(plan.tests),
                "fallback_reason": plan.reason,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(payload),
                timeout=self._timeout_seconds,
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            raise CoverageRunnerError("coverage runner timed out") from None
        if process.returncode != 0:
            raise CoverageRunnerError("coverage runner failed")
        if len(stdout) > _MAX_REPORT_BYTES:
            raise CoverageRunnerError("coverage runner report exceeded the size limit")
        try:
            return CoverageRunReport.model_validate_json(stdout)
        except ValueError:
            raise CoverageRunnerError("coverage runner returned an invalid report") from None

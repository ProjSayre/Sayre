"""Pure, conservative impacted-test planning with a full-suite safety fallback."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import Literal

from sayre_workers.parsing.coverage import is_test_file

_FRESHNESS_WINDOW = timedelta(days=7)
_BUILD_CONFIG_NAMES = frozenset(
    {
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "pyproject.toml",
        "poetry.lock",
        "requirements.txt",
        "pytest.ini",
        "tox.ini",
        "go.mod",
        "go.sum",
        "cargo.toml",
        "cargo.lock",
        "tsconfig.json",
        "vitest.config.ts",
        "vitest.config.js",
        "jest.config.ts",
        "jest.config.js",
    }
)

FullSuiteReason = Literal[
    "build_or_test_config_changed",
    "partial_parse",
    "missing_changed_paths",
    "missing_coverage_topology",
    "stale_coverage_topology",
]


@dataclass(frozen=True)
class CoverageTopologyEdge:
    test_path: str
    file_path: str
    status: Literal["inferred", "measured"]
    last_run: datetime | None


@dataclass(frozen=True)
class ImpactPlan:
    mode: Literal["targeted", "full_suite"]
    tests: tuple[str, ...]
    reason: FullSuiteReason | None = None


def _is_build_or_test_config(path: str) -> bool:
    normalized = path.lower()
    name = PurePosixPath(normalized).name
    return (
        name in _BUILD_CONFIG_NAMES
        or normalized.startswith(".github/workflows/")
        or normalized.startswith(".circleci/")
        or normalized.startswith("build/")
        or normalized.startswith("scripts/test")
    )


def _full_suite(reason: FullSuiteReason) -> ImpactPlan:
    return ImpactPlan(mode="full_suite", tests=(), reason=reason)


def plan_impacted_tests(
    *,
    changed_paths: tuple[str, ...],
    parse_complete: bool,
    topology: tuple[CoverageTopologyEdge, ...],
    now: datetime,
) -> ImpactPlan:
    """Choose targeted tests only when every changed source has fresh measured topology."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must include a timezone")
    current_time = now.astimezone(timezone.utc)

    if not parse_complete:
        return _full_suite("partial_parse")
    if not changed_paths:
        return _full_suite("missing_changed_paths")
    if any(_is_build_or_test_config(path) for path in changed_paths):
        return _full_suite("build_or_test_config_changed")

    changed_tests = {path for path in changed_paths if is_test_file(path)}
    changed_sources = {path for path in changed_paths if not is_test_file(path)}
    matching = tuple(edge for edge in topology if edge.file_path in changed_sources)

    covered_sources = {edge.file_path for edge in matching}
    if changed_sources - covered_sources:
        return _full_suite("missing_coverage_topology")

    stale_before = current_time - _FRESHNESS_WINDOW
    if any(
        edge.status != "measured"
        or edge.last_run is None
        or edge.last_run.astimezone(timezone.utc) < stale_before
        for edge in matching
    ):
        return _full_suite("stale_coverage_topology")

    tests = tuple(sorted(changed_tests | {edge.test_path for edge in matching}))
    if not tests:
        return _full_suite("missing_coverage_topology")
    return ImpactPlan(mode="targeted", tests=tests)

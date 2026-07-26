"""Strict contracts for nightly coverage planning and measured CI reports."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.models import GraphScope

_SHA = re.compile(r"^[0-9a-fA-F]{40,64}$")
_MODEL_CONFIG = ConfigDict(frozen=True, extra="forbid")


class InvalidCoverageJobError(ValueError):
    """A scheduler/CI envelope does not satisfy the coverage contract."""


def _canonical_path(value: str) -> str:
    normalized = value.strip().replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        not normalized
        or normalized.startswith("/")
        or "\0" in normalized
        or any(part in {"", ".", ".."} for part in path.parts)
        or path.as_posix() != normalized
    ):
        raise ValueError("path must be a canonical repository-relative POSIX path")
    return normalized


RepositoryPath = Annotated[str, AfterValidator(_canonical_path)]


class CoverageMeasurement(BaseModel):
    """One test outcome and the exact current-head files measured by that test."""

    model_config = _MODEL_CONFIG

    test_path: RepositoryPath
    file_paths: tuple[RepositoryPath, ...]
    outcome: Literal["pass", "fail"]

    @field_validator("file_paths")
    @classmethod
    def normalize_file_paths(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(sorted(set(value)))


class CoverageRunReport(BaseModel):
    """Normalized output from a coverage-instrumented CI run."""

    model_config = _MODEL_CONFIG

    org_id: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)
    ref_name: str = Field(min_length=1)
    revision_sha: str
    completed_at: datetime
    measurements: tuple[CoverageMeasurement, ...]

    @field_validator("revision_sha")
    @classmethod
    def validate_sha(cls, value: str) -> str:
        if not _SHA.fullmatch(value):
            raise ValueError("revision_sha must contain 40-64 hexadecimal characters")
        return value.lower()

    @field_validator("ref_name")
    @classmethod
    def validate_ref(cls, value: str) -> str:
        if not value.startswith("refs/") or any(char in value for char in ("\0", "\n", "\r")):
            raise ValueError("ref_name must be a canonical refs/* name")
        return value

    @field_validator("completed_at")
    @classmethod
    def validate_completed_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("completed_at must include a timezone")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def unique_tests(self) -> "CoverageRunReport":
        test_paths = [measurement.test_path for measurement in self.measurements]
        if len(test_paths) != len(set(test_paths)):
            raise ValueError("measurements must contain at most one result per test_path")
        return self

    def graph_scope(self) -> GraphScope:
        return GraphScope(
            org_id=self.org_id,
            repository_id=self.repository_id,
            ref_name=self.ref_name,
            revision_sha=self.revision_sha,
        )


class CoverageNightlyJob(BaseModel):
    """Server-scoped input for one nightly or manually requested coverage run."""

    model_config = _MODEL_CONFIG

    org_id: str = Field(min_length=1)
    repository_id: str = Field(min_length=1)
    ref_name: str = Field(min_length=1)
    revision_sha: str
    changed_paths: tuple[RepositoryPath, ...]
    parse_complete: bool
    triggered_at: datetime
    trace_id: str | None = None

    @field_validator("revision_sha")
    @classmethod
    def validate_sha(cls, value: str) -> str:
        if not _SHA.fullmatch(value):
            raise ValueError("revision_sha must contain 40-64 hexadecimal characters")
        return value.lower()

    @field_validator("ref_name")
    @classmethod
    def validate_ref(cls, value: str) -> str:
        if not value.startswith("refs/") or any(char in value for char in ("\0", "\n", "\r")):
            raise ValueError("ref_name must be a canonical refs/* name")
        return value

    @field_validator("changed_paths")
    @classmethod
    def normalize_changed_paths(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(sorted(set(value)))

    @field_validator("triggered_at")
    @classmethod
    def validate_triggered_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("triggered_at must include a timezone")
        return value.astimezone(timezone.utc)

    def graph_scope(self) -> GraphScope:
        return GraphScope(
            org_id=self.org_id,
            repository_id=self.repository_id,
            ref_name=self.ref_name,
            revision_sha=self.revision_sha,
        )


def _payload(envelope: MessageEnvelope, expected_type: str) -> dict[str, object]:
    if envelope.type != expected_type:
        raise InvalidCoverageJobError(f"expected {expected_type} envelope")
    if not isinstance(envelope.payload, dict):
        raise InvalidCoverageJobError("payload must be an object")
    return envelope.payload


def parse_nightly_envelope(envelope: MessageEnvelope) -> CoverageNightlyJob:
    """Bind tenant identity to the trusted envelope, never the message payload."""
    payload = _payload(envelope, "coverage.nightly")
    try:
        return CoverageNightlyJob.model_validate(
            {
                "org_id": envelope.org_id,
                "repository_id": payload.get("repository_id"),
                "ref_name": payload.get("ref_name"),
                "revision_sha": payload.get("revision_sha"),
                "changed_paths": payload.get("changed_paths", ()),
                "parse_complete": payload.get("parse_complete"),
                "triggered_at": payload.get("triggered_at"),
                "trace_id": envelope.trace_id,
            }
        )
    except ValueError as error:
        raise InvalidCoverageJobError("invalid coverage.nightly payload") from error


def parse_report_envelope(envelope: MessageEnvelope) -> CoverageRunReport:
    """Parse a normalized CI report while overriding any forged payload org_id."""
    payload = _payload(envelope, "coverage.report")
    try:
        return CoverageRunReport.model_validate({**payload, "org_id": envelope.org_id})
    except ValueError as error:
        raise InvalidCoverageJobError("invalid coverage.report payload") from error

"""Tenant-scoped contracts for the W1-05 ingestion and embedding workers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from messaging.envelope import MessageEnvelope

_SHA = re.compile(r"^[0-9a-fA-F]{40,64}$")


class InvalidIngestionJobError(ValueError):
    """The trusted queue envelope does not contain a usable ingestion job."""


class RepositoryLocator(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(min_length=1)
    provider_repo_id: str = Field(min_length=1)
    full_name: str = Field(min_length=1)
    clone_url: str | None = None
    credential_ref: str | None = None


class IngestionJob(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    org_id: str = Field(min_length=1)
    kind: Literal["initial", "delta"]
    repository: RepositoryLocator
    ref_name: str = Field(min_length=1)
    revision_sha: str
    previous_revision_sha: str | None = None
    forced: bool = False
    trace_id: str | None = None
    idempotency_key: str = Field(min_length=1)

    @field_validator("revision_sha", "previous_revision_sha")
    @classmethod
    def validate_sha(cls, value: str | None) -> str | None:
        if value is not None and not _SHA.fullmatch(value):
            raise ValueError("revision SHA must contain 40-64 hexadecimal characters")
        return value.lower() if value is not None else None

    @field_validator("ref_name")
    @classmethod
    def validate_ref(cls, value: str) -> str:
        if not value.startswith("refs/") or any(char in value for char in ("\0", "\n", "\r")):
            raise ValueError("ref_name must be a canonical refs/* name")
        return value


@dataclass(frozen=True)
class RefState:
    ref_id: str
    revision_sha: str
    graph_version: int


@dataclass(frozen=True)
class GraphScope:
    org_id: str
    repository_id: str
    ref_name: str
    revision_sha: str


@dataclass(frozen=True)
class GraphNode:
    label: Literal["Folder", "File", "Function", "Class", "Test"]
    uid: str
    properties: dict[str, Any]


@dataclass(frozen=True)
class GraphEdge:
    relationship: Literal["CONTAINS", "IMPORTS", "CALLS", "INHERITS", "COVERS"]
    source_uid: str
    target_uid: str
    # Only COVERS carries edge properties today (status, last_run) -- the other
    # relationship types stay bare, matching the graph schema (docs/graph-schema.md).
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SymbolRef:
    label: Literal["Function", "Class"]
    uid: str
    file_path: str
    name: str
    qualified_name: str


@dataclass(frozen=True)
class GraphProjection:
    scope: GraphScope
    nodes: tuple[GraphNode, ...]
    edges: tuple[GraphEdge, ...]
    current_file_paths: tuple[str, ...]
    current_folder_paths: tuple[str, ...]
    affected_file_paths: tuple[str, ...]
    full_rebuild: bool


@dataclass(frozen=True)
class CodeChunk:
    graph_node_id: str
    chunk_index: int
    content: str
    content_hash: str
    start_line: int
    end_line: int
    token_count: int


@dataclass(frozen=True)
class PersistedChunk:
    chunk_id: str
    chunk: CodeChunk


@dataclass(frozen=True)
class EmbeddingTask:
    org_id: str
    repository_id: str
    ref_id: str
    ref_name: str
    revision_sha: str
    chunk_id: str
    graph_node_id: str


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    dimension: int = 1024
    endpoint_url: str | None = None
    credential_ref: str | None = None


@dataclass(frozen=True)
class EmbeddingWork:
    task: EmbeddingTask
    content: str
    config: EmbeddingConfig


@dataclass(frozen=True)
class IngestionResult:
    status: Literal["accepted", "replayed", "stale"]
    revision_sha: str
    graph_version: int | None
    full_rebuild: bool
    changed_paths: tuple[str, ...] = field(default_factory=tuple)
    deleted_paths: tuple[str, ...] = field(default_factory=tuple)
    structural_duration_ms: float | None = None


def _record(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidIngestionJobError(f"{name} must be an object")
    return value


def _required_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidIngestionJobError(f"{name} must be a non-blank string")
    return value.strip()


def _optional_string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def parse_ingestion_envelope(envelope: MessageEnvelope) -> IngestionJob:
    """Translate the shared queue envelope without ever trusting a payload org_id."""
    if envelope.type not in {"repo.initial_parse", "repo.push"}:
        raise InvalidIngestionJobError("unsupported ingestion message type")
    event = _record(envelope.payload, "payload")
    repository_data = _record(event.get("repo") or event.get("repository"), "payload.repo")
    provider = _required_string(event.get("provider"), "payload.provider")
    repository = RepositoryLocator(
        provider=provider,
        provider_repo_id=_required_string(
            repository_data.get("provider_repo_id") or repository_data.get("external_id"),
            "payload.repo.provider_repo_id",
        ),
        full_name=_required_string(repository_data.get("full_name"), "payload.repo.full_name"),
        clone_url=_optional_string(repository_data.get("clone_url") or event.get("clone_url")),
        credential_ref=_optional_string(
            repository_data.get("credential_ref") or event.get("credential_ref")
        ),
    )
    ref_name = _required_string(event.get("ref") or event.get("ref_name"), "payload.ref")
    detail = _record(event.get("payload", {}), "payload.payload")
    if envelope.type == "repo.push":
        revision = _required_string(detail.get("after"), "payload.payload.after")
        previous = _optional_string(detail.get("before"))
        forced = detail.get("forced", False)
        if not isinstance(forced, bool):
            raise InvalidIngestionJobError("payload.payload.forced must be boolean")
        kind: Literal["initial", "delta"] = "delta"
    else:
        revision = _required_string(
            event.get("revision_sha") or detail.get("revision_sha") or detail.get("after"),
            "payload.revision_sha",
        )
        previous = None
        forced = True
        kind = "initial"

    return IngestionJob(
        # The envelope org is the already server-resolved tenant identity. A forged
        # payload org_id is intentionally ignored.
        org_id=envelope.org_id,
        kind=kind,
        repository=repository,
        ref_name=ref_name,
        revision_sha=revision,
        previous_revision_sha=previous,
        forced=forced,
        trace_id=envelope.trace_id,
        idempotency_key=envelope.idempotency_key or envelope.message_id,
    )

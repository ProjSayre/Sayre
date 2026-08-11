"""Tenant-scoped contracts for the W1-05 ingestion and embedding workers."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from messaging.envelope import MessageEnvelope

_SHA = re.compile(r"^[0-9a-fA-F]{40,64}$")
_INSTALLATION_ID = re.compile(r"^[1-9][0-9]{0,15}$")
_ZERO_SHA = re.compile(r"^0{40,64}$")


class InvalidIngestionJobError(ValueError):
    """The trusted queue envelope does not contain a usable ingestion job."""


class RepositoryLocator(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    provider: str = Field(min_length=1)
    provider_repo_id: str = Field(min_length=1)
    full_name: str = Field(min_length=1)
    installation_id: int | None = Field(default=None, ge=1, le=9_007_199_254_740_991)
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
    occurred_at: datetime
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

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        return value.astimezone(timezone.utc)


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
    # COVERS carries status/last_run; CONTAINS/IMPORTS/CALLS/INHERITS stay bare,
    # matching the graph schema (docs/graph-schema.md).
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
    status: Literal["accepted", "replayed", "stale", "ref_deleted", "ignored"]
    revision_sha: str
    graph_version: int | None
    full_rebuild: bool
    changed_paths: tuple[str, ...] = field(default_factory=tuple)
    deleted_paths: tuple[str, ...] = field(default_factory=tuple)
    structural_duration_ms: float | None = None


@dataclass(frozen=True)
class RefDeletionCommand:
    """A webhook signal that a ref no longer exists. Terminal: acknowledged, never parsed."""

    org_id: str
    repository: RepositoryLocator
    ref_name: str
    previous_revision_sha: str | None
    occurred_at: datetime
    trace_id: str | None
    idempotency_key: str


@dataclass(frozen=True)
class IgnoredIngestionMessage:
    """A message type known to be non-actionable for ingestion. Terminal: acknowledged."""

    message_type: str
    reason: Literal["branch_lifecycle_event", "ref_deleted"]


IngestionCommand = IngestionJob | RefDeletionCommand | IgnoredIngestionMessage

# Envelope types that may legitimately arrive on the ingestion FIFO queue but that this
# worker deliberately does not parse. Anything OUTSIDE this set and outside the handled
# set still raises InvalidIngestionJobError — an unknown type must fail loudly rather
# than be silently swallowed.
TERMINAL_IGNORED_TYPES: frozenset[str] = frozenset({"repo.branch"})


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


def _installation_id(value: object, *, required: bool) -> int | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not _INSTALLATION_ID.fullmatch(value):
        raise InvalidIngestionJobError("payload.installation_id must be a positive decimal string")
    installation_id = int(value)
    if installation_id > 9_007_199_254_740_991:
        raise InvalidIngestionJobError("payload.installation_id is outside the supported range")
    return installation_id


def _extract_repository_and_ref(
    event: dict[str, Any],
) -> tuple[RepositoryLocator, str, dict[str, Any]]:
    """Shared repository-locator/ref-name/inner-payload extraction, used by both
    `parse_ingestion_envelope` and `classify_ingestion_envelope`'s ref-deletion branch
    so a malformed envelope raises `InvalidIngestionJobError` identically either way."""
    repository_data = _record(event.get("repo") or event.get("repository"), "payload.repo")
    provider = _required_string(event.get("provider"), "payload.provider")
    repository = RepositoryLocator(
        provider=provider,
        provider_repo_id=_required_string(
            repository_data.get("provider_repo_id") or repository_data.get("external_id"),
            "payload.repo.provider_repo_id",
        ),
        full_name=_required_string(repository_data.get("full_name"), "payload.repo.full_name"),
        installation_id=_installation_id(
            event.get("installation_id"),
            required=provider == "github",
        ),
        clone_url=_optional_string(repository_data.get("clone_url") or event.get("clone_url")),
        credential_ref=_optional_string(
            repository_data.get("credential_ref") or event.get("credential_ref")
        ),
    )
    ref_name = _required_string(event.get("ref") or event.get("ref_name"), "payload.ref")
    detail = _record(event.get("payload", {}), "payload.payload")
    return repository, ref_name, detail


def parse_ingestion_envelope(envelope: MessageEnvelope) -> IngestionJob:
    """Translate the shared queue envelope without ever trusting a payload org_id."""
    if envelope.type not in {"repo.initial_parse", "repo.push"}:
        raise InvalidIngestionJobError("unsupported ingestion message type")
    event = _record(envelope.payload, "payload")
    repository, ref_name, detail = _extract_repository_and_ref(event)
    if envelope.type == "repo.push":
        revision = _required_string(detail.get("after"), "payload.payload.after")
        if _ZERO_SHA.fullmatch(revision):
            # Defence-in-depth: no caller can route an all-zero-SHA branch-deletion
            # push into the checkout path. classify_ingestion_envelope is the only
            # supported entry point for the consumer (see GAP-9).
            raise InvalidIngestionJobError(
                "branch-deletion push must be classified, not parsed"
            )
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
        occurred_at=envelope.occurred_at,
        trace_id=envelope.trace_id,
        idempotency_key=envelope.idempotency_key or envelope.message_id,
    )


def classify_ingestion_envelope(envelope: MessageEnvelope) -> IngestionCommand:
    """Terminal classification for every delivery on the ingestion queue.

    Returns an IngestionJob for work to perform, a RefDeletionCommand for a ref that no
    longer exists, or an IgnoredIngestionMessage for a known non-actionable type. Raises
    InvalidIngestionJobError only for genuinely unknown or malformed input.
    """
    # Rule 1: an enumerated, known-non-actionable type is acknowledged without ever
    # touching envelope.payload beyond this type check (EC-1: a junk/empty payload on
    # a repo.branch envelope still terminal-acks rather than raising).
    if envelope.type in TERMINAL_IGNORED_TYPES:
        return IgnoredIngestionMessage(
            message_type=envelope.type, reason="branch_lifecycle_event"
        )

    # Rule 2: a repo.push that is actually a branch deletion classifies as a terminal
    # RefDeletionCommand instead of being parsed into a checkout-bound IngestionJob.
    if envelope.type == "repo.push":
        event = _record(envelope.payload, "payload")
        detail = _record(event.get("payload", {}), "payload.payload")
        deleted = detail.get("deleted", False)
        if not isinstance(deleted, bool):
            # Mirrors the existing `forced` type check at parse_ingestion_envelope.
            raise InvalidIngestionJobError("payload.payload.deleted must be boolean")
        after = detail.get("after")
        is_zero_after = isinstance(after, str) and bool(_ZERO_SHA.fullmatch(after))
        if deleted or is_zero_after:
            # deleted=True is authoritative even with a real, non-zero `after`
            # (EC-4); an all-zero `after` is a ref deletion even when a payload
            # lies about `deleted` (EC-3) -- a payload cannot bypass this guard.
            repository, ref_name, detail = _extract_repository_and_ref(event)
            before = detail.get("before")
            previous_revision_sha = (
                before
                if isinstance(before, str)
                and _SHA.fullmatch(before)
                and not _ZERO_SHA.fullmatch(before)
                else None
            )
            return RefDeletionCommand(
                org_id=envelope.org_id,
                repository=repository,
                ref_name=ref_name,
                previous_revision_sha=previous_revision_sha,
                occurred_at=envelope.occurred_at,
                trace_id=envelope.trace_id,
                idempotency_key=envelope.idempotency_key or envelope.message_id,
            )

    # Rule 3: everything else this worker actually handles delegates unchanged.
    if envelope.type in {"repo.initial_parse", "repo.push"}:
        return parse_ingestion_envelope(envelope)

    # Rule 4: genuinely unknown/malformed input still fails loudly.
    raise InvalidIngestionJobError("unsupported ingestion message type")

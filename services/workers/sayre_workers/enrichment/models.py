"""Tenant-scoped contracts for semantic enrichment.

W2-05 introduced graph-node/edge writes. W3-06 adds a deliberately narrow property
patch boundary for the two Folder style properties; it does not make arbitrary node
properties model-writable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from sayre_workers.ingestion.models import GraphScope
from sayre_workers.model_provider import GenerationConfig as ProviderGenerationConfig

GenerationConfig = ProviderGenerationConfig

LANE = Literal["default", "priority"]

# Closed subsets of the graph-schema closed sets (packages/graph-schema/schema.md)
# that enrichment is permitted to write. Any label/edge outside these is rejected by
# the writer (defense in depth behind GraphifyAdapter) -- see enrichment_graph.py.
ENRICHMENT_NODE_LABELS: frozenset[str] = frozenset({"Feature", "EnvStep"})
ENRICHMENT_EDGE_TYPES: frozenset[str] = frozenset({"PART_OF", "REFERENCES", "REQUIRES"})
PATCHABLE_PROPERTIES: dict[str, frozenset[str]] = {
    "Folder": frozenset({"coding_style", "comment_style"}),
}

MAX_STYLE_VALUE_CHARS = 2_048


class InvalidEnrichmentEventError(ValueError):
    """The trusted queue envelope does not contain a usable enrichment job."""


class InvalidEnrichmentWriteError(ValueError):
    """A GraphifyAdapter write used a label/edge outside the closed sets, or a scope
    that disagrees with the job that produced it."""


class InvalidStyleClassificationError(InvalidEnrichmentWriteError):
    """A style-classification response was malformed or escaped its requested scope."""


class GenerationConfigNotFoundError(RuntimeError):
    """No model_provider_configs row (purpose='generation') exists for the org.

    Propagates out of handle so the message is NOT acked -> redeliver -> DLQ
    (Decision D2). There is deliberately no skip-and-ack branch and no
    deterministic-fake-provider fallback for this path outside tests.
    """


@dataclass(frozen=True)
class FileContext:
    uid: str
    path: str
    language: str | None


@dataclass(frozen=True)
class FolderContext:
    uid: str
    path: str


@dataclass(frozen=True)
class EnrichmentContext:
    scope: GraphScope
    files: tuple[FileContext, ...]
    folders: tuple[FolderContext, ...] = ()


@dataclass(frozen=True)
class EnrichmentJob:
    scope: GraphScope
    graph_scope_key: str
    graph_version: int
    full_rebuild: bool
    changed_paths: tuple[str, ...]
    lane: LANE
    trace_id: str | None
    idempotency_key: str


@dataclass(frozen=True)
class EnrichmentNode:
    label: str  # must be in ENRICHMENT_NODE_LABELS
    uid: str
    properties: dict[str, Any]


@dataclass(frozen=True)
class EnrichmentEdge:
    relationship: str  # must be in ENRICHMENT_EDGE_TYPES
    source_uid: str
    target_uid: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NodePropertyPatch:
    label: str
    uid: str
    properties: dict[str, str | None]


@dataclass(frozen=True)
class EnrichmentWrite:
    scope: GraphScope
    nodes: tuple[EnrichmentNode, ...] = ()
    edges: tuple[EnrichmentEdge, ...] = ()
    property_patches: tuple[NodePropertyPatch, ...] = ()


@dataclass(frozen=True)
class EnrichmentResult:
    status: Literal["written", "degraded", "skipped_no_context", "skipped_stale"]
    scope: GraphScope
    node_count: int
    edge_count: int

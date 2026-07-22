"""Tenant-scoped contracts for the W2-05 semantic enrichment worker skeleton.

Deliberately absent (Resolved decisions D5, `.pipeline/spec.md`): a
`NodePropertyPatch` dataclass, a `PATCHABLE_PROPERTIES` map, and a `property_patches`
field on `EnrichmentWrite`. Property patching (e.g. `File.agent_skill_md`,
`Folder.coding_style`) is owned by W3-01/W3-06 and will reintroduce these types when
needed. This skeleton's only demonstrable write is graph nodes + edges.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from sayre_workers.ingestion.models import GraphScope

LANE = Literal["default", "priority"]

# Closed subsets of the graph-schema closed sets (packages/graph-schema/schema.md)
# that enrichment is permitted to write. Any label/edge outside these is rejected by
# the writer (defense in depth behind GraphifyAdapter) -- see enrichment_graph.py.
ENRICHMENT_NODE_LABELS: frozenset[str] = frozenset({"Feature", "EnvStep"})
ENRICHMENT_EDGE_TYPES: frozenset[str] = frozenset({"PART_OF", "REFERENCES", "REQUIRES"})


class InvalidEnrichmentEventError(ValueError):
    """The trusted queue envelope does not contain a usable enrichment job."""


class InvalidEnrichmentWriteError(ValueError):
    """A GraphifyAdapter write used a label/edge outside the closed sets, or a scope
    that disagrees with the job that produced it."""


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
class EnrichmentContext:
    scope: GraphScope
    files: tuple[FileContext, ...]


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
class GenerationConfig:
    provider: str  # 'fake_deterministic' (test) | 'anthropic' | 'openai' | 'openai_compatible'
    model: str
    endpoint_url: str | None = None
    credential_ref: str | None = None
    options: dict[str, Any] = field(default_factory=dict)


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
class EnrichmentWrite:
    scope: GraphScope
    nodes: tuple[EnrichmentNode, ...] = ()
    edges: tuple[EnrichmentEdge, ...] = ()


@dataclass(frozen=True)
class EnrichmentResult:
    status: Literal["written", "skipped_no_context", "skipped_stale"]
    scope: GraphScope
    node_count: int
    edge_count: int

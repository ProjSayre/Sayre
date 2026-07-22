"""Graphify shaping boundary -- output is constrained to graph primitives, never prose.

This is the ONLY module in `sayre_workers/enrichment/` allowed to `import graphifyy`
(reserved for W3-07's real adapter; enforced by
`tests/test_enrichment_vendor_isolation.py`). The skeleton's `FakeGraphifyAdapter`
below deliberately does not import or construct `graphifyy`.
"""

from __future__ import annotations

from typing import Protocol

from sayre_workers.ingestion.projection import stable_uid

from .models import EnrichmentContext, EnrichmentEdge, EnrichmentNode, EnrichmentWrite
from .providers import GenerationResponse


class GraphifyAdapter(Protocol):
    async def shape(
        self, context: EnrichmentContext, generation: GenerationResponse
    ) -> EnrichmentWrite: ...


class FakeGraphifyAdapter:
    """Deterministic graph-primitive shaper for the skeleton. Emits ONLY graph
    primitives (never prose): one placeholder `Feature` node keyed to the scope plus a
    `PART_OF` edge (File -> Feature) for each in-context File. Idempotent under MERGE
    (stable uids). Emits no property patches (Decision D5)."""

    async def shape(
        self, context: EnrichmentContext, generation: GenerationResponse
    ) -> EnrichmentWrite:
        # The skeleton does not interpret the generated text -- W3-01 owns real
        # feature-clustering shaping logic. Referencing it here only proves the
        # boundary is wired end to end (generate -> shape).
        del generation

        feature_uid = stable_uid(context.scope, "Feature", "__skeleton__")
        nodes = (
            EnrichmentNode(
                label="Feature",
                uid=feature_uid,
                properties={
                    "name": "Unclassified",
                    "description": "<skeleton placeholder — replaced by W3-01>",
                    "team": None,
                },
            ),
        )
        edges = tuple(
            EnrichmentEdge(
                relationship="PART_OF",
                source_uid=file.uid,
                target_uid=feature_uid,
            )
            for file in context.files
        )
        return EnrichmentWrite(scope=context.scope, nodes=nodes, edges=edges)


class GraphifyAdapterFactory:
    def create(self) -> GraphifyAdapter:
        # Skeleton: always the fake. W3-07 swaps in the base-graphifyy adapter (the
        # only place `import graphifyy` is permitted in this package).
        return FakeGraphifyAdapter()

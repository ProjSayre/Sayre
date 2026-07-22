"""Instrumented Neo4j enrichment context reader and closed-set graph-primitive writer.

Mirrors `sayre_workers.ingestion.graph`'s org-stamped, static-Cypher `UNWIND ...
MERGE ... SET` writer style. `validate_enrichment_write` is a pure, Neo4j-free
function so the closed-set guard is unit-testable without a broker or a database
(`tests/test_enrichment.py`).
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from neo4j import AsyncDriver, AsyncGraphDatabase

from sayre_workers.config import get_config, get_secret
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.telemetry.graph_metrics import (
    QUERY_SHAPE_TRAVERSAL,
    QUERY_SHAPE_WRITE,
    instrument_graph_query,
)

from .models import (
    ENRICHMENT_EDGE_TYPES,
    ENRICHMENT_NODE_LABELS,
    EnrichmentContext,
    EnrichmentWrite,
    FileContext,
    InvalidEnrichmentWriteError,
)


class EnrichmentGraphStore(Protocol):
    async def load_context(
        self, scope: GraphScope, changed_paths: tuple[str, ...], full_rebuild: bool
    ) -> EnrichmentContext: ...

    async def apply(self, write: EnrichmentWrite) -> None: ...


# Static, closed-set Cypher shapes -- one per permitted label/relationship. Endpoints
# are matched without a label filter (mirroring ingestion's generic CONTAINS shape)
# because a PART_OF/REFERENCES/REQUIRES edge's two endpoints can be different labels
# depending on the relationship (File->Feature, Ticket->File, EnvStep->EnvStep).
_NODE_QUERIES = {
    "Feature": """
        UNWIND $items AS item
        MERGE (node:Feature {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.name = item.name,
            node.description = item.description, node.team = item.team
    """,
    "EnvStep": """
        UNWIND $items AS item
        MERGE (node:EnvStep {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.sequence = item.sequence,
            node.command = item.command
    """,
}

_EDGE_QUERIES = {
    "PART_OF": """
        UNWIND $items AS item
        MATCH (source {org_id: $org_id, uid: item.source_uid})
        MATCH (target {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:PART_OF {org_id: $org_id}]->(target)
    """,
    "REFERENCES": """
        UNWIND $items AS item
        MATCH (source {org_id: $org_id, uid: item.source_uid})
        MATCH (target {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:REFERENCES {org_id: $org_id}]->(target)
    """,
    "REQUIRES": """
        UNWIND $items AS item
        MATCH (source {org_id: $org_id, uid: item.source_uid})
        MATCH (target {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:REQUIRES {org_id: $org_id}]->(target)
    """,
}


def validate_enrichment_write(write: EnrichmentWrite) -> None:
    """Raise InvalidEnrichmentWriteError if any primitive falls outside the closed
    sets (`ENRICHMENT_NODE_LABELS`/`ENRICHMENT_EDGE_TYPES`). Pure and Neo4j-free so it
    can run standalone in unit tests -- defense in depth behind GraphifyAdapter."""
    for node in write.nodes:
        if node.label not in ENRICHMENT_NODE_LABELS:
            raise InvalidEnrichmentWriteError(
                f"enrichment write attempted a disallowed node label: {node.label!r}"
            )
    for edge in write.edges:
        if edge.relationship not in ENRICHMENT_EDGE_TYPES:
            raise InvalidEnrichmentWriteError(
                f"enrichment write attempted a disallowed relationship: {edge.relationship!r}"
            )


class Neo4jEnrichmentGraphStore:
    def __init__(self, driver: AsyncDriver) -> None:
        self._driver = driver

    @classmethod
    async def from_config(cls) -> "Neo4jEnrichmentGraphStore":
        password = await get_secret("env://NEO4J_PASSWORD")
        driver = AsyncGraphDatabase.driver(
            get_config("NEO4J_URI"), auth=(get_config("NEO4J_USER"), password)
        )
        return cls(driver)

    async def close(self) -> None:
        await self._driver.close()

    async def load_context(
        self, scope: GraphScope, changed_paths: tuple[str, ...], full_rebuild: bool
    ) -> EnrichmentContext:
        query = """
            MATCH (node:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
            WHERE $full_rebuild OR node.path IN $changed_paths
            RETURN node.uid AS uid, node.path AS path, node.language AS language
            ORDER BY node.path
        """
        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_TRAVERSAL) as measurement:
            records, _summary, _keys = await self._driver.execute_query(
                query,
                org_id=scope.org_id,
                repo_id=scope.repository_id,
                ref_name=scope.ref_name,
                full_rebuild=full_rebuild,
                changed_paths=list(changed_paths),
            )
            measurement.set_result_node_count(len(records))
        files = tuple(
            FileContext(uid=record["uid"], path=record["path"], language=record["language"])
            for record in records
        )
        return EnrichmentContext(scope=scope, files=files)

    async def apply(self, write: EnrichmentWrite) -> None:
        # Closed-set validation happens BEFORE any Cypher runs (AC5).
        validate_enrichment_write(write)

        scope = write.scope
        nodes_by_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for node in write.nodes:
            nodes_by_label[node.label].append({"uid": node.uid, **node.properties})
        edges_by_type: dict[str, list[dict[str, str]]] = defaultdict(list)
        for edge in write.edges:
            edges_by_type[edge.relationship].append(
                {"source_uid": edge.source_uid, "target_uid": edge.target_uid}
            )

        async def write_transaction(transaction: Any) -> None:
            common = {
                "org_id": scope.org_id,
                "repo_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
            }
            for label, query in _NODE_QUERIES.items():
                if nodes_by_label[label]:
                    await transaction.run(query, items=nodes_by_label[label], **common)
            for relationship, query in _EDGE_QUERIES.items():
                if edges_by_type[relationship]:
                    await transaction.run(
                        query, items=edges_by_type[relationship], org_id=scope.org_id
                    )

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_WRITE) as measurement:
            async with self._driver.session() as session:
                await session.execute_write(write_transaction)
            measurement.set_result_node_count(len(write.nodes))

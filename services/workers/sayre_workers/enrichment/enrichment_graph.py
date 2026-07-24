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
    MAX_STYLE_VALUE_CHARS,
    PATCHABLE_PROPERTIES,
    EnrichmentContext,
    EnrichmentWrite,
    FileContext,
    FolderContext,
    InvalidEnrichmentWriteError,
)
from .onboarding_plan import canonicalize_onboarding_write


class EnrichmentGraphStore(Protocol):
    async def is_current(self, scope: GraphScope) -> bool: ...

    async def load_context(
        self, scope: GraphScope, changed_paths: tuple[str, ...], full_rebuild: bool
    ) -> EnrichmentContext: ...

    async def apply(self, write: EnrichmentWrite) -> None: ...

    async def apply_feature_projection(self, write: EnrichmentWrite) -> bool: ...

    async def apply_onboarding_projection(self, write: EnrichmentWrite) -> bool: ...


LOAD_ENRICHMENT_FILES_CYPHER = """
    MATCH (node:File {
        org_id: $org_id,
        repo_id: $repo_id,
        ref_name: $ref_name,
        revision_sha: $revision_sha
    })
    WHERE $full_rebuild OR node.path IN $changed_paths
    RETURN node.uid AS uid, node.path AS path, node.language AS language
    ORDER BY node.path
"""

LOAD_STYLE_FOLDERS_CYPHER = """
    MATCH (folder:Folder {
        org_id: $org_id,
        repo_id: $repo_id,
        ref_name: $ref_name,
        revision_sha: $revision_sha
    })
    WHERE folder.uid IS NOT NULL
      AND folder.path IS NOT NULL
      AND (
        $full_rebuild OR
        ANY(changed_path IN $changed_paths WHERE
          folder.path = '' OR
          changed_path = folder.path OR
          changed_path STARTS WITH folder.path + '/')
      )
    RETURN folder.uid AS uid, folder.path AS path
    ORDER BY folder.path, folder.uid
"""


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

_PROPERTY_PATCH_QUERIES = {
    "Folder": """
        UNWIND $items AS item
        MATCH (node:Folder {
            org_id: $org_id,
            repo_id: $repo_id,
            ref_name: $ref_name,
            revision_sha: $revision_sha,
            uid: item.uid
        })
        SET node.coding_style = item.coding_style,
            node.comment_style = item.comment_style
    """,
}

_CURRENT_SCOPE_QUERY = """
    MATCH (root:Folder {
        org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
        revision_sha: $revision_sha, path: ''
    })
    RETURN root.uid AS uid
    LIMIT 1
"""

_DELETE_FEATURE_MEMBERSHIPS_QUERY = """
    MATCH (source:File {
        org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name
    })-[edge:PART_OF]->(feature:Feature {
        org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name
    })
    DELETE edge
"""

_DELETE_STALE_FEATURES_QUERY = """
    MATCH (node:Feature {
        org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name
    })
    WHERE NOT (node.uid IN $feature_uids)
    DETACH DELETE node
"""

_DELETE_ONBOARDING_PROJECTION_QUERY = """
    MATCH (node:EnvStep {
        org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name
    })
    DETACH DELETE node
"""

_FEATURE_EDGE_QUERIES = {
    "PART_OF": """
        UNWIND $items AS item
        MATCH (source:File {
            org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
            revision_sha: $revision_sha, uid: item.source_uid
        })
        MATCH (target:Feature {
            org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
            revision_sha: $revision_sha, uid: item.target_uid
        })
        MERGE (source)-[edge:PART_OF {org_id: $org_id}]->(target)
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
    seen_patches: set[tuple[str, str]] = set()
    for patch in write.property_patches:
        allowed = PATCHABLE_PROPERTIES.get(patch.label)
        if allowed is None:
            raise InvalidEnrichmentWriteError(
                f"enrichment write attempted a disallowed patch label: {patch.label!r}"
            )
        if not patch.uid.strip() or len(patch.uid) > 512:
            raise InvalidEnrichmentWriteError("enrichment property patch requires a bounded uid")
        patch_key = (patch.label, patch.uid)
        if patch_key in seen_patches:
            raise InvalidEnrichmentWriteError(
                f"enrichment write contains a duplicate property patch for {patch.label}:{patch.uid}"
            )
        seen_patches.add(patch_key)
        if set(patch.properties) != allowed:
            raise InvalidEnrichmentWriteError(
                f"{patch.label} patch must contain exactly {sorted(allowed)!r}"
            )
        for property_name, value in patch.properties.items():
            if value is None:
                continue
            if (
                not isinstance(value, str)
                or not value.strip()
                or "\x00" in value
                or len(value) > MAX_STYLE_VALUE_CHARS
            ):
                raise InvalidEnrichmentWriteError(
                    f"{patch.label}.{property_name} must be null or a bounded non-blank string"
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

    async def is_current(self, scope: GraphScope) -> bool:
        """Check the graph's server-stamped head marker for this exact revision."""

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_TRAVERSAL) as measurement:
            records, _summary, _keys = await self._driver.execute_query(
                _CURRENT_SCOPE_QUERY,
                org_id=scope.org_id,
                repo_id=scope.repository_id,
                ref_name=scope.ref_name,
                revision_sha=scope.revision_sha,
            )
            measurement.set_result_node_count(len(records))
        return bool(records)

    async def load_context(
        self, scope: GraphScope, changed_paths: tuple[str, ...], full_rebuild: bool
    ) -> EnrichmentContext:
        parameters: dict[str, Any] = {
            "org_id": scope.org_id,
            "repo_id": scope.repository_id,
            "ref_name": scope.ref_name,
            "revision_sha": scope.revision_sha,
            "full_rebuild": full_rebuild,
            "changed_paths": list(changed_paths),
        }
        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_TRAVERSAL) as measurement:
            file_records, _file_summary, _file_keys = await self._driver.execute_query(
                LOAD_ENRICHMENT_FILES_CYPHER,
                **parameters,
            )
            folder_records, _folder_summary, _folder_keys = await self._driver.execute_query(
                LOAD_STYLE_FOLDERS_CYPHER,
                **parameters,
            )
            measurement.set_result_node_count(len(file_records) + len(folder_records))
        files = tuple(
            FileContext(uid=record["uid"], path=record["path"], language=record["language"])
            for record in file_records
        )
        folders = tuple(
            FolderContext(uid=record["uid"], path=record["path"])
            for record in folder_records
        )
        return EnrichmentContext(scope=scope, files=files, folders=folders)

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
        patches_by_label: dict[str, list[dict[str, str | None]]] = defaultdict(list)
        for patch in write.property_patches:
            patches_by_label[patch.label].append({"uid": patch.uid, **patch.properties})

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
            for label, query in _PROPERTY_PATCH_QUERIES.items():
                if patches_by_label[label]:
                    await transaction.run(query, items=patches_by_label[label], **common)

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_WRITE) as measurement:
            async with self._driver.session() as session:
                await session.execute_write(write_transaction)
            measurement.set_result_node_count(len(write.nodes) + len(write.property_patches))

    async def apply_feature_projection(self, write: EnrichmentWrite) -> bool:
        """Replace one ref head's Feature membership projection if still current.

        Existing Feature nodes with the same stable uid are updated in place so
        Ticket -> Feature REFERENCES edges survive. Obsolete Features and all old
        PART_OF memberships are removed in the same transaction. Locking the current
        root prevents a superseded model response from mutating the new head.
        """

        validate_enrichment_write(write)
        for node in write.nodes:
            if node.label != "Feature":
                raise InvalidEnrichmentWriteError(
                    "Feature projection may contain only Feature nodes"
                )
        for edge in write.edges:
            if edge.relationship not in _FEATURE_EDGE_QUERIES:
                raise InvalidEnrichmentWriteError(
                    "Feature projection may contain only PART_OF edges"
                )

        scope = write.scope
        feature_nodes = [{"uid": node.uid, **node.properties} for node in write.nodes]
        edges_by_type: dict[str, list[dict[str, str]]] = defaultdict(list)
        for edge in write.edges:
            edges_by_type[edge.relationship].append(
                {"source_uid": edge.source_uid, "target_uid": edge.target_uid}
            )
        patches_by_label: dict[str, list[dict[str, str | None]]] = defaultdict(list)
        for patch in write.property_patches:
            patches_by_label[patch.label].append(
                {"uid": patch.uid, **patch.properties}
            )

        async def replace_projection(transaction: Any) -> bool:
            common = {
                "org_id": scope.org_id,
                "repo_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
            }
            root_result = await transaction.run(
                """
                MATCH (root:Folder {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, path: ''
                })
                SET root.revision_sha = $revision_sha
                RETURN root.uid AS uid
                LIMIT 1
                """,
                **common,
            )
            if await root_result.single(strict=False) is None:
                return False

            await transaction.run(_DELETE_FEATURE_MEMBERSHIPS_QUERY, **common)
            await transaction.run(
                _DELETE_STALE_FEATURES_QUERY,
                feature_uids=[node["uid"] for node in feature_nodes],
                **common,
            )
            if feature_nodes:
                await transaction.run(_NODE_QUERIES["Feature"], items=feature_nodes, **common)
            for relationship, query in _FEATURE_EDGE_QUERIES.items():
                if edges_by_type[relationship]:
                    await transaction.run(
                        query,
                        items=edges_by_type[relationship],
                        **common,
                    )
            for label, query in _PROPERTY_PATCH_QUERIES.items():
                if patches_by_label[label]:
                    await transaction.run(
                        query,
                        items=patches_by_label[label],
                        **common,
                    )
            return True

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_WRITE) as measurement:
            async with self._driver.session() as session:
                applied = bool(await session.execute_write(replace_projection))
            measurement.set_result_node_count(
                len(write.nodes) + len(write.property_patches) if applied else 0
            )
        return applied

    async def apply_onboarding_projection(self, write: EnrichmentWrite) -> bool:
        """Atomically replace one current ref head's ordered EnvStep projection."""

        write = canonicalize_onboarding_write(write)
        validate_enrichment_write(write)
        for node in write.nodes:
            if node.label != "EnvStep":
                raise InvalidEnrichmentWriteError(
                    "Onboarding projection may contain only EnvStep nodes"
                )
        for edge in write.edges:
            if edge.relationship != "REQUIRES":
                raise InvalidEnrichmentWriteError(
                    "Onboarding projection may contain only REQUIRES edges"
                )

        scope = write.scope
        step_nodes = [{"uid": node.uid, **node.properties} for node in write.nodes]
        requires_edges = [
            {"source_uid": edge.source_uid, "target_uid": edge.target_uid}
            for edge in write.edges
        ]

        async def replace_projection(transaction: Any) -> bool:
            common = {
                "org_id": scope.org_id,
                "repo_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
            }
            root_result = await transaction.run(
                """
                MATCH (root:Folder {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, path: ''
                })
                SET root.revision_sha = $revision_sha
                RETURN root.uid AS uid
                LIMIT 1
                """,
                **common,
            )
            if await root_result.single(strict=False) is None:
                return False

            await transaction.run(_DELETE_ONBOARDING_PROJECTION_QUERY, **common)
            if step_nodes:
                await transaction.run(
                    _NODE_QUERIES["EnvStep"], items=step_nodes, **common
                )
            if requires_edges:
                await transaction.run(
                    _EDGE_QUERIES["REQUIRES"],
                    items=requires_edges,
                    org_id=scope.org_id,
                )
            return True

        async with instrument_graph_query(
            scope.org_id, QUERY_SHAPE_WRITE
        ) as measurement:
            async with self._driver.session() as session:
                applied = await session.execute_write(replace_projection)
            measurement.set_result_node_count(len(write.nodes) if applied else 0)
        return applied

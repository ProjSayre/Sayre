"""Instrumented Neo4j head-projection writer using closed, static Cypher shapes."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from neo4j import AsyncDriver, AsyncGraphDatabase

from sayre_workers.config import get_config, get_secret
from sayre_workers.telemetry.graph_metrics import (
    QUERY_SHAPE_TRAVERSAL,
    QUERY_SHAPE_WRITE,
    instrument_graph_query,
)

from .models import GraphProjection, GraphScope, SymbolRef


class GraphStore(Protocol):
    async def load_symbols(self, scope: GraphScope) -> tuple[SymbolRef, ...]: ...

    async def apply(self, projection: GraphProjection) -> None: ...


_NODE_QUERIES = {
    "Folder": """
        UNWIND $items AS item
        MERGE (node:Folder {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.path = item.path, node.name = item.name
    """,
    "File": """
        UNWIND $items AS item
        MERGE (node:File {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.path = item.path,
            node.name = item.name, node.language = item.language
    """,
    "Function": """
        UNWIND $items AS item
        MERGE (node:Function {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.file_path = item.file_path,
            node.name = item.name, node.qualified_name = item.qualified_name,
            node.signature = item.signature, node.start_line = item.start_line,
            node.end_line = item.end_line
    """,
    "Class": """
        UNWIND $items AS item
        MERGE (node:Class {org_id: $org_id, uid: item.uid})
        SET node.repo_id = $repo_id, node.ref_name = $ref_name,
            node.revision_sha = $revision_sha, node.file_path = item.file_path,
            node.name = item.name, node.qualified_name = item.qualified_name,
            node.start_line = item.start_line, node.end_line = item.end_line
    """,
}

_EDGE_QUERIES = {
    "CONTAINS": """
        UNWIND $items AS item
        MATCH (source {org_id: $org_id, uid: item.source_uid})
        MATCH (target {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:CONTAINS {org_id: $org_id}]->(target)
    """,
    "IMPORTS": """
        UNWIND $items AS item
        MATCH (source:File {org_id: $org_id, uid: item.source_uid})
        MATCH (target:File {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:IMPORTS {org_id: $org_id}]->(target)
    """,
    "CALLS": """
        UNWIND $items AS item
        MATCH (source:Function {org_id: $org_id, uid: item.source_uid})
        MATCH (target:Function {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:CALLS {org_id: $org_id}]->(target)
    """,
    "INHERITS": """
        UNWIND $items AS item
        MATCH (source:Class {org_id: $org_id, uid: item.source_uid})
        MATCH (target:Class {org_id: $org_id, uid: item.target_uid})
        MERGE (source)-[edge:INHERITS {org_id: $org_id}]->(target)
    """,
}


class Neo4jGraphStore:
    def __init__(self, driver: AsyncDriver) -> None:
        self._driver = driver

    @classmethod
    async def from_config(cls) -> "Neo4jGraphStore":
        password = await get_secret("env://NEO4J_PASSWORD")
        driver = AsyncGraphDatabase.driver(
            get_config("NEO4J_URI"), auth=(get_config("NEO4J_USER"), password)
        )
        return cls(driver)

    async def close(self) -> None:
        await self._driver.close()

    async def load_symbols(self, scope: GraphScope) -> tuple[SymbolRef, ...]:
        query = """
            MATCH (node {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
            WHERE node:Function OR node:Class
            RETURN CASE WHEN node:Function THEN 'Function' ELSE 'Class' END AS label,
                   node.uid AS uid, node.file_path AS file_path, node.name AS name,
                   node.qualified_name AS qualified_name
            ORDER BY label, file_path, qualified_name
        """
        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_TRAVERSAL) as measurement:
            records, _summary, _keys = await self._driver.execute_query(
                query,
                org_id=scope.org_id,
                repo_id=scope.repository_id,
                ref_name=scope.ref_name,
            )
            measurement.set_result_node_count(len(records))
        return tuple(
            SymbolRef(
                label=record["label"],
                uid=record["uid"],
                file_path=record["file_path"],
                name=record["name"],
                qualified_name=record["qualified_name"],
            )
            for record in records
        )

    async def apply(self, projection: GraphProjection) -> None:
        scope = projection.scope
        nodes_by_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for node in projection.nodes:
            nodes_by_label[node.label].append({"uid": node.uid, **node.properties})
        edges_by_type: dict[str, list[dict[str, str]]] = defaultdict(list)
        for edge in projection.edges:
            edges_by_type[edge.relationship].append(
                {"source_uid": edge.source_uid, "target_uid": edge.target_uid}
            )

        async def write_projection(transaction: Any) -> None:
            common = {
                "org_id": scope.org_id,
                "repo_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
            }
            if projection.full_rebuild:
                for label in ("Function", "Class", "File", "Folder"):
                    await transaction.run(
                        f"MATCH (node:{label} {{org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name}}) DETACH DELETE node",
                        **common,
                    )
            else:
                affected = list(projection.affected_file_paths)
                current_files = list(projection.current_file_paths)
                current_folders = list(projection.current_folder_paths)
                function_uids = [node["uid"] for node in nodes_by_label["Function"]]
                class_uids = [node["uid"] for node in nodes_by_label["Class"]]
                await transaction.run(
                    """
                    MATCH (node:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
                    WHERE NOT (node.path IN $current_files)
                    DETACH DELETE node
                    """,
                    current_files=current_files,
                    **common,
                )
                await transaction.run(
                    """
                    MATCH (node:Folder {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
                    WHERE NOT (node.path IN $current_folders)
                    DETACH DELETE node
                    """,
                    current_folders=current_folders,
                    **common,
                )
                for label, valid_uids in (("Function", function_uids), ("Class", class_uids)):
                    await transaction.run(
                        f"""
                        MATCH (node:{label} {{org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name}})
                        WHERE node.file_path IN $affected AND NOT (node.uid IN $valid_uids)
                        DETACH DELETE node
                        """,
                        affected=affected,
                        valid_uids=valid_uids,
                        **common,
                    )
                await transaction.run(
                    """
                    MATCH (source:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
                    WHERE source.path IN $affected
                    MATCH (source)-[edge:IMPORTS]->()
                    DELETE edge
                    """,
                    affected=affected,
                    **common,
                )
                await transaction.run(
                    """
                    MATCH (source:Function {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
                    WHERE source.file_path IN $affected
                    MATCH (source)-[edge:CALLS]->()
                    DELETE edge
                    """,
                    affected=affected,
                    **common,
                )
                await transaction.run(
                    """
                    MATCH (source:Class {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name})
                    WHERE source.file_path IN $affected
                    MATCH (source)-[edge:INHERITS]->()
                    DELETE edge
                    """,
                    affected=affected,
                    **common,
                )

            for label, query in _NODE_QUERIES.items():
                await transaction.run(query, items=nodes_by_label[label], **common)
            if not projection.full_rebuild:
                for label in ("Function", "Class"):
                    await transaction.run(
                        f"""
                        MATCH (node:{label} {{org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name}})
                        SET node.revision_sha = $revision_sha
                        """,
                        **common,
                    )
            for relationship, query in _EDGE_QUERIES.items():
                await transaction.run(query, items=edges_by_type[relationship], **common)

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_WRITE) as measurement:
            async with self._driver.session() as session:
                await session.execute_write(write_projection)
            measurement.set_result_node_count(len(projection.nodes))

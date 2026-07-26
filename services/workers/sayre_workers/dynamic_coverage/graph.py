"""Tenant/revision-scoped COVERS topology reads and atomic measured refreshes."""

from __future__ import annotations

from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Protocol

from neo4j import AsyncDriver, AsyncGraphDatabase

from sayre_workers.config import get_config, get_secret
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.ingestion.projection import stable_uid
from sayre_workers.telemetry.graph_metrics import (
    QUERY_SHAPE_TRAVERSAL,
    QUERY_SHAPE_WRITE,
    instrument_graph_query,
)

from .impact import CoverageTopologyEdge
from .models import CoverageRunReport


class InvalidCoverageReportError(ValueError):
    """A measured report references data outside the current graph head."""


class CoverageGraphStore(Protocol):
    async def load_topology(self, scope: GraphScope) -> tuple[CoverageTopologyEdge, ...]: ...

    async def apply_report(self, report: CoverageRunReport) -> bool: ...


_LOAD_TOPOLOGY_CYPHER = """
MATCH (root:Folder {
    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name, path: ''
})
WHERE root.revision_sha = $revision_sha
MATCH (test:Test)-[coverage:COVERS]->(file:File)
WHERE test.org_id = $org_id
  AND file.org_id = $org_id
  AND coverage.org_id = $org_id
  AND test.repo_id = $repo_id
  AND file.repo_id = $repo_id
  AND coverage.repo_id = $repo_id
  AND test.ref_name = $ref_name
  AND file.ref_name = $ref_name
  AND coverage.ref_name = $ref_name
  AND test.revision_sha = $revision_sha
  AND file.revision_sha = $revision_sha
  AND coverage.revision_sha = $revision_sha
RETURN test.path AS test_path,
       file.path AS file_path,
       coverage.status AS status,
       coverage.last_run AS last_run
ORDER BY test.path, file.path
"""


def _timestamp(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if value is not None and type(value).__module__.startswith("neo4j.time"):
        return str(value)
    return None


class Neo4jCoverageGraphStore:
    def __init__(self, driver: AsyncDriver) -> None:
        self._driver = driver

    @classmethod
    async def from_config(cls) -> "Neo4jCoverageGraphStore":
        password = await get_secret("env://NEO4J_PASSWORD")
        return cls(
            AsyncGraphDatabase.driver(
                get_config("NEO4J_URI"),
                auth=(get_config("NEO4J_USER"), password),
            )
        )

    async def close(self) -> None:
        await self._driver.close()

    async def load_topology(self, scope: GraphScope) -> tuple[CoverageTopologyEdge, ...]:
        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_TRAVERSAL) as measurement:
            records, _summary, _keys = await self._driver.execute_query(
                _LOAD_TOPOLOGY_CYPHER,
                org_id=scope.org_id,
                repo_id=scope.repository_id,
                ref_name=scope.ref_name,
                revision_sha=scope.revision_sha,
            )
            measurement.set_result_node_count(len(records))

        edges: list[CoverageTopologyEdge] = []
        for record in records:
            status = record["status"]
            last_run = _timestamp(record["last_run"])
            if status not in {"inferred", "measured"}:
                continue
            try:
                parsed_last_run = (
                    datetime.fromisoformat(last_run.replace("Z", "+00:00"))
                    if last_run
                    else None
                )
            except ValueError:
                parsed_last_run = None
            if (
                parsed_last_run is not None
                and (
                    parsed_last_run.tzinfo is None
                    or parsed_last_run.utcoffset() is None
                )
            ):
                parsed_last_run = None
            edges.append(
                CoverageTopologyEdge(
                    test_path=record["test_path"],
                    file_path=record["file_path"],
                    status=status,
                    last_run=parsed_last_run,
                )
            )
        return tuple(edges)

    async def apply_report(self, report: CoverageRunReport) -> bool:
        scope = report.graph_scope()
        tests = [
            {
                "uid": stable_uid(scope, "Test", measurement.test_path),
                "path": measurement.test_path,
                "name": PurePosixPath(measurement.test_path).name,
                "coverage_status": measurement.outcome,
            }
            for measurement in report.measurements
        ]
        edges = [
            {
                "source_uid": stable_uid(scope, "Test", measurement.test_path),
                "file_path": file_path,
                "status": "measured",
                "last_run": report.completed_at.isoformat(),
            }
            for measurement in report.measurements
            for file_path in measurement.file_paths
        ]
        requested_file_paths = sorted({edge["file_path"] for edge in edges})
        common = {
            "org_id": scope.org_id,
            "repo_id": scope.repository_id,
            "ref_name": scope.ref_name,
            "revision_sha": scope.revision_sha,
        }

        async def write_report(transaction: Any) -> bool:
            root_result = await transaction.run(
                """
                MATCH (root:Folder {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name, path: ''
                })
                WHERE root.revision_sha = $revision_sha
                SET root.revision_sha = root.revision_sha
                RETURN root.uid AS uid
                """,
                **common,
            )
            if await root_result.single() is None:
                return False

            files_result = await transaction.run(
                """
                UNWIND $file_paths AS requested_path
                OPTIONAL MATCH (file:File {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, path: requested_path
                })
                RETURN requested_path AS requested_path, file.path AS found_path
                """,
                file_paths=requested_file_paths,
                **common,
            )
            file_records = await files_result.data()
            missing = [
                record["requested_path"]
                for record in file_records
                if record["found_path"] is None
            ]
            if missing:
                raise InvalidCoverageReportError(
                    "coverage report references files outside the current graph head"
                )

            await transaction.run(
                """
                UNWIND $tests AS item
                MERGE (test:Test {org_id: $org_id, uid: item.uid})
                SET test.repo_id = $repo_id,
                    test.ref_name = $ref_name,
                    test.revision_sha = $revision_sha,
                    test.path = item.path,
                    test.name = item.name,
                    test.coverage_status = item.coverage_status
                """,
                tests=tests,
                **common,
            )
            await transaction.run(
                """
                UNWIND $tests AS item
                MATCH (test:Test {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, uid: item.uid
                })-[coverage:COVERS {org_id: $org_id}]->(:File {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha
                })
                DELETE coverage
                """,
                tests=tests,
                **common,
            )
            await transaction.run(
                """
                UNWIND $edges AS item
                MATCH (test:Test {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, uid: item.source_uid
                })
                MATCH (file:File {
                    org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name,
                    revision_sha: $revision_sha, path: item.file_path
                })
                MERGE (test)-[coverage:COVERS {org_id: $org_id}]->(file)
                SET coverage.repo_id = $repo_id,
                    coverage.ref_name = $ref_name,
                    coverage.revision_sha = $revision_sha,
                    coverage.status = item.status,
                    coverage.last_run = item.last_run
                """,
                edges=edges,
                **common,
            )
            return True

        async with instrument_graph_query(scope.org_id, QUERY_SHAPE_WRITE) as measurement:
            async with self._driver.session() as session:
                applied = await session.execute_write(write_report)
            measurement.set_result_node_count(len(tests) + len(edges) if applied else 0)
        return applied

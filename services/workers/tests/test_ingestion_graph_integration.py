"""GAP-3 gap-fill: `Neo4jGraphStore.apply`/`load_symbols` proved against a REAL
Cypher engine, replacing the fake-driven ("we assume this works") coverage that
previously only ever exercised `graph.py` through a hand-rolled in-memory recorder.

Skip-gating convention (spec.md's "Skip-gating convention for the two real-infra
suites" section) mirrors `tests/test_graph_migrations.py:820-846` EXACTLY, on
purpose -- no new mechanism is invented here: a `functools.lru_cache`-memoized
reachability probe calling `driver.verify_connectivity()` inside a `try/except`
with a short connect timeout, gating a module-level `pytestmark`. A machine with
no reachable Neo4j must still see `poetry run pytest` finish green (EC-25).

Each test seeds a fresh random-UUID org and cleans up via an org-scoped
`DETACH DELETE` in a `finally` block, so repeated runs never collide and never
leave residue in a shared dev Neo4j instance.
"""

from __future__ import annotations

import asyncio
import functools
import uuid

import pytest

from sayre_workers.config import get_config, get_secret
from sayre_workers.ingestion.graph import Neo4jGraphStore
from sayre_workers.ingestion.models import GraphEdge, GraphNode, GraphProjection, GraphScope


@functools.lru_cache(maxsize=1)
def _neo4j_config() -> tuple[str, str, str]:
    async def resolve() -> tuple[str, str, str]:
        password = await get_secret("env://NEO4J_PASSWORD")
        return get_config("NEO4J_URI"), get_config("NEO4J_USER"), password

    return asyncio.run(resolve())


@functools.lru_cache(maxsize=1)
def _neo4j_reachable() -> bool:
    try:
        import neo4j

        uri, user, password = _neo4j_config()
        driver = neo4j.GraphDatabase.driver(uri, auth=(user, password), connection_timeout=2)
        try:
            driver.verify_connectivity()
            return True
        finally:
            driver.close()
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _neo4j_reachable(),
    reason="Neo4j unreachable -- skipping real-Neo4j ingestion graph integration suite",
)


def _scope(org_id: str, revision_sha: str) -> GraphScope:
    return GraphScope(
        org_id=org_id,
        repository_id=f"repo-{org_id}",
        ref_name="refs/heads/main",
        revision_sha=revision_sha,
    )


def _projection_at_head_a(scope: GraphScope) -> GraphProjection:
    folder_uid = f"folder::{scope.org_id}"
    file_a_uid = f"file-a::{scope.org_id}"
    file_b_uid = f"file-b::{scope.org_id}"
    function_uid = f"function::{scope.org_id}"
    class_uid = f"class::{scope.org_id}"
    test_uid = f"test::{scope.org_id}"
    base_properties = {
        "org_id": scope.org_id,
        "repo_id": scope.repository_id,
        "ref_name": scope.ref_name,
        "revision_sha": scope.revision_sha,
    }
    nodes = (
        GraphNode("Folder", folder_uid, {**base_properties, "path": "src", "name": "src"}),
        GraphNode(
            "File",
            file_a_uid,
            {**base_properties, "path": "src/a.py", "name": "a.py", "language": "python"},
        ),
        GraphNode(
            "File",
            file_b_uid,
            {**base_properties, "path": "src/b.py", "name": "b.py", "language": "python"},
        ),
        GraphNode(
            "Function",
            function_uid,
            {
                **base_properties,
                "file_path": "src/a.py",
                "name": "run",
                "qualified_name": "run",
                "signature": "run()",
                "start_line": 1,
                "end_line": 2,
            },
        ),
        GraphNode(
            "Class",
            class_uid,
            {
                **base_properties,
                "file_path": "src/b.py",
                "name": "Widget",
                "qualified_name": "Widget",
                "start_line": 1,
                "end_line": 2,
            },
        ),
        GraphNode(
            "Test",
            test_uid,
            {**base_properties, "path": "src/a.py", "name": "a.py", "coverage_status": "inferred"},
        ),
    )
    edges = (
        GraphEdge("CONTAINS", folder_uid, file_a_uid),
        GraphEdge("CONTAINS", folder_uid, file_b_uid),
        GraphEdge("IMPORTS", file_a_uid, file_b_uid),
        GraphEdge("CALLS", function_uid, function_uid),
        GraphEdge("INHERITS", class_uid, class_uid),
        GraphEdge(
            "COVERS",
            test_uid,
            file_a_uid,
            {"status": "inferred", "last_run": None},
        ),
    )
    return GraphProjection(
        scope=scope,
        nodes=nodes,
        edges=edges,
        current_file_paths=("src/a.py", "src/b.py"),
        current_folder_paths=("", "src"),
        affected_file_paths=("src/a.py", "src/b.py"),
        full_rebuild=True,
    )


async def _cleanup(driver, org_id: str) -> None:
    async with driver.session() as session:
        await session.run("MATCH (n {org_id: $org_id}) DETACH DELETE n", org_id=org_id)


@pytest.mark.asyncio
# @spec AC-5 EC-17
async def test_full_rebuild_projection_lands_every_node_and_edge_type_against_real_neo4j() -> None:
    import neo4j

    uri, user, password = _neo4j_config()
    driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
    org_id = str(uuid.uuid4())
    try:
        store = Neo4jGraphStore(driver)
        scope = _scope(org_id, "a" * 40)
        projection = _projection_at_head_a(scope)

        await store.apply(projection)
        # EC-17: double-apply of the SAME projection is idempotent (no duplicate
        # nodes/edges from the MERGE shapes).
        await store.apply(projection)

        async with driver.session() as session:
            node_result = await session.run(
                "MATCH (n {org_id: $org_id}) "
                "RETURN labels(n)[0] AS label, n.uid AS uid, n.repo_id AS repo_id, "
                "n.ref_name AS ref_name, n.revision_sha AS revision_sha, "
                "coalesce(n.path, n.file_path) AS path",
                org_id=org_id,
            )
            node_rows = [record async for record in node_result]
            labels_seen = {row["label"] for row in node_rows}
            assert labels_seen == {"Folder", "File", "Function", "Class", "Test"}
            assert len(node_rows) == len(projection.nodes)  # no duplication after double-apply
            for row in node_rows:
                assert row["repo_id"] == scope.repository_id
                assert row["ref_name"] == scope.ref_name
                assert row["revision_sha"] == scope.revision_sha

            edge_result = await session.run(
                "MATCH (source {org_id: $org_id})-[edge {org_id: $org_id}]->"
                "(target {org_id: $org_id}) RETURN type(edge) AS relationship",
                org_id=org_id,
            )
            edge_rows = [record async for record in edge_result]
            relationships_seen = {row["relationship"] for row in edge_rows}
            assert relationships_seen == {"CONTAINS", "IMPORTS", "CALLS", "INHERITS", "COVERS"}
            assert len(edge_rows) == len(projection.edges)  # no duplication after double-apply
    finally:
        await _cleanup(driver, org_id)
        await driver.close()


@pytest.mark.asyncio
# @spec EC-15
async def test_cross_org_isolation_on_full_rebuild_delete_against_real_neo4j() -> None:
    import neo4j

    uri, user, password = _neo4j_config()
    driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
    org_a = str(uuid.uuid4())
    org_b = str(uuid.uuid4())
    try:
        store = Neo4jGraphStore(driver)
        scope_a = _scope(org_a, "a" * 40)
        scope_b = _scope(org_b, "a" * 40)
        # Deliberately identical node uids across orgs -- proves isolation is by
        # org_id, not merely by (accidentally) distinct uid namespacing.
        shared_uid_projection_a = GraphProjection(
            scope=scope_a,
            nodes=(
                GraphNode(
                    "File",
                    "shared-uid",
                    {
                        "org_id": scope_a.org_id,
                        "repo_id": scope_a.repository_id,
                        "ref_name": scope_a.ref_name,
                        "revision_sha": scope_a.revision_sha,
                        "path": "shared.py",
                        "name": "shared.py",
                        "language": "python",
                    },
                ),
            ),
            edges=(),
            current_file_paths=("shared.py",),
            current_folder_paths=("",),
            affected_file_paths=("shared.py",),
            full_rebuild=True,
        )
        shared_uid_projection_b = GraphProjection(
            scope=scope_b,
            nodes=(
                GraphNode(
                    "File",
                    "shared-uid",
                    {
                        "org_id": scope_b.org_id,
                        "repo_id": scope_b.repository_id,
                        "ref_name": scope_b.ref_name,
                        "revision_sha": scope_b.revision_sha,
                        "path": "shared.py",
                        "name": "shared.py",
                        "language": "python",
                    },
                ),
            ),
            edges=(),
            current_file_paths=("shared.py",),
            current_folder_paths=("",),
            affected_file_paths=("shared.py",),
            full_rebuild=True,
        )

        await store.apply(shared_uid_projection_a)
        await store.apply(shared_uid_projection_b)
        symbols_a_before = await store.load_symbols(scope_a)

        # A full-rebuild EMPTY projection for org A (its DETACH DELETE) must not
        # touch org B's identically-uid'd node.
        empty_projection_a = GraphProjection(
            scope=scope_a,
            nodes=(),
            edges=(),
            current_file_paths=(),
            current_folder_paths=(),
            affected_file_paths=(),
            full_rebuild=True,
        )
        await store.apply(empty_projection_a)

        async with driver.session() as session:
            result = await session.run(
                "MATCH (n {org_id: $org_id, uid: 'shared-uid'}) RETURN count(n) AS c",
                org_id=org_b,
            )
            record = await result.single()
            assert record["c"] == 1, "org B's node must survive org A's full-rebuild delete"

            result_a = await session.run(
                "MATCH (n {org_id: $org_id, uid: 'shared-uid'}) RETURN count(n) AS c",
                org_id=org_a,
            )
            record_a = await result_a.single()
            assert record_a["c"] == 0, "org A's own node IS cleared by its full-rebuild"

        assert symbols_a_before == ()  # no Function/Class in this fixture
    finally:
        await _cleanup(driver, org_a)
        await _cleanup(driver, org_b)
        await driver.close()


@pytest.mark.asyncio
# @spec EC-16
async def test_empty_projection_against_real_neo4j_completes_without_error() -> None:
    import neo4j

    uri, user, password = _neo4j_config()
    driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
    org_id = str(uuid.uuid4())
    try:
        store = Neo4jGraphStore(driver)
        scope = _scope(org_id, "a" * 40)
        projection = _projection_at_head_a(scope)
        await store.apply(projection)

        empty_projection = GraphProjection(
            scope=scope,
            nodes=(),
            edges=(),
            current_file_paths=(),
            current_folder_paths=(),
            affected_file_paths=(),
            full_rebuild=True,
        )
        await store.apply(empty_projection)  # must not raise

        async with driver.session() as session:
            result = await session.run(
                "MATCH (n {org_id: $org_id}) RETURN count(n) AS c", org_id=org_id
            )
            record = await result.single()
            assert record["c"] == 0
    finally:
        await _cleanup(driver, org_id)
        await driver.close()


@pytest.mark.asyncio
# @spec AC-5
async def test_load_symbols_returns_the_just_written_function_and_class() -> None:
    import neo4j

    uri, user, password = _neo4j_config()
    driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
    org_id = str(uuid.uuid4())
    try:
        store = Neo4jGraphStore(driver)
        scope = _scope(org_id, "a" * 40)
        projection = _projection_at_head_a(scope)
        await store.apply(projection)

        symbols = await store.load_symbols(scope)
        labels = {symbol.label for symbol in symbols}
        names = {symbol.name for symbol in symbols}
        assert labels == {"Function", "Class"}
        assert names == {"run", "Widget"}
    finally:
        await _cleanup(driver, org_id)
        await driver.close()


@pytest.mark.asyncio
# @spec AC-5
async def test_delta_projection_prunes_removed_paths_and_leaves_others_against_real_neo4j() -> None:
    import neo4j

    uri, user, password = _neo4j_config()
    driver = neo4j.AsyncGraphDatabase.driver(uri, auth=(user, password))
    org_id = str(uuid.uuid4())
    try:
        store = Neo4jGraphStore(driver)
        scope_1 = _scope(org_id, "a" * 40)
        projection_1 = _projection_at_head_a(scope_1)
        await store.apply(projection_1)

        # Delta: src/b.py (and its Class) leaves the head; src/a.py is untouched.
        scope_2 = _scope(org_id, "b" * 40)
        folder_uid = f"folder::{org_id}"
        base_properties = {
            "org_id": scope_2.org_id,
            "repo_id": scope_2.repository_id,
            "ref_name": scope_2.ref_name,
            "revision_sha": scope_2.revision_sha,
        }
        delta_projection = GraphProjection(
            scope=scope_2,
            nodes=(
                GraphNode("Folder", folder_uid, {**base_properties, "path": "src", "name": "src"}),
            ),
            edges=(),
            current_file_paths=("src/a.py",),
            current_folder_paths=("", "src"),
            affected_file_paths=("src/b.py",),
            full_rebuild=False,
        )
        await store.apply(delta_projection)

        async with driver.session() as session:
            file_result = await session.run(
                "MATCH (n:File {org_id: $org_id}) RETURN n.path AS path", org_id=org_id
            )
            file_paths = {record["path"] async for record in file_result}
            assert file_paths == {"src/a.py"}

            class_result = await session.run(
                "MATCH (n:Class {org_id: $org_id}) RETURN count(n) AS c", org_id=org_id
            )
            class_record = await class_result.single()
            assert class_record["c"] == 0
    finally:
        await _cleanup(driver, org_id)
        await driver.close()

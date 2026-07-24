from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from sayre_workers.enrichment.enrichment_graph import Neo4jEnrichmentGraphStore
from sayre_workers.enrichment.feature_clustering import (
    build_feature_clustering_request,
    canonical_feature_key,
    canonicalize_feature_clustering_write,
)
from sayre_workers.enrichment.graphify_adapter import GraphifyAdapterFactory
from sayre_workers.enrichment.models import (
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentJob,
    EnrichmentNode,
    EnrichmentWrite,
    FileContext,
    GenerationConfig,
    InvalidEnrichmentWriteError,
)
from sayre_workers.enrichment.providers import (
    ModelProviderFactory,
    StructuredGenerationResponse,
)
from sayre_workers.enrichment.service import EnrichmentService
from sayre_workers.enrichment.state_store import ProviderJobState
from sayre_workers.ingestion.graph import Neo4jGraphStore
from sayre_workers.ingestion.models import GraphNode, GraphProjection, GraphScope
from sayre_workers.ingestion.projection import stable_uid

SHA = "c" * 40
FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "feature_clustering"


def _scope(*, revision_sha: str = SHA) -> GraphScope:
    return GraphScope("org-a", "repo-a", "refs/heads/main", revision_sha)


def _fixture_context(scope: GraphScope | None = None) -> EnrichmentContext:
    resolved_scope = scope or _scope()
    paths = tuple(
        sorted(
            path.relative_to(FIXTURE_ROOT).as_posix()
            for path in FIXTURE_ROOT.rglob("*")
            if path.is_file()
        )
    )
    return EnrichmentContext(
        scope=resolved_scope,
        files=tuple(
            FileContext(
                uid=stable_uid(resolved_scope, "File", path),
                path=path,
                language="typescript",
            )
            for path in paths
        ),
    )


def _checkout_candidate(
    context: EnrichmentContext,
    *,
    adapter_uid: str = "model-local-checkout",
    name: str = "Checkout",
) -> EnrichmentWrite:
    return EnrichmentWrite(
        scope=context.scope,
        nodes=(
            EnrichmentNode(
                label="Feature",
                uid=adapter_uid,
                properties={
                    "name": name,
                    "description": "Completes checkout from the API through the web UI.",
                    "team": "Commerce",
                },
            ),
        ),
        edges=tuple(
            EnrichmentEdge(
                relationship="PART_OF",
                source_uid=file.uid,
                target_uid=adapter_uid,
            )
            for file in context.files
        ),
    )


def test_feature_fixture_spans_api_shared_and_web_with_one_stable_feature() -> None:
    context = _fixture_context()

    write = canonicalize_feature_clustering_write(context, _checkout_candidate(context))

    assert {file.path for file in context.files} == {
        "api/checkout_route.ts",
        "shared/checkout.ts",
        "web/CheckoutPanel.tsx",
    }
    assert len(write.nodes) == 1
    [feature] = write.nodes
    assert feature.uid == stable_uid(context.scope, "Feature", "checkout")
    assert feature.properties == {
        "name": "Checkout",
        "description": "Completes checkout from the API through the web UI.",
        "team": "Commerce",
    }
    assert len(write.edges) == 3
    assert {edge.relationship for edge in write.edges} == {"PART_OF"}
    assert {edge.source_uid for edge in write.edges} == {
        file.uid for file in context.files
    }
    assert {edge.target_uid for edge in write.edges} == {feature.uid}


def test_adapter_local_ids_do_not_change_canonical_feature_identity() -> None:
    context = _fixture_context()

    first = canonicalize_feature_clustering_write(
        context, _checkout_candidate(context, adapter_uid="first-id")
    )
    second = canonicalize_feature_clustering_write(
        context, _checkout_candidate(context, adapter_uid="different-id")
    )

    assert first == second


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Checkout", "checkout"),
        (" checkout  ", "checkout"),
        ("CHECK-out", "check-out"),
        ("Customer Billing / Invoices", "customer-billing-invoices"),
    ],
)
def test_canonical_feature_key_normalizes_display_variants(name: str, expected: str) -> None:
    assert canonical_feature_key(name) == expected


def test_feature_clustering_request_is_deterministic_and_omits_tenant_identity() -> None:
    context = _fixture_context(GraphScope("org-sensitive", "repo-a", "refs/heads/main", SHA))

    first = build_feature_clustering_request(context)
    second = build_feature_clustering_request(
        EnrichmentContext(scope=context.scope, files=tuple(reversed(context.files)))
    )
    payload = json.loads(first.input)

    assert first == second
    assert "org-sensitive" not in first.input
    assert [item["path"] for item in payload["files"]] == sorted(
        file.path for file in context.files
    )
    assert "File -> Feature PART_OF" in first.system
    assert "folder" in first.system.lower()


def test_feature_clustering_rejects_ticket_owned_references() -> None:
    context = _fixture_context()
    candidate = _checkout_candidate(context)
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=candidate.nodes,
        edges=(
            EnrichmentEdge(
                relationship="REFERENCES",
                source_uid=candidate.nodes[0].uid,
                target_uid=context.files[0].uid,
            ),
        ),
    )

    with pytest.raises(InvalidEnrichmentWriteError, match="REFERENCES"):
        canonicalize_feature_clustering_write(context, candidate)


def test_empty_feature_result_is_a_valid_projection_clear() -> None:
    context = _fixture_context()

    assert canonicalize_feature_clustering_write(
        context, EnrichmentWrite(scope=context.scope)
    ) == EnrichmentWrite(scope=context.scope)


def test_one_file_can_participate_in_multiple_distinct_features() -> None:
    context = _fixture_context()
    file_uid = context.files[0].uid
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=(
            _checkout_candidate(context, adapter_uid="checkout").nodes[0],
            EnrichmentNode(
                label="Feature",
                uid="cart",
                properties={
                    "name": "Shopping cart",
                    "description": "Collects items before checkout.",
                    "team": "Commerce",
                },
            ),
        ),
        edges=(
            EnrichmentEdge("PART_OF", file_uid, "checkout"),
            EnrichmentEdge("PART_OF", file_uid, "cart"),
        ),
    )

    write = canonicalize_feature_clustering_write(context, candidate)

    assert len(write.nodes) == 2
    assert len(write.edges) == 2
    assert {edge.target_uid for edge in write.edges} == {
        node.uid for node in write.nodes
    }


def test_canonicalizer_rejects_out_of_context_file() -> None:
    context = _fixture_context()
    candidate = _checkout_candidate(context)
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=candidate.nodes,
        edges=(
            EnrichmentEdge(
                relationship="PART_OF",
                source_uid="hallucinated-file",
                target_uid=candidate.nodes[0].uid,
            ),
        ),
    )

    with pytest.raises(InvalidEnrichmentWriteError, match="File -> Feature"):
        canonicalize_feature_clustering_write(context, candidate)


def test_canonicalizer_rejects_unknown_feature_target() -> None:
    context = _fixture_context()
    candidate = _checkout_candidate(context)
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=candidate.nodes,
        edges=(
            EnrichmentEdge(
                relationship="PART_OF",
                source_uid=context.files[0].uid,
                target_uid="hallucinated-feature",
            ),
        ),
    )

    with pytest.raises(InvalidEnrichmentWriteError, match="File -> Feature"):
        canonicalize_feature_clustering_write(context, candidate)


def test_canonicalizer_rejects_duplicate_canonical_features() -> None:
    context = _fixture_context()
    first_file, second_file, *_rest = context.files
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=(
            _checkout_candidate(context, adapter_uid="one").nodes[0],
            _checkout_candidate(
                context, adapter_uid="two", name=" CHECKOUT "
            ).nodes[0],
        ),
        edges=(
            EnrichmentEdge("PART_OF", first_file.uid, "one"),
            EnrichmentEdge("PART_OF", second_file.uid, "two"),
        ),
    )

    with pytest.raises(InvalidEnrichmentWriteError, match="same identity"):
        canonicalize_feature_clustering_write(context, candidate)


def test_canonicalizer_rejects_two_relations_for_one_ordered_pair() -> None:
    context = _fixture_context()
    candidate = _checkout_candidate(context)
    first_edge = candidate.edges[0]
    candidate = EnrichmentWrite(
        scope=context.scope,
        nodes=candidate.nodes,
        edges=(first_edge, first_edge),
    )

    with pytest.raises(InvalidEnrichmentWriteError, match="at most one relationship"):
        canonicalize_feature_clustering_write(context, candidate)


@pytest.mark.parametrize(
    "candidate",
    [
        EnrichmentWrite(
            scope=_scope(),
            nodes=(
                EnrichmentNode(
                    "Feature",
                    "bad-properties",
                    {"name": "Checkout", "description": "x", "team": None, "extra": True},
                ),
            ),
        ),
        EnrichmentWrite(
            scope=_scope(),
            nodes=(
                EnrichmentNode(
                    "Feature",
                    "bad-team",
                    {"name": "Checkout", "description": "x", "team": 42},
                ),
            ),
        ),
        EnrichmentWrite(
            scope=_scope(),
            nodes=(
                EnrichmentNode(
                    "Feature",
                    "blank-description",
                    {"name": "Checkout", "description": " ", "team": None},
                ),
            ),
        ),
        EnrichmentWrite(
            scope=_scope(),
            nodes=(
                EnrichmentNode(
                    "Feature",
                    "orphan",
                    {"name": "Checkout", "description": "x", "team": None},
                ),
            ),
        ),
    ],
)
def test_canonicalizer_rejects_invalid_or_orphaned_feature(
    candidate: EnrichmentWrite,
) -> None:
    with pytest.raises(InvalidEnrichmentWriteError):
        canonicalize_feature_clustering_write(_fixture_context(), candidate)


class _RecordingGraphStore:
    def __init__(
        self,
        context: EnrichmentContext,
        *,
        current: bool = True,
        apply_current: bool = True,
    ) -> None:
        self.context = context
        self.current = current
        self.apply_current = apply_current
        self.current_checks = 0
        self.load_arguments: list[tuple[tuple[str, ...], bool]] = []
        self.feature_writes: list[EnrichmentWrite] = []
        self.generic_writes: list[EnrichmentWrite] = []

    async def is_current(self, scope: GraphScope) -> bool:
        self.current_checks += 1
        return self.current and scope == self.context.scope

    async def load_context(
        self,
        scope: GraphScope,
        changed_paths: tuple[str, ...],
        full_rebuild: bool,
    ) -> EnrichmentContext:
        assert scope == self.context.scope
        self.load_arguments.append((changed_paths, full_rebuild))
        return self.context

    async def apply(self, write: EnrichmentWrite) -> None:
        self.generic_writes.append(write)

    async def apply_feature_projection(self, write: EnrichmentWrite) -> bool:
        if not self.apply_current:
            return False
        self.feature_writes.append(write)
        return True


class _RecordingConfigStore:
    def __init__(self) -> None:
        self.org_ids: list[str] = []

    async def load_generation_config(self, org_id: str) -> GenerationConfig:
        self.org_ids.append(org_id)
        return GenerationConfig(provider="fake_deterministic", model="ci")


class _RecordingStateStore:
    def __init__(self) -> None:
        self.states: list[ProviderJobState] = []

    async def set_state(self, state: ProviderJobState) -> None:
        self.states.append(state)


class _CheckoutGraphifyAdapter:
    def schema(self, context: EnrichmentContext) -> Mapping[str, Any]:
        del context
        return {}

    async def shape(
        self,
        context: EnrichmentContext,
        generation: StructuredGenerationResponse,
    ) -> EnrichmentWrite:
        assert isinstance(generation.data, dict)
        return _checkout_candidate(context)


class _CheckoutGraphifyFactory(GraphifyAdapterFactory):
    def create(self) -> _CheckoutGraphifyAdapter:
        return _CheckoutGraphifyAdapter()


def _job(context: EnrichmentContext) -> EnrichmentJob:
    return EnrichmentJob(
        scope=context.scope,
        graph_scope_key="org-a:repo-a:refs/heads/main",
        graph_version=7,
        full_rebuild=False,
        changed_paths=("api/checkout_route.ts",),
        lane="default",
        trace_id=None,
        idempotency_key="feature-cluster-job",
    )


@pytest.mark.asyncio
async def test_default_lane_clusters_full_head_behind_existing_boundaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    context = _fixture_context()
    graph_store = _RecordingGraphStore(context)
    config_store = _RecordingConfigStore()
    state_store = _RecordingStateStore()
    service = EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=_CheckoutGraphifyFactory(),
        config_store=config_store,
        state_store=state_store,
    )

    result = await service.process(_job(context))

    assert result.status == "written"
    assert result.node_count == 1
    assert result.edge_count == 3
    assert graph_store.load_arguments == [((), True)]
    assert graph_store.generic_writes == []
    assert graph_store.feature_writes[0].nodes[0].uid == stable_uid(
        context.scope, "Feature", "checkout"
    )
    assert config_store.org_ids == ["org-a"]
    assert [state.status for state in state_store.states] == ["generating", "ready"]


@pytest.mark.asyncio
async def test_stale_job_stops_before_context_config_model_or_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    context = _fixture_context()
    graph_store = _RecordingGraphStore(context, current=False)
    config_store = _RecordingConfigStore()
    state_store = _RecordingStateStore()
    service = EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=_CheckoutGraphifyFactory(),
        config_store=config_store,
        state_store=state_store,
    )

    result = await service.process(_job(context))

    assert result.status == "skipped_stale"
    assert graph_store.load_arguments == []
    assert config_store.org_ids == []
    assert state_store.states == []
    assert graph_store.feature_writes == []


@pytest.mark.asyncio
async def test_head_change_during_generation_is_rejected_by_atomic_apply_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    context = _fixture_context()
    graph_store = _RecordingGraphStore(context, apply_current=False)
    state_store = _RecordingStateStore()
    service = EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=_CheckoutGraphifyFactory(),
        config_store=_RecordingConfigStore(),
        state_store=state_store,
    )

    result = await service.process(_job(context))

    assert result.status == "skipped_stale"
    assert result.node_count == 0
    assert graph_store.feature_writes == []
    assert [state.status for state in state_store.states] == ["generating"]


class _FakeResult:
    def __init__(self, record: dict[str, str] | None = None) -> None:
        self.record = record

    async def single(self, *, strict: bool = False) -> dict[str, str] | None:
        del strict
        return self.record

    async def consume(self) -> None:
        return None


class _FakeTransaction:
    def __init__(self, *, current: bool = True) -> None:
        self.current = current
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def run(self, query: str, **parameters: Any) -> _FakeResult:
        self.calls.append((query, parameters))
        if "RETURN root.uid AS uid" in query:
            return _FakeResult({"uid": "root"}) if self.current else _FakeResult()
        return _FakeResult()


class _FakeSession:
    def __init__(self, transaction: _FakeTransaction) -> None:
        self.transaction = transaction

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute_write(self, callback: Any) -> Any:
        return await callback(self.transaction)


class _FakeNeo4jDriver:
    def __init__(self, *, current: bool = True) -> None:
        self.transaction = _FakeTransaction(current=current)
        self.execute_query_calls: list[tuple[str, dict[str, Any]]] = []

    def session(self) -> _FakeSession:
        return _FakeSession(self.transaction)

    async def execute_query(
        self, query: str, **parameters: Any
    ) -> tuple[list[dict[str, str]], None, None]:
        self.execute_query_calls.append((query, parameters))
        records = [{"uid": "root"}] if self.transaction.current else []
        return records, None, None


@pytest.mark.asyncio
async def test_neo4j_feature_projection_replaces_only_after_current_revision_lock() -> None:
    context = _fixture_context()
    write = canonicalize_feature_clustering_write(context, _checkout_candidate(context))
    driver = _FakeNeo4jDriver(current=True)
    store = Neo4jEnrichmentGraphStore(driver)  # type: ignore[arg-type]

    assert await store.apply_feature_projection(write) is True

    calls = driver.transaction.calls
    assert "RETURN root.uid AS uid" in calls[0][0]
    assert any(
        "[edge:PART_OF]" in query and "DELETE edge" in query for query, _ in calls
    )
    assert any(
        "MATCH (node:Feature" in query
        and "WHERE NOT (node.uid IN $feature_uids)" in query
        and "DETACH DELETE node" in query
        for query, _ in calls
    )
    assert any("MERGE (node:Feature" in query for query, _ in calls)
    assert any("MERGE (source)-[edge:PART_OF" in query for query, _ in calls)
    assert all("REFERENCES" not in query for query, _ in calls)
    stale_delete_parameters = next(
        parameters
        for query, parameters in calls
        if "WHERE NOT (node.uid IN $feature_uids)" in query
    )
    assert stale_delete_parameters["feature_uids"] == [write.nodes[0].uid]
    for _query, parameters in calls:
        assert parameters["org_id"] == "org-a"
        assert parameters["repo_id"] == "repo-a"
        assert parameters["ref_name"] == "refs/heads/main"
        assert parameters["revision_sha"] == SHA


@pytest.mark.asyncio
async def test_neo4j_feature_projection_stale_guard_mutates_nothing() -> None:
    context = _fixture_context()
    write = canonicalize_feature_clustering_write(context, _checkout_candidate(context))
    driver = _FakeNeo4jDriver(current=False)
    store = Neo4jEnrichmentGraphStore(driver)  # type: ignore[arg-type]

    assert await store.apply_feature_projection(write) is False
    assert len(driver.transaction.calls) == 1
    assert "RETURN root.uid AS uid" in driver.transaction.calls[0][0]


@pytest.mark.asyncio
async def test_empty_feature_projection_clears_all_current_memberships_and_features() -> None:
    context = _fixture_context()
    driver = _FakeNeo4jDriver(current=True)
    store = Neo4jEnrichmentGraphStore(driver)  # type: ignore[arg-type]

    assert await store.apply_feature_projection(
        EnrichmentWrite(scope=context.scope)
    ) is True

    calls = driver.transaction.calls
    assert any("[edge:PART_OF]" in query and "DELETE edge" in query for query, _ in calls)
    stale_parameters = next(
        parameters
        for query, parameters in calls
        if "WHERE NOT (node.uid IN $feature_uids)" in query
    )
    assert stale_parameters["feature_uids"] == []
    assert not any("MERGE (node:Feature" in query for query, _ in calls)


@pytest.mark.asyncio
async def test_current_scope_lookup_injects_complete_server_scope() -> None:
    driver = _FakeNeo4jDriver(current=True)
    store = Neo4jEnrichmentGraphStore(driver)  # type: ignore[arg-type]

    assert await store.is_current(_scope()) is True

    _query, parameters = driver.execute_query_calls[0]
    assert parameters == {
        "org_id": "org-a",
        "repo_id": "repo-a",
        "ref_name": "refs/heads/main",
        "revision_sha": SHA,
    }


@pytest.mark.asyncio
async def test_structural_head_advance_invalidates_feature_projection_first() -> None:
    scope = _scope()
    root = GraphNode(
        label="Folder",
        uid=stable_uid(scope, "Folder", ""),
        properties={
            "org_id": scope.org_id,
            "repo_id": scope.repository_id,
            "ref_name": scope.ref_name,
            "revision_sha": scope.revision_sha,
            "path": "",
            "name": "/",
        },
    )
    projection = GraphProjection(
        scope=scope,
        nodes=(root,),
        edges=(),
        current_file_paths=(),
        current_folder_paths=("",),
        affected_file_paths=(),
        full_rebuild=True,
    )
    driver = _FakeNeo4jDriver()
    store = Neo4jGraphStore(driver)  # type: ignore[arg-type]

    await store.apply(projection)

    calls = driver.transaction.calls
    root_lock_index = next(
        index
        for index, (query, _parameters) in enumerate(calls)
        if "SET root.revision_sha = root.revision_sha" in query
    )
    membership_delete_index = next(
        index
        for index, (query, _parameters) in enumerate(calls)
        if "[edge:PART_OF]" in query and "DELETE edge" in query
    )
    feature_delete_index = next(
        index
        for index, (query, _parameters) in enumerate(calls)
        if "MATCH (node:Feature" in query and "SET node.revision_sha = null" in query
    )
    structural_delete_index = next(
        index
        for index, (query, _parameters) in enumerate(calls)
        if "MATCH (node:Function" in query
    )
    assert root_lock_index < membership_delete_index
    assert membership_delete_index < feature_delete_index < structural_delete_index
    assert all("REFERENCES" not in query for query, _ in calls)

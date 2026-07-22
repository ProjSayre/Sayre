from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from messaging.envelope import MessageEnvelope
from messaging.idempotency import SqliteDeliveryStore
from sayre_workers.enrichment.consumers import run_enrichment_consumer
from sayre_workers.enrichment.enrichment_graph import validate_enrichment_write
from sayre_workers.enrichment.events import parse_enrichment_envelope
from sayre_workers.enrichment.graphify_adapter import (
    FakeGraphifyAdapter,
    GraphifyAdapterFactory,
)
from sayre_workers.enrichment.models import (
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentNode,
    EnrichmentWrite,
    FileContext,
    GenerationConfig,
    GenerationConfigNotFoundError,
    InvalidEnrichmentEventError,
    InvalidEnrichmentWriteError,
)
from sayre_workers.enrichment.providers import (
    FakeModelProvider,
    GenerationRequest,
    GenerationResponse,
    ModelProviderFactory,
)
from sayre_workers.enrichment.service import EnrichmentService
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.ingestion.projection import stable_uid

SHA = "a" * 40


def graph_updated_envelope(
    *,
    org_id: str = "org-real",
    payload_org_id: str = "org-real",
    repository_id: str = "repo-1",
    ref_name: str = "refs/heads/main",
    revision_sha: str = SHA,
    full_rebuild: bool = False,
    changed_paths: tuple[str, ...] = (),
    graph_scope_key: str = "scope-key-1",
    graph_version: int = 1,
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=org_id,
        type="graph.updated",
        source="ingestion-worker",
        idempotency_key=f"{graph_scope_key}:{revision_sha}:graph.updated",
        graph_scope_key=graph_scope_key,
        graph_version=graph_version,
        payload={
            "org_id": payload_org_id,
            "repository_id": repository_id,
            "ref_name": ref_name,
            "revision_sha": revision_sha,
            "full_rebuild": full_rebuild,
            "changed_paths": list(changed_paths),
        },
    )


def onboarding_envelope(
    *,
    org_id: str = "org-real",
    repository_id: str = "repo-1",
    ref_name: str = "refs/heads/main",
    revision_sha: str = SHA,
    graph_scope_key: str = "scope-key-priority",
    graph_version: int = 1,
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=org_id,
        type="onboarding.generate",
        source="onboarding-worker",
        idempotency_key=f"{graph_scope_key}:{revision_sha}:onboarding.generate",
        graph_scope_key=graph_scope_key,
        graph_version=graph_version,
        payload={
            "repository_id": repository_id,
            "ref_name": ref_name,
            "revision_sha": revision_sha,
        },
    )


def _file_context(scope: GraphScope, path: str, *, language: str = "python") -> FileContext:
    return FileContext(uid=stable_uid(scope, "File", path), path=path, language=language)


# --------------------------------------------------------------------------------
# events.py -- parse_enrichment_envelope
# --------------------------------------------------------------------------------


def test_parse_enrichment_envelope_uses_only_server_resolved_envelope_org() -> None:
    job = parse_enrichment_envelope(graph_updated_envelope(org_id="org-real", payload_org_id="forged-org"))

    assert job.scope.org_id == "org-real"


def test_parse_enrichment_envelope_default_lane_for_graph_updated() -> None:
    job = parse_enrichment_envelope(graph_updated_envelope())

    assert job.lane == "default"
    assert job.scope == GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    assert job.graph_scope_key == "scope-key-1"
    assert job.graph_version == 1


def test_parse_enrichment_envelope_priority_lane_routes_through_same_job_shape() -> None:
    job = parse_enrichment_envelope(onboarding_envelope())

    assert job.lane == "priority"
    assert job.scope.org_id == "org-real"


def test_parse_enrichment_envelope_rejects_unrecognized_type() -> None:
    envelope = MessageEnvelope(
        org_id="org-real", type="repo.push", source="github-webhook", payload={}
    )

    with pytest.raises(InvalidEnrichmentEventError):
        parse_enrichment_envelope(envelope)


def test_parse_enrichment_envelope_rejects_embedding_upsert_type() -> None:
    envelope = MessageEnvelope(
        org_id="org-real", type="embedding.upsert", source="ingestion-worker", payload={}
    )

    with pytest.raises(InvalidEnrichmentEventError):
        parse_enrichment_envelope(envelope)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda payload: payload.pop("repository_id"),
        lambda payload: payload.pop("ref_name"),
        lambda payload: payload.pop("revision_sha"),
        lambda payload: payload.__setitem__("changed_paths", "not-a-list"),
        lambda payload: payload.__setitem__("changed_paths", [1, 2]),
        lambda payload: payload.__setitem__("full_rebuild", "yes"),
    ],
)
def test_parse_enrichment_envelope_rejects_malformed_graph_updated_payload(mutate) -> None:
    envelope = graph_updated_envelope()
    payload = dict(envelope.payload)
    mutate(payload)
    malformed = envelope.model_copy(update={"payload": payload})

    with pytest.raises(InvalidEnrichmentEventError):
        parse_enrichment_envelope(malformed)


def test_parse_enrichment_envelope_requires_scope_metadata_for_priority_lane() -> None:
    envelope = MessageEnvelope(
        org_id="org-real",
        type="onboarding.generate",
        source="onboarding-worker",
        payload={
            "repository_id": "repo-1",
            "ref_name": "refs/heads/main",
            "revision_sha": SHA,
        },
        # graph_scope_key/graph_version intentionally omitted -- only graph.updated
        # forces MessageEnvelope to require the pair.
    )

    with pytest.raises(InvalidEnrichmentEventError):
        parse_enrichment_envelope(envelope)


# --------------------------------------------------------------------------------
# providers.py -- ModelProvider boundary
# --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fake_model_provider_is_deterministic_and_network_free() -> None:
    provider = FakeModelProvider()
    request = GenerationRequest(system="sys", input="in")

    first = await provider.generate(request)
    second = await provider.generate(request)

    assert first == second
    assert first.text


@pytest.mark.asyncio
async def test_model_provider_factory_gates_fake_deterministic_to_test_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = ModelProviderFactory()
    config = GenerationConfig(provider="fake_deterministic", model="ci-fake")

    monkeypatch.setenv("SAYRE_ENV", "development")
    with pytest.raises(ValueError, match="test-only"):
        await factory.create(config)

    monkeypatch.setenv("SAYRE_ENV", "test")
    assert isinstance(await factory.create(config), FakeModelProvider)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_name", ["anthropic", "openai", "openai_compatible"])
async def test_model_provider_factory_defers_real_providers_to_w3_07(
    monkeypatch: pytest.MonkeyPatch, provider_name: str
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    factory = ModelProviderFactory()
    config = GenerationConfig(provider=provider_name, model="some-model")

    with pytest.raises(NotImplementedError, match="W3-07"):
        await factory.create(config)


@pytest.mark.asyncio
async def test_model_provider_factory_rejects_unsupported_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    factory = ModelProviderFactory()
    config = GenerationConfig(provider="not-a-real-provider", model="x")

    with pytest.raises(ValueError, match="unsupported"):
        await factory.create(config)


# --------------------------------------------------------------------------------
# graphify_adapter.py -- GraphifyAdapter boundary
# --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fake_graphify_adapter_emits_placeholder_feature_and_part_of_edges_only() -> None:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    files = (_file_context(scope, "src/a.py"), _file_context(scope, "src/b.py"))
    context = EnrichmentContext(scope=scope, files=files)
    adapter = FakeGraphifyAdapter()

    write = await adapter.shape(context, GenerationResponse(text="ignored by the skeleton"))

    assert write.scope == scope
    assert len(write.nodes) == 1
    feature = write.nodes[0]
    assert feature.label == "Feature"
    assert feature.uid == stable_uid(scope, "Feature", "__skeleton__")
    assert feature.properties == {
        "name": "Unclassified",
        "description": "<skeleton placeholder — replaced by W3-01>",
        "team": None,
    }
    assert {edge.relationship for edge in write.edges} == {"PART_OF"}
    assert {edge.source_uid for edge in write.edges} == {file.uid for file in files}
    assert all(edge.target_uid == feature.uid for edge in write.edges)


@pytest.mark.asyncio
async def test_fake_graphify_adapter_is_idempotent_across_calls_for_merge_safety() -> None:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    context = EnrichmentContext(scope=scope, files=(_file_context(scope, "src/a.py"),))
    adapter = FakeGraphifyAdapter()

    first = await adapter.shape(context, GenerationResponse(text="x"))
    second = await adapter.shape(context, GenerationResponse(text="y"))

    assert first.nodes[0].uid == second.nodes[0].uid
    assert {edge.source_uid for edge in first.edges} == {edge.source_uid for edge in second.edges}


def test_graphify_adapter_factory_returns_the_fake() -> None:
    assert isinstance(GraphifyAdapterFactory().create(), FakeGraphifyAdapter)


# --------------------------------------------------------------------------------
# enrichment_graph.py -- validate_enrichment_write (pure, Neo4j-free)
# --------------------------------------------------------------------------------


def test_validate_enrichment_write_rejects_disallowed_node_label() -> None:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    write = EnrichmentWrite(
        scope=scope, nodes=(EnrichmentNode(label="Function", uid="fn-1", properties={}),)
    )

    with pytest.raises(InvalidEnrichmentWriteError):
        validate_enrichment_write(write)


def test_validate_enrichment_write_rejects_disallowed_relationship() -> None:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    write = EnrichmentWrite(
        scope=scope,
        edges=(EnrichmentEdge(relationship="CALLS", source_uid="a", target_uid="b"),),
    )

    with pytest.raises(InvalidEnrichmentWriteError):
        validate_enrichment_write(write)


def test_validate_enrichment_write_accepts_closed_set_primitives() -> None:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    write = EnrichmentWrite(
        scope=scope,
        nodes=(EnrichmentNode(label="Feature", uid="feature-1", properties={}),),
        edges=(EnrichmentEdge(relationship="PART_OF", source_uid="file-1", target_uid="feature-1"),),
    )

    validate_enrichment_write(write)  # does not raise


# --------------------------------------------------------------------------------
# service.py -- EnrichmentService.handle orchestration
# --------------------------------------------------------------------------------


class FakeEnrichmentGraphStore:
    def __init__(self, files: tuple[FileContext, ...] = (), *, fail_apply: bool = False) -> None:
        self._files = files
        self._fail_apply = fail_apply
        self.load_context_calls: list[GraphScope] = []
        self.applied: list[EnrichmentWrite] = []

    async def load_context(
        self, scope: GraphScope, changed_paths: tuple[str, ...], full_rebuild: bool
    ) -> EnrichmentContext:
        self.load_context_calls.append(scope)
        return EnrichmentContext(scope=scope, files=self._files)

    async def apply(self, write: EnrichmentWrite) -> None:
        validate_enrichment_write(write)
        if self._fail_apply:
            raise RuntimeError("simulated neo4j write failure")
        self.applied.append(write)


class FakeGenerationConfigStore:
    def __init__(self, config: GenerationConfig | None) -> None:
        self._config = config
        self.requested_org_ids: list[str] = []

    async def load_generation_config(self, org_id: str) -> GenerationConfig | None:
        self.requested_org_ids.append(org_id)
        return self._config


class StubGraphifyAdapterFactory:
    def __init__(self, adapter) -> None:
        self._adapter = adapter

    def create(self):
        return self._adapter


class DisallowedPrimitiveGraphifyAdapter:
    async def shape(self, context: EnrichmentContext, generation: GenerationResponse) -> EnrichmentWrite:
        return EnrichmentWrite(
            scope=context.scope,
            nodes=(EnrichmentNode(label="Function", uid="not-allowed", properties={}),),
        )


class WrongScopeGraphifyAdapter:
    async def shape(self, context: EnrichmentContext, generation: GenerationResponse) -> EnrichmentWrite:
        forged_scope = GraphScope(
            "org-other-tenant",
            context.scope.repository_id,
            context.scope.ref_name,
            context.scope.revision_sha,
        )
        return EnrichmentWrite(scope=forged_scope)


def _fake_config() -> GenerationConfig:
    return GenerationConfig(provider="fake_deterministic", model="ci-fake")


def _service(
    *,
    graph_store: FakeEnrichmentGraphStore,
    config_store: FakeGenerationConfigStore,
    graphify_factory=None,
) -> EnrichmentService:
    return EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=graphify_factory or GraphifyAdapterFactory(),
        config_store=config_store,
    )


@pytest.mark.asyncio
async def test_handle_happy_path_writes_org_stamped_feature_and_part_of_edges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    result = await service.handle(graph_updated_envelope(org_id="org-real"))

    assert result.status == "written"
    assert result.node_count == 1
    assert result.edge_count == 1
    assert len(graph_store.applied) == 1
    write = graph_store.applied[0]
    assert write.scope.org_id == "org-real"
    assert write.nodes[0].label == "Feature"
    assert {edge.relationship for edge in write.edges} == {"PART_OF"}
    # Never a free-form/prose blob node -- only the closed enrichment label set.
    assert all(node.label in {"Feature", "EnvStep"} for node in write.nodes)


@pytest.mark.asyncio
async def test_handle_ignores_forged_payload_org_id_on_every_read_and_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    await service.handle(graph_updated_envelope(org_id="org-real", payload_org_id="forged-org"))

    assert graph_store.load_context_calls[0].org_id == "org-real"
    assert config_store.requested_org_ids == ["org-real"]
    assert graph_store.applied[0].scope.org_id == "org-real"
    assert "forged-org" not in {call.org_id for call in graph_store.load_context_calls}


@pytest.mark.asyncio
async def test_handle_returns_skipped_no_context_for_empty_scope_and_does_not_load_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    graph_store = FakeEnrichmentGraphStore(files=())
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    result = await service.handle(graph_updated_envelope())

    assert result.status == "skipped_no_context"
    assert result.node_count == 0
    assert result.edge_count == 0
    assert graph_store.applied == []
    assert config_store.requested_org_ids == []


@pytest.mark.asyncio
async def test_handle_priority_lane_with_no_enrichable_scope_is_skipped_not_errored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    graph_store = FakeEnrichmentGraphStore(files=())
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    result = await service.handle(onboarding_envelope())

    assert result.status == "skipped_no_context"


@pytest.mark.asyncio
async def test_handle_raises_and_does_not_write_when_generation_config_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(None)
    service = _service(graph_store=graph_store, config_store=config_store)

    with pytest.raises(GenerationConfigNotFoundError):
        await service.handle(graph_updated_envelope())

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_does_not_substitute_fake_provider_outside_tests_on_missing_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Even outside SAYRE_ENV=="test", a missing config must raise -- never silently
    # fall back to the deterministic fake (Decision D2).
    monkeypatch.setenv("SAYRE_ENV", "development")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(None)
    service = _service(graph_store=graph_store, config_store=config_store)

    with pytest.raises(GenerationConfigNotFoundError):
        await service.handle(graph_updated_envelope())

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_propagates_not_implemented_for_real_provider_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(GenerationConfig(provider="anthropic", model="claude"))
    service = _service(graph_store=graph_store, config_store=config_store)

    with pytest.raises(NotImplementedError):
        await service.handle(graph_updated_envelope())

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_rejects_disallowed_primitive_from_graphify_adapter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(
        graph_store=graph_store,
        config_store=config_store,
        graphify_factory=StubGraphifyAdapterFactory(DisallowedPrimitiveGraphifyAdapter()),
    )

    with pytest.raises(InvalidEnrichmentWriteError):
        await service.handle(graph_updated_envelope())

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_rejects_graphify_write_scoped_to_a_different_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(
        graph_store=graph_store,
        config_store=config_store,
        graphify_factory=StubGraphifyAdapterFactory(WrongScopeGraphifyAdapter()),
    )

    with pytest.raises(InvalidEnrichmentWriteError):
        await service.handle(graph_updated_envelope(org_id="org-real"))

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_propagates_neo4j_write_failure_with_no_partial_ack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(
        files=(_file_context(scope, "src/a.py"),), fail_apply=True
    )
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    with pytest.raises(RuntimeError, match="simulated neo4j write failure"):
        await service.handle(graph_updated_envelope())

    assert graph_store.applied == []


@pytest.mark.asyncio
async def test_handle_produces_stable_uids_across_redeliveries_for_merge_idempotency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    await service.handle(graph_updated_envelope())
    await service.handle(graph_updated_envelope())

    first, second = graph_store.applied
    assert first.nodes[0].uid == second.nodes[0].uid
    assert {edge.source_uid for edge in first.edges} == {edge.source_uid for edge in second.edges}
    assert {edge.target_uid for edge in first.edges} == {edge.target_uid for edge in second.edges}


@pytest.mark.asyncio
async def test_handle_never_writes_a_free_form_prose_node(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    graph_store = FakeEnrichmentGraphStore(files=(_file_context(scope, "src/a.py"),))
    config_store = FakeGenerationConfigStore(_fake_config())
    service = _service(graph_store=graph_store, config_store=config_store)

    await service.handle(graph_updated_envelope())

    write = graph_store.applied[0]
    for node in write.nodes:
        assert "text" not in node.properties
        assert set(node.properties) <= {"name", "description", "team", "sequence", "command"}


# --------------------------------------------------------------------------------
# consumers.py -- enrichment lane wiring
# --------------------------------------------------------------------------------


def test_run_enrichment_consumer_delegates_to_consume_enrichment_with_weighted_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_consume_enrichment(handler, **kwargs: object) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        "sayre_workers.enrichment.consumers.consume_enrichment", fake_consume_enrichment
    )
    store = SqliteDeliveryStore(":memory:")
    stop_event = threading.Event()
    stop_event.set()
    dummy_service = SimpleNamespace(handle=lambda envelope: None)

    try:
        run_enrichment_consumer(dummy_service, store, stop_event=stop_event)  # type: ignore[arg-type]
    finally:
        store.close()

    assert len(calls) == 1
    assert calls[0]["consumer_id"] == "enrichment-worker"
    assert calls[0]["mode"] == "weighted"
    assert calls[0]["delivery_store"] is store
    assert calls[0]["stop_event"] is stop_event
    # This worker never receives from any queue other than the two enrichment lanes
    # -- consume_enrichment (not consume/consume_once against INGESTION_QUEUE) is the
    # only primitive it calls.
    assert "queue_name" not in calls[0]

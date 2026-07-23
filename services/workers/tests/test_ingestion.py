from __future__ import annotations

import subprocess
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.chunks import build_bounded_chunks
from sayre_workers.ingestion.embeddings import (
    DeterministicEmbeddingProvider,
    EmbeddingProviderFactory,
    InvalidEmbeddingError,
    OpenAICompatibleEmbeddingProvider,
)
from sayre_workers.ingestion.models import (
    EmbeddingConfig,
    EmbeddingTask,
    GraphProjection,
    GraphScope,
    PersistedChunk,
    RefState,
    RepositoryLocator,
    SymbolRef,
    parse_ingestion_envelope,
)
from sayre_workers.ingestion.projection import build_projection
from sayre_workers.ingestion.repository import GitRepositorySource, RepositorySnapshot
from sayre_workers.ingestion.service import IngestionService
from sayre_workers.parsing import SourceFile, parse_full

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40


def initial_envelope(revision: str = SHA_A) -> MessageEnvelope:
    return MessageEnvelope(
        org_id="org-server-resolved",
        type="repo.initial_parse",
        source="github-app",
        idempotency_key=f"initial:{revision}",
        payload={
            "org_id": "forged-org",
            "provider": "github",
            "repo": {
                "provider_repo_id": "583231",
                "full_name": "acme/widgets",
                "repo_id": "forged-repository-id",
            },
            "ref": "refs/heads/main",
            "revision_sha": revision,
        },
    )


def push_envelope(
    revision: str = SHA_B, *, before: str = SHA_A, forced: bool = False
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id="org-server-resolved",
        type="repo.push",
        source="github-webhook",
        idempotency_key=f"push:{revision}",
        payload={
            "org_id": "forged-org",
            "provider": "github",
            "repo": {"provider_repo_id": "583231", "full_name": "acme/widgets"},
            "ref": "refs/heads/main",
            "payload": {"before": before, "after": revision, "forced": forced},
        },
    )


class FakeSnapshot:
    def __init__(
        self,
        *,
        revision: str,
        tracked: tuple[str, ...],
        sources: dict[str, bytes],
        changed: tuple[str, ...] = (),
        deleted: tuple[str, ...] = (),
        ancestry: dict[tuple[str, str], bool] | None = None,
    ) -> None:
        self.revision_sha = revision
        self.scratch_root = Path("fake-scratch")
        self._tracked = tracked
        self._sources = sources
        self._changed = changed
        self._deleted = deleted
        self._ancestry = ancestry or {}

    async def is_ancestor(self, older: str, newer: str) -> bool:
        return self._ancestry.get((older, newer), False)

    async def tracked_paths(self) -> tuple[str, ...]:
        return self._tracked

    async def changed_paths(
        self, older: str, newer: str
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return self._changed, self._deleted

    async def source_files(self, paths: Iterable[str]) -> tuple[SourceFile, ...]:
        return tuple(
            SourceFile(path=path, content=self._sources[path])
            for path in paths
            if path in self._sources
        )


class FakeSource:
    def __init__(self, snapshot: FakeSnapshot, log: list[str]) -> None:
        self.snapshot = snapshot
        self.log = log

    @asynccontextmanager
    async def checkout(
        self,
        repository: RepositoryLocator,
        ref_name: str,
        revision_sha: str,
        accepted_revision_sha: str | None,
    ) -> AsyncIterator[RepositorySnapshot]:
        self.log.append("checkout")
        assert revision_sha == self.snapshot.revision_sha
        try:
            yield self.snapshot
        finally:
            self.log.append("scratch-cleaned")


class FakeLockedRef:
    def __init__(self, current: RefState | None, log: list[str]) -> None:
        self.repository_id = "repo-from-postgres"
        self.current = current
        self.log = log

    async def accept(self, revision_sha: str) -> RefState:
        self.log.append("state-accepted")
        version = 0 if self.current is None else self.current.graph_version + 1
        self.current = RefState("ref-from-postgres", revision_sha, version)
        return self.current


class FakeStateStore:
    def __init__(self, current: RefState | None, log: list[str]) -> None:
        self.locked = FakeLockedRef(current, log)
        self.log = log

    @asynccontextmanager
    async def lock(
        self, org_id: str, repository: RepositoryLocator, ref_name: str
    ) -> AsyncIterator[FakeLockedRef]:
        assert org_id == "org-server-resolved"
        self.log.append("state-locked")
        yield self.locked
        self.log.append("state-committed")


class FakeGraphStore:
    def __init__(self, log: list[str], symbols: tuple[SymbolRef, ...] = ()) -> None:
        self.log = log
        self.symbols = symbols
        self.projections: list[GraphProjection] = []

    async def load_symbols(self, scope: GraphScope) -> tuple[SymbolRef, ...]:
        self.log.append("symbols-loaded")
        return self.symbols

    async def apply(self, projection: GraphProjection) -> None:
        self.log.append("graph-committed")
        self.projections.append(projection)


class FakeChunkStore:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.calls: list[dict[str, object]] = []

    async def replace_chunks(self, **kwargs: object) -> tuple[PersistedChunk, ...]:
        self.log.append("chunks-persisted")
        self.calls.append(kwargs)
        chunks = kwargs["chunks"]
        assert isinstance(chunks, tuple)
        return tuple(
            PersistedChunk(chunk_id=f"chunk-{index}", chunk=chunk)
            for index, chunk in enumerate(chunks)
        )


class FakePublisher:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.graph_events: list[dict[str, object]] = []
        self.onboarding_events: list[dict[str, object]] = []
        self.embedding_tasks: list[EmbeddingTask] = []

    async def graph_updated(self, **kwargs: object) -> None:
        self.log.append("graph-event-published")
        self.graph_events.append(kwargs)

    async def onboarding_generate(self, **kwargs: object) -> None:
        self.log.append("onboarding-enqueued")
        self.onboarding_events.append(kwargs)

    async def embedding_upsert(self, task: EmbeddingTask, content_hash: str) -> None:
        assert content_hash
        self.log.append("embedding-enqueued")
        self.embedding_tasks.append(task)


def service_fixture(
    snapshot: FakeSnapshot, current: RefState | None = None
) -> tuple[IngestionService, list[str], FakeGraphStore, FakeChunkStore, FakePublisher]:
    log: list[str] = []
    graph = FakeGraphStore(log)
    chunks = FakeChunkStore(log)
    publisher = FakePublisher(log)
    service = IngestionService(
        state_store=FakeStateStore(current, log),
        repository_source=FakeSource(snapshot, log),
        graph_store=graph,
        chunk_store=chunks,
        publisher=publisher,
    )
    return service, log, graph, chunks, publisher


def test_job_parser_uses_only_server_resolved_envelope_org() -> None:
    job = parse_ingestion_envelope(initial_envelope())

    assert job.org_id == "org-server-resolved"
    assert job.repository.provider_repo_id == "583231"
    assert not hasattr(job.repository, "repo_id")


def test_projection_stamps_scope_and_resolves_structural_edges() -> None:
    sources = (
        SourceFile(
            path="src/base.py",
            content=b"class Base:\n    pass\n\ndef helper():\n    return 1\n",
        ),
        SourceFile(
            path="src/child.py",
            content=(
                b"from .base import Base, helper\n\n"
                b"class Child(Base):\n"
                b"    def run(self):\n"
                b"        return helper()\n"
            ),
        ),
    )
    scope = GraphScope("org-1", "repo-1", "refs/heads/main", SHA_A)
    projection = build_projection(
        scope=scope,
        parsed=parse_full(sources),
        tracked_paths=("README.md", "src/base.py", "src/child.py"),
        affected_paths=("README.md", "src/base.py", "src/child.py"),
        full_rebuild=True,
    )

    assert {node.label for node in projection.nodes} == {"Folder", "File", "Function", "Class"}
    assert all(node.properties["org_id"] == "org-1" for node in projection.nodes)
    assert all(node.properties["repo_id"] == "repo-1" for node in projection.nodes)
    assert {edge.relationship for edge in projection.edges} >= {
        "CONTAINS",
        "IMPORTS",
        "CALLS",
        "INHERITS",
    }


def test_projection_resolves_javascript_parent_relative_import() -> None:
    sources = (
        SourceFile(path="src/util.js", content=b"export function help() { return 1; }\n"),
        SourceFile(
            path="src/features/app.js",
            content=b"import { help } from '../util.js';\nexport const app = () => help();\n",
        ),
    )
    scope = GraphScope("org-1", "repo-1", "refs/heads/main", SHA_A)
    projection = build_projection(
        scope=scope,
        parsed=parse_full(sources),
        tracked_paths=tuple(source.path for source in sources),
        affected_paths=tuple(source.path for source in sources),
        full_rebuild=True,
    )

    assert any(edge.relationship == "IMPORTS" for edge in projection.edges)


@pytest.mark.asyncio
async def test_initial_ingestion_commits_event_before_embedding_and_cleans_scratch() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_A,
        tracked=("README.md", "src/app.py"),
        sources={"src/app.py": b"def run():\n    return 1\n"},
    )
    service, log, graph, _chunks, publisher = service_fixture(snapshot)

    result = await service.handle(initial_envelope())

    assert result.status == "accepted"
    assert result.graph_version == 0
    assert result.full_rebuild is True
    assert result.structural_duration_ms is not None and result.structural_duration_ms < 15_000
    assert graph.projections[0].full_rebuild is True
    assert publisher.onboarding_events
    assert publisher.embedding_tasks
    assert log.index("graph-committed") < log.index("state-committed")
    assert log.index("state-committed") < log.index("graph-event-published")
    assert log.index("graph-event-published") < log.index("onboarding-enqueued")
    assert log.index("onboarding-enqueued") < log.index("chunks-persisted")
    assert log.index("chunks-persisted") < log.index("embedding-enqueued")
    assert log.index("scratch-cleaned") < log.index("state-committed")


@pytest.mark.asyncio
async def test_fast_forward_delta_only_replaces_changed_and_deleted_paths() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_B,
        tracked=("src/next.py",),
        sources={"src/next.py": b"def next_version():\n    return 2\n"},
        changed=("src/next.py",),
        deleted=("src/old.py",),
        ancestry={(SHA_A, SHA_B): True},
    )
    current = RefState("ref-from-postgres", SHA_A, 3)
    service, _log, graph, chunks, publisher = service_fixture(snapshot, current)

    result = await service.handle(push_envelope())

    assert result.status == "accepted"
    assert result.graph_version == 4
    assert result.full_rebuild is False
    assert result.changed_paths == ("src/next.py", "src/old.py")
    assert result.deleted_paths == ("src/old.py",)
    assert graph.projections[0].affected_file_paths == ("src/next.py", "src/old.py")
    assert chunks.calls[0]["full_rebuild"] is False
    assert publisher.onboarding_events == []


@pytest.mark.asyncio
async def test_force_push_rebuilds_abandoned_head_projection() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_C,
        tracked=("fresh.py",),
        sources={"fresh.py": b"def fresh():\n    return True\n"},
    )
    current = RefState("ref-from-postgres", SHA_B, 8)
    service, _log, graph, _chunks, _publisher = service_fixture(snapshot, current)

    result = await service.handle(push_envelope(SHA_C, before=SHA_B, forced=True))

    assert result.status == "accepted"
    assert result.graph_version == 9
    assert result.full_rebuild is True
    assert graph.projections[0].current_file_paths == ("fresh.py",)


@pytest.mark.asyncio
async def test_stale_revision_is_harmless() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_A,
        tracked=("old.py",),
        sources={"old.py": b"old = True\n"},
        ancestry={(SHA_A, SHA_B): True},
    )
    current = RefState("ref-from-postgres", SHA_B, 5)
    service, log, graph, _chunks, publisher = service_fixture(snapshot, current)

    result = await service.handle(push_envelope(SHA_A, before=SHA_C))

    assert result.status == "stale"
    assert result.graph_version == 5
    assert graph.projections == []
    assert publisher.graph_events == []
    assert "scratch-cleaned" in log


@pytest.mark.asyncio
async def test_replay_republishes_idempotent_post_commit_work_without_graph_rewrite() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_B,
        tracked=("same.py",),
        sources={"same.py": b"same = True\n"},
    )
    current = RefState("ref-from-postgres", SHA_B, 7)
    service, _log, graph, chunks, publisher = service_fixture(snapshot, current)

    result = await service.handle(push_envelope())

    assert result.status == "replayed"
    assert result.graph_version == 7
    assert result.full_rebuild is False
    assert graph.projections == []
    assert publisher.graph_events
    assert publisher.onboarding_events == []
    assert chunks.calls[0]["full_rebuild"] is True


def test_bounded_chunks_never_reconstruct_the_source_file() -> None:
    content = b"def hello():\n    return 'world'\n"
    scope = GraphScope("org", "repo", "refs/heads/main", SHA_A)
    chunks = build_bounded_chunks(scope, [SourceFile(path="hello.py", content=content)])

    assert chunks
    assert "".join(chunk.content for chunk in chunks) != content.decode("utf-8")
    assert sum(len(chunk.content) for chunk in chunks) < len(content.decode("utf-8"))


@pytest.mark.asyncio
async def test_deterministic_embedding_fake_is_stable_and_1024_dimensional() -> None:
    provider = DeterministicEmbeddingProvider()

    first = await provider.embed(["hello"])
    second = await provider.embed(["hello"])

    assert first == second
    assert len(first[0]) == 1024
    assert all(-1.0 <= value <= 1.0 for value in first[0])


@pytest.mark.asyncio
async def test_deterministic_embedding_factory_is_test_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = EmbeddingProviderFactory()
    config = EmbeddingConfig(provider="deterministic_fake", model="ci-fake")
    monkeypatch.setenv("SAYRE_ENV", "development")
    with pytest.raises(InvalidEmbeddingError, match="test-only"):
        await factory.create(config)
    monkeypatch.setenv("SAYRE_ENV", "test")
    assert isinstance(await factory.create(config), DeterministicEmbeddingProvider)


@pytest.mark.asyncio
@pytest.mark.parametrize("vector", [[0.0] * 1023, [0.0] * 1023 + [float("nan")]])
async def test_openai_compatible_adapter_rejects_invalid_vectors(vector: list[float]) -> None:
    response = SimpleNamespace(data=[SimpleNamespace(index=0, embedding=vector)])
    client = SimpleNamespace(embeddings=SimpleNamespace(create=AsyncMock(return_value=response)))
    provider = OpenAICompatibleEmbeddingProvider(client)

    with pytest.raises(InvalidEmbeddingError):
        await provider.embed(["hello"])


@pytest.mark.asyncio
async def test_real_git_snapshot_is_destroyed_after_parse(tmp_path: Path) -> None:
    remote = tmp_path / "remote"
    subprocess.run(["git", "init", "--quiet", "-b", "main", str(remote)], check=True)
    subprocess.run(
        ["git", "-C", str(remote), "config", "user.email", "test@example.com"], check=True
    )
    subprocess.run(["git", "-C", str(remote), "config", "user.name", "Test"], check=True)
    (remote / "app.py").write_text("def app():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(remote), "add", "app.py"], check=True)
    subprocess.run(["git", "-C", str(remote), "commit", "--quiet", "-m", "initial"], check=True)
    revision = subprocess.check_output(
        ["git", "-C", str(remote), "rev-parse", "HEAD"], text=True
    ).strip()
    source = GitRepositorySource(allow_local_for_tests=True)
    locator = RepositoryLocator(
        provider="github",
        provider_repo_id="1",
        full_name="test/repo",
        clone_url=str(remote),
    )

    async with source.checkout(locator, "refs/heads/main", revision, None) as snapshot:
        scratch = snapshot.scratch_root
        assert scratch.exists()
        parsed = parse_full(await snapshot.source_files(await snapshot.tracked_paths()))
        assert [function.name for function in parsed.functions] == ["app"]

    assert not scratch.exists()

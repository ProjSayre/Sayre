"""W1-05 structural ingestion orchestration.

The critical order is: scratch checkout -> parse -> one graph transaction -> accept
the ref state -> publish graph.updated -> enqueue cold-start onboarding -> persist
bounded chunks -> enqueue embeddings.
"""

from __future__ import annotations

import time

from messaging.envelope import MessageEnvelope
from sayre_workers.parsing import SourceFile, parse_diff, parse_full

from .chunks import ChunkStore, build_bounded_chunks
from .events import IngestionPublisher, embedding_task
from .graph import GraphStore
from .models import GraphScope, IngestionResult, parse_ingestion_envelope
from .projection import build_projection, stable_uid
from .repository import RepositorySource
from .state import RefStateStore


class IngestionService:
    def __init__(
        self,
        *,
        state_store: RefStateStore,
        repository_source: RepositorySource,
        graph_store: GraphStore,
        chunk_store: ChunkStore,
        publisher: IngestionPublisher,
    ) -> None:
        self._state_store = state_store
        self._repository_source = repository_source
        self._graph_store = graph_store
        self._chunk_store = chunk_store
        self._publisher = publisher

    async def aclose(self) -> None:
        """Close long-lived runtime resources without assuming test doubles own one."""

        close_failed = False
        for resource in (self._graph_store, self._publisher):
            close = getattr(resource, "aclose", None)
            if close is None:
                close = getattr(resource, "close", None)
            if not callable(close):
                continue
            try:
                result = close()
                if result is not None:
                    await result
            except Exception:
                close_failed = True
        if close_failed:
            raise RuntimeError("one or more ingestion runtime resources failed to close")

    async def handle(self, envelope: MessageEnvelope) -> IngestionResult:
        job = parse_ingestion_envelope(envelope)
        cold_start_started_at_ms = time.time_ns() // 1_000_000
        started = time.perf_counter()
        accepted_state = None
        source_files: tuple[SourceFile, ...] = ()
        affected_paths: tuple[str, ...] = ()
        deleted_paths: tuple[str, ...] = ()
        full_rebuild = False
        replayed = False

        async with self._state_store.lock(job.org_id, job.repository, job.ref_name) as locked_ref:
            current = locked_ref.current
            async with self._repository_source.checkout(
                job.repository,
                job.ref_name,
                job.revision_sha,
                current.revision_sha if current is not None else None,
            ) as snapshot:
                if current is not None and current.revision_sha == job.revision_sha:
                    replayed = True
                    accepted_state = current
                    full_rebuild = False
                elif current is None or job.kind == "initial" or job.forced:
                    full_rebuild = True
                elif await snapshot.is_ancestor(current.revision_sha, job.revision_sha):
                    full_rebuild = False
                elif await snapshot.is_ancestor(job.revision_sha, current.revision_sha):
                    return IngestionResult(
                        status="stale",
                        revision_sha=job.revision_sha,
                        graph_version=current.graph_version,
                        full_rebuild=False,
                    )
                else:
                    # Non-fast-forward divergence without a trustworthy provider flag.
                    full_rebuild = True

                tracked_paths = await snapshot.tracked_paths()
                if full_rebuild or replayed:
                    affected_paths = tracked_paths
                    source_files = await snapshot.source_files(tracked_paths)
                    parsed = parse_full(source_files)
                else:
                    assert current is not None
                    changed_paths, deleted_paths = await snapshot.changed_paths(
                        current.revision_sha, job.revision_sha
                    )
                    affected_paths = tuple(sorted(set(changed_paths) | set(deleted_paths)))
                    source_files = await snapshot.source_files(changed_paths)
                    parsed = parse_diff(
                        source_files,
                        deleted_paths,
                        repository_paths=tracked_paths,
                    )

                scope = GraphScope(
                    org_id=job.org_id,
                    repository_id=locked_ref.repository_id,
                    ref_name=job.ref_name,
                    revision_sha=job.revision_sha,
                )
                if not replayed:
                    existing_symbols = (
                        () if full_rebuild else await self._graph_store.load_symbols(scope)
                    )
                    projection = build_projection(
                        scope=scope,
                        parsed=parsed,
                        tracked_paths=tracked_paths,
                        existing_symbols=existing_symbols,
                        affected_paths=affected_paths,
                        full_rebuild=full_rebuild,
                        changed_at=job.occurred_at,
                    )
                    await self._graph_store.apply(projection)
                    accepted_state = await locked_ref.accept(job.revision_sha)

        assert accepted_state is not None
        # The state transaction has committed by this point; structural visibility is
        # durable before any external event or vector work is accepted.
        pre_publish_duration_ms = (time.perf_counter() - started) * 1_000
        await self._publisher.graph_updated(
            scope=scope,
            graph_version=accepted_state.graph_version,
            full_rebuild=full_rebuild,
            changed_paths=affected_paths,
            structural_duration_ms=pre_publish_duration_ms,
            trace_id=job.trace_id,
        )
        structural_duration_ms = (time.perf_counter() - started) * 1_000
        if job.kind == "initial":
            await self._publisher.onboarding_generate(
                scope=scope,
                graph_version=accepted_state.graph_version,
                cold_start_started_at_ms=cold_start_started_at_ms,
                trace_id=job.trace_id,
            )

        chunks = build_bounded_chunks(scope, source_files)
        affected_node_ids = tuple(stable_uid(scope, "File", path) for path in affected_paths)
        persisted = await self._chunk_store.replace_chunks(
            scope=scope,
            ref_id=accepted_state.ref_id,
            full_rebuild=full_rebuild or replayed,
            affected_node_ids=affected_node_ids,
            chunks=chunks,
        )
        for chunk in persisted:
            await self._publisher.embedding_upsert(
                embedding_task(scope, accepted_state.ref_id, chunk),
                chunk.chunk.content_hash,
            )

        return IngestionResult(
            status="replayed" if replayed else "accepted",
            revision_sha=job.revision_sha,
            graph_version=accepted_state.graph_version,
            full_rebuild=full_rebuild,
            changed_paths=affected_paths,
            deleted_paths=deleted_paths,
            structural_duration_ms=structural_duration_ms,
        )

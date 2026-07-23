"""Ordering-safe adapters over the W0-04 SNS/SQS topology."""

from __future__ import annotations

import hashlib
from typing import Protocol

from messaging.envelope import MessageEnvelope
from messaging.sns_client import publish_graph_updated
from messaging.sqs_client import (
    EMBEDDING_UPSERTS_QUEUE,
    ENRICHMENT_PRIORITY_QUEUE,
    publish,
)

from .models import EmbeddingTask, GraphScope, PersistedChunk


class IngestionPublisher(Protocol):
    async def graph_updated(
        self,
        *,
        scope: GraphScope,
        graph_version: int,
        full_rebuild: bool,
        changed_paths: tuple[str, ...],
        structural_duration_ms: float,
        trace_id: str | None,
    ) -> None: ...

    async def embedding_upsert(self, task: EmbeddingTask, content_hash: str) -> None: ...

    async def onboarding_generate(
        self,
        *,
        scope: GraphScope,
        graph_version: int,
        cold_start_started_at_ms: int,
        trace_id: str | None,
    ) -> None: ...


def graph_scope_key(scope: GraphScope) -> str:
    raw = "\0".join((scope.org_id, scope.repository_id, scope.ref_name))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class MessagingPublisher:
    async def graph_updated(
        self,
        *,
        scope: GraphScope,
        graph_version: int,
        full_rebuild: bool,
        changed_paths: tuple[str, ...],
        structural_duration_ms: float,
        trace_id: str | None,
    ) -> None:
        scope_key = graph_scope_key(scope)
        envelope = MessageEnvelope(
            org_id=scope.org_id,
            type="graph.updated",
            source="ingestion-worker",
            trace_id=trace_id,
            idempotency_key=f"{scope_key}:{scope.revision_sha}:graph.updated",
            graph_scope_key=scope_key,
            graph_version=graph_version,
            payload={
                "repository_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
                "full_rebuild": full_rebuild,
                "changed_paths": list(changed_paths),
                "structural_duration_ms": structural_duration_ms,
            },
        )
        publish_graph_updated(envelope)

    async def onboarding_generate(
        self,
        *,
        scope: GraphScope,
        graph_version: int,
        cold_start_started_at_ms: int,
        trace_id: str | None,
    ) -> None:
        scope_key = graph_scope_key(scope)
        envelope = MessageEnvelope(
            org_id=scope.org_id,
            type="onboarding.generate",
            source="ingestion-worker",
            trace_id=trace_id,
            idempotency_key=f"{scope_key}:{scope.revision_sha}:onboarding.generate",
            graph_scope_key=scope_key,
            graph_version=graph_version,
            payload={
                "repository_id": scope.repository_id,
                "ref_name": scope.ref_name,
                "revision_sha": scope.revision_sha,
                "cold_start_started_at_ms": cold_start_started_at_ms,
            },
        )
        publish(ENRICHMENT_PRIORITY_QUEUE, envelope)

    async def embedding_upsert(self, task: EmbeddingTask, content_hash: str) -> None:
        envelope = MessageEnvelope(
            org_id=task.org_id,
            type="embedding.upsert",
            source="ingestion-worker",
            idempotency_key=(
                f"{task.repository_id}:{task.ref_name}:{task.revision_sha}:"
                f"{task.graph_node_id}:{content_hash}"
            ),
            payload={
                "repository_id": task.repository_id,
                "ref_id": task.ref_id,
                "ref_name": task.ref_name,
                "revision_sha": task.revision_sha,
                "chunk_id": task.chunk_id,
                "graph_node_id": task.graph_node_id,
            },
        )
        publish(EMBEDDING_UPSERTS_QUEUE, envelope)


def embedding_task(scope: GraphScope, ref_id: str, persisted: PersistedChunk) -> EmbeddingTask:
    return EmbeddingTask(
        org_id=scope.org_id,
        repository_id=scope.repository_id,
        ref_id=ref_id,
        ref_name=scope.ref_name,
        revision_sha=scope.revision_sha,
        chunk_id=persisted.chunk_id,
        graph_node_id=persisted.chunk.graph_node_id,
    )

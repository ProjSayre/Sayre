"""Production construction helpers; queue processes own their delivery-store choice."""

from __future__ import annotations

from .chunks import PostgresChunkStore
from .embeddings import EmbeddingConsumer
from .events import MessagingPublisher
from .graph import Neo4jGraphStore
from .repository import GitRepositorySource
from .service import IngestionService
from .state import PostgresRefStateStore


async def build_ingestion_service() -> IngestionService:
    return IngestionService(
        state_store=await PostgresRefStateStore.from_config(),
        repository_source=GitRepositorySource(),
        graph_store=await Neo4jGraphStore.from_config(),
        chunk_store=await PostgresChunkStore.from_config(),
        publisher=MessagingPublisher(),
    )


async def build_embedding_consumer() -> EmbeddingConsumer:
    return EmbeddingConsumer(await PostgresChunkStore.from_config())

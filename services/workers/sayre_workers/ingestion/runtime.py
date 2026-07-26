"""Production construction helpers; queue processes own their delivery-store choice."""

from __future__ import annotations

from messaging.sns_client import (
    close_client as close_sns_client,
    initialize_client as initialize_sns_client,
)
from messaging.sqs_client import (
    close_client as close_sqs_client,
    initialize_client as initialize_sqs_client,
)
from sayre_workers.config import get_secret
from sayre_workers.db import assert_runtime_role_rls_safe

from .chunks import PostgresChunkStore
from .embeddings import EmbeddingConsumer
from .events import MessagingPublisher
from .github_installation import GitHubInstallationTokenProvider
from .graph import Neo4jGraphStore
from .repository import GitRepositorySource
from .service import IngestionService
from .state import PostgresRefStateStore


async def build_ingestion_service() -> IngestionService:
    # CI/production startup gate (Resolved decision Q2, docs/tenant-isolation.md
    # "DSN-role provisioning risk"). No-ops outside SAYRE_ENV in {"ci","production"}
    # -- local dev's login role is intentionally a superuser.
    await assert_runtime_role_rls_safe(await get_secret("env://DATABASE_RUNTIME_URL"))
    try:
        # Ingestion publishes synchronously through the messaging wrappers from
        # inside an active asyncio loop. Pre-initialize both global clients so
        # those wrappers never attempt a nested asyncio.run().
        await initialize_sns_client()
        await initialize_sqs_client()
        return IngestionService(
            state_store=await PostgresRefStateStore.from_config(),
            repository_source=GitRepositorySource(
                token_provider=GitHubInstallationTokenProvider.from_config()
            ),
            graph_store=await Neo4jGraphStore.from_config(),
            chunk_store=await PostgresChunkStore.from_config(),
            publisher=MessagingPublisher(),
        )
    except Exception:
        close_sns_client()
        close_sqs_client()
        raise


async def build_embedding_consumer() -> EmbeddingConsumer:
    await assert_runtime_role_rls_safe(await get_secret("env://DATABASE_RUNTIME_URL"))
    return EmbeddingConsumer(await PostgresChunkStore.from_config())

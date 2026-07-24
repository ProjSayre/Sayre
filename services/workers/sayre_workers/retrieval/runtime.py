"""Production dependency wiring for Graph-Guided RAG."""

from __future__ import annotations

from sayre_workers.enrichment import ModelProviderFactory, PostgresGenerationConfigStore

from .metrics import OpenTelemetryTokenUsageRecorder
from .service import AuthorizedGraphGateway, RetrievalService
from .store import PostgresRetrievalStore


async def build_retrieval_service(
    graph_gateway: AuthorizedGraphGateway,
) -> RetrievalService:
    """Build retrieval without inventing a second graph authorization client.

    The API/MCP caller supplies an adapter over Core's context-taking Graph Query
    Service functions. W3-03 intentionally does not add a new public HTTP auth path.
    """

    return RetrievalService(
        graph_gateway=graph_gateway,
        store=await PostgresRetrievalStore.from_config(),
        config_store=await PostgresGenerationConfigStore.from_config(),
        provider_factory=ModelProviderFactory(),
        token_usage=OpenTelemetryTokenUsageRecorder(),
    )

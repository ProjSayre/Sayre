"""Production construction for the enrichment worker; queue processes own their
delivery-store choice (mirrors `sayre_workers.ingestion.runtime`)."""

from __future__ import annotations

from .config_store import PostgresGenerationConfigStore
from .enrichment_graph import Neo4jEnrichmentGraphStore
from .graphify_adapter import GraphifyAdapterFactory
from sayre_workers.model_provider import ModelProviderFactory
from .service import EnrichmentService
from .state_store import PostgresProviderJobStateStore


async def build_enrichment_service() -> EnrichmentService:
    return EnrichmentService(
        graph_store=await Neo4jEnrichmentGraphStore.from_config(),
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=GraphifyAdapterFactory(),
        config_store=await PostgresGenerationConfigStore.from_config(),
        state_store=await PostgresProviderJobStateStore.from_config(),
    )

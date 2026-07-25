"""Production construction for the enrichment worker; queue processes own their
delivery-store choice (mirrors `sayre_workers.ingestion.runtime`)."""

from __future__ import annotations

from sayre_workers.config import get_secret
from sayre_workers.db import assert_runtime_role_rls_safe
from sayre_workers.model_provider import ModelProviderFactory

from .config_store import PostgresGenerationConfigStore
from .enrichment_graph import Neo4jEnrichmentGraphStore
from .graphify_adapter import GraphifyAdapterFactory
from .service import EnrichmentService
from .style_classifier import ModelStyleClassifier
from .state_store import PostgresProviderJobStateStore


async def build_enrichment_service() -> EnrichmentService:
    await assert_runtime_role_rls_safe(
        await get_secret("env://DATABASE_RUNTIME_URL")
    )
    return EnrichmentService(
        graph_store=await Neo4jEnrichmentGraphStore.from_config(),
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=GraphifyAdapterFactory(),
        config_store=await PostgresGenerationConfigStore.from_config(),
        style_classifier=ModelStyleClassifier(),
        state_store=await PostgresProviderJobStateStore.from_config(),
    )

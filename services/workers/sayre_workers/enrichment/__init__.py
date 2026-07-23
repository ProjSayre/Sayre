"""Semantic enrichment worker: provider/adapter boundaries, envelope parsing, consumer
wiring, and the org-scoped Neo4j graph-primitive writer (W2-05), plus the priority-lane
onboarding entry points (W2-08)."""

from .config_store import PostgresGenerationConfigStore
from .consumers import run_enrichment_consumer
from .enrichment_graph import (
    EnrichmentGraphStore,
    Neo4jEnrichmentGraphStore,
    validate_enrichment_write,
)
from .events import parse_enrichment_envelope
from .graphify_adapter import FakeGraphifyAdapter, GraphifyAdapter, GraphifyAdapterFactory
from .models import (
    ENRICHMENT_EDGE_TYPES,
    ENRICHMENT_NODE_LABELS,
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentJob,
    EnrichmentNode,
    EnrichmentResult,
    EnrichmentWrite,
    FileContext,
    GenerationConfig,
    GenerationConfigNotFoundError,
    InvalidEnrichmentEventError,
    InvalidEnrichmentWriteError,
)
from .onboarding import (
    InvalidOnboardingJobError,
    OnboardingGenerateJob,
    OnboardingPriorityHandler,
    parse_onboarding_generate,
    run_onboarding_priority_consumer,
)
from .providers import (
    FakeModelProvider,
    GenerationRequest,
    GenerationResponse,
    ModelProvider,
    ModelProviderFactory,
)
from .runtime import build_enrichment_service
from .service import EnrichmentService, GenerationConfigStore

__all__ = [
    "ENRICHMENT_EDGE_TYPES",
    "ENRICHMENT_NODE_LABELS",
    "EnrichmentContext",
    "EnrichmentEdge",
    "EnrichmentGraphStore",
    "EnrichmentJob",
    "EnrichmentNode",
    "EnrichmentResult",
    "EnrichmentService",
    "EnrichmentWrite",
    "FakeGraphifyAdapter",
    "FakeModelProvider",
    "FileContext",
    "GenerationConfig",
    "GenerationConfigNotFoundError",
    "GenerationConfigStore",
    "GenerationRequest",
    "GenerationResponse",
    "GraphifyAdapter",
    "GraphifyAdapterFactory",
    "InvalidEnrichmentEventError",
    "InvalidEnrichmentWriteError",
    "InvalidOnboardingJobError",
    "ModelProvider",
    "ModelProviderFactory",
    "Neo4jEnrichmentGraphStore",
    "OnboardingGenerateJob",
    "OnboardingPriorityHandler",
    "PostgresGenerationConfigStore",
    "build_enrichment_service",
    "parse_enrichment_envelope",
    "parse_onboarding_generate",
    "run_enrichment_consumer",
    "run_onboarding_priority_consumer",
    "validate_enrichment_write",
]

"""Semantic enrichment worker: provider/adapter boundaries, envelope parsing, consumer
wiring, and the org-scoped Neo4j graph-primitive writer (W2-05), plus the priority-lane
onboarding entry points (W2-08) and the D6 bridge (`build_onboarding_generator`) that
plugs this worker's `EnrichmentService.process` into W2-08's dedicated priority-lane
consumer."""

from .config_store import PostgresGenerationConfigStore
from .consumers import run_enrichment_consumer
from .enrichment_graph import (
    EnrichmentGraphStore,
    Neo4jEnrichmentGraphStore,
    validate_enrichment_write,
)
from .events import parse_enrichment_envelope
from .feature_clustering import (
    FEATURE_CLUSTERING_SYSTEM_PROMPT,
    build_feature_clustering_request,
    canonical_feature_key,
    canonicalize_feature_clustering_write,
)
from .graphify_adapter import (
    BaseGraphifyAdapter,
    FakeGraphifyAdapter,
    GraphifyAdapter,
    GraphifyAdapterFactory,
    InvalidGraphifyOutputError,
)
from .models import (
    ENRICHMENT_EDGE_TYPES,
    ENRICHMENT_NODE_LABELS,
    MAX_STYLE_VALUE_CHARS,
    PATCHABLE_PROPERTIES,
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentJob,
    EnrichmentNode,
    EnrichmentResult,
    EnrichmentWrite,
    FileContext,
    FolderContext,
    GenerationConfig,
    GenerationConfigNotFoundError,
    InvalidEnrichmentEventError,
    InvalidEnrichmentWriteError,
    InvalidStyleClassificationError,
    NodePropertyPatch,
)
from .onboarding import (
    InvalidOnboardingJobError,
    OnboardingGenerateJob,
    OnboardingPriorityHandler,
    parse_onboarding_generate,
    run_onboarding_priority_consumer,
)
from .onboarding_bridge import build_onboarding_generator
from .providers import (
    FakeModelProvider,
    GenerationRequest,
    GenerationResponse,
    ModelProvider,
    ModelProviderFactory,
    StructuredGenerationResponse,
)
from .runtime import build_enrichment_service
from .service import EnrichmentService, GenerationConfigStore
from .style_classifier import ModelStyleClassifier, StyleClassifier

__all__ = [
    "ENRICHMENT_EDGE_TYPES",
    "ENRICHMENT_NODE_LABELS",
    "MAX_STYLE_VALUE_CHARS",
    "PATCHABLE_PROPERTIES",
    "EnrichmentContext",
    "EnrichmentEdge",
    "EnrichmentGraphStore",
    "EnrichmentJob",
    "EnrichmentNode",
    "EnrichmentResult",
    "EnrichmentService",
    "EnrichmentWrite",
    "FEATURE_CLUSTERING_SYSTEM_PROMPT",
    "BaseGraphifyAdapter",
    "FakeGraphifyAdapter",
    "FakeModelProvider",
    "FileContext",
    "FolderContext",
    "GenerationConfig",
    "GenerationConfigNotFoundError",
    "GenerationConfigStore",
    "GenerationRequest",
    "GenerationResponse",
    "GraphifyAdapter",
    "GraphifyAdapterFactory",
    "InvalidGraphifyOutputError",
    "InvalidEnrichmentEventError",
    "InvalidEnrichmentWriteError",
    "InvalidStyleClassificationError",
    "InvalidOnboardingJobError",
    "ModelProvider",
    "ModelProviderFactory",
    "Neo4jEnrichmentGraphStore",
    "NodePropertyPatch",
    "OnboardingGenerateJob",
    "OnboardingPriorityHandler",
    "PostgresGenerationConfigStore",
    "ModelStyleClassifier",
    "StyleClassifier",
    "StructuredGenerationResponse",
    "build_enrichment_service",
    "build_feature_clustering_request",
    "build_onboarding_generator",
    "canonical_feature_key",
    "canonicalize_feature_clustering_write",
    "parse_enrichment_envelope",
    "parse_onboarding_generate",
    "run_enrichment_consumer",
    "run_onboarding_priority_consumer",
    "validate_enrichment_write",
]

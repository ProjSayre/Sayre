"""Repository ingestion, structural head projection, and async embedding boundary."""

from .embeddings import (
    DEFAULT_EMBEDDING_MODEL,
    EMBEDDING_DIMENSION,
    DeterministicEmbeddingProvider,
    EmbeddingConsumer,
    EmbeddingProvider,
    OpenAICompatibleEmbeddingProvider,
    validate_embeddings,
)
from .budgets import STRUCTURAL_SYNC_TARGET_MS
from .models import (
    IgnoredIngestionMessage,
    IngestionCommand,
    IngestionResult,
    InvalidIngestionJobError,
    RefDeletionCommand,
    classify_ingestion_envelope,
    parse_ingestion_envelope,
)
from .consumers import run_embedding_consumer, run_ingestion_consumer
from .service import IngestionService

__all__ = [
    "DEFAULT_EMBEDDING_MODEL",
    "EMBEDDING_DIMENSION",
    "STRUCTURAL_SYNC_TARGET_MS",
    "DeterministicEmbeddingProvider",
    "EmbeddingConsumer",
    "EmbeddingProvider",
    "IgnoredIngestionMessage",
    "IngestionCommand",
    "IngestionResult",
    "IngestionService",
    "InvalidIngestionJobError",
    "OpenAICompatibleEmbeddingProvider",
    "RefDeletionCommand",
    "classify_ingestion_envelope",
    "parse_ingestion_envelope",
    "run_embedding_consumer",
    "run_ingestion_consumer",
    "validate_embeddings",
]

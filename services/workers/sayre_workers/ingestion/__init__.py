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
from .models import IngestionResult, InvalidIngestionJobError, parse_ingestion_envelope
from .consumers import run_embedding_consumer, run_ingestion_consumer
from .service import IngestionService

__all__ = [
    "DEFAULT_EMBEDDING_MODEL",
    "EMBEDDING_DIMENSION",
    "DeterministicEmbeddingProvider",
    "EmbeddingConsumer",
    "EmbeddingProvider",
    "IngestionResult",
    "IngestionService",
    "InvalidIngestionJobError",
    "OpenAICompatibleEmbeddingProvider",
    "parse_ingestion_envelope",
    "run_embedding_consumer",
    "run_ingestion_consumer",
    "validate_embeddings",
]

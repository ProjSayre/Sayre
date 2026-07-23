"""Compatibility exports for the canonical top-level generation provider package.

New code, including W3-03 retrieval, should import ``sayre_workers.model_provider``.
These re-exports keep the W2-05 enrichment import surface source-compatible.
"""

from sayre_workers.model_provider import (
    FakeModelProvider,
    GenerationRequest,
    GenerationResponse,
    ModelProvider,
    ModelProviderFactory,
    StructuredGenerationResponse,
)

__all__ = [
    "FakeModelProvider",
    "GenerationRequest",
    "GenerationResponse",
    "ModelProvider",
    "ModelProviderFactory",
    "StructuredGenerationResponse",
]

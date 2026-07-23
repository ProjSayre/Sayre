"""Model-generation provider boundary.

No vendor SDK import in this module (`.pipeline/spec.md` Scope/Out) -- concrete
`anthropic`/`openai`/`openai_compatible` adapters are W3-07. Mirrors the shape of
`sayre_workers.ingestion.embeddings`'s `EmbeddingProvider`/`EmbeddingProviderFactory`
boundary.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

from sayre_workers.config import get_config

from .models import GenerationConfig


@dataclass(frozen=True)
class GenerationRequest:
    system: str
    input: str
    max_output_tokens: int = 1024


@dataclass(frozen=True)
class GenerationResponse:
    text: str


class ModelProvider(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResponse: ...


class FakeModelProvider:
    """Deterministic, network-free generation stand-in for skeleton + CI."""

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        digest = hashlib.sha256(
            f"{request.system}\0{request.input}\0{request.max_output_tokens}".encode("utf-8")
        ).hexdigest()
        return GenerationResponse(text=f"fake-generation:{digest}")


class ModelProviderFactory:
    async def create(self, config: GenerationConfig) -> ModelProvider:
        if config.provider == "fake_deterministic":
            # Allowed ONLY under SAYRE_ENV=="test" (mirrors
            # DeterministicEmbeddingProvider's gate). No production fallback to the
            # fake -- a missing/unsupported real provider must fail visibly, never
            # silently substitute a deterministic stand-in (Decision D2).
            if get_config("SAYRE_ENV") != "test":
                raise ValueError("fake_deterministic generation provider is test-only")
            return FakeModelProvider()
        if config.provider in {"anthropic", "openai", "openai_compatible"}:
            raise NotImplementedError(
                "concrete generation ModelProvider adapters land in W3-07"
            )
        raise ValueError("unsupported generation provider")

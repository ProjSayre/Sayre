"""Separate embedding-provider boundary and asynchronous embedding consumer."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from typing import Any, Protocol

from openai import AsyncOpenAI

from messaging.envelope import MessageEnvelope
from sayre_workers.config import get_config, get_secret

from .chunks import EmbeddingStore
from .models import EmbeddingConfig, EmbeddingTask

EMBEDDING_DIMENSION = 1024
DEFAULT_EMBEDDING_MODEL = "Qwen3-Embedding-0.6B"


class InvalidEmbeddingError(ValueError):
    pass


class EmbeddingProvider(Protocol):
    async def embed(self, texts: Sequence[str]) -> tuple[tuple[float, ...], ...]: ...


def validate_embeddings(
    vectors: Sequence[Sequence[float]], expected_count: int
) -> tuple[tuple[float, ...], ...]:
    if len(vectors) != expected_count:
        raise InvalidEmbeddingError("embedding provider returned the wrong item count")
    validated: list[tuple[float, ...]] = []
    for vector in vectors:
        if len(vector) != EMBEDDING_DIMENSION:
            raise InvalidEmbeddingError("embedding provider must return exactly 1024 dimensions")
        converted = tuple(float(value) for value in vector)
        if not all(math.isfinite(value) for value in converted):
            raise InvalidEmbeddingError("embedding provider returned a non-finite value")
        validated.append(converted)
    return tuple(validated)


class DeterministicEmbeddingProvider:
    """Network-free CI fake with stable, non-trivial 1024-dimensional output."""

    async def embed(self, texts: Sequence[str]) -> tuple[tuple[float, ...], ...]:
        vectors: list[tuple[float, ...]] = []
        for text in texts:
            values: list[float] = []
            counter = 0
            while len(values) < EMBEDDING_DIMENSION:
                digest = hashlib.sha256(
                    text.encode("utf-8") + counter.to_bytes(4, "big")
                ).digest()
                values.extend((byte - 127.5) / 127.5 for byte in digest)
                counter += 1
            vectors.append(tuple(values[:EMBEDDING_DIMENSION]))
        return validate_embeddings(vectors, len(texts))


class OpenAICompatibleEmbeddingProvider:
    def __init__(self, client: Any, model: str = DEFAULT_EMBEDDING_MODEL) -> None:
        self._client = client
        self._model = model

    @classmethod
    async def from_config(cls, config: EmbeddingConfig) -> "OpenAICompatibleEmbeddingProvider":
        api_key = (
            await get_secret(config.credential_ref)
            if config.credential_ref is not None
            else "local-endpoint-no-key"
        )
        client = AsyncOpenAI(api_key=api_key, base_url=config.endpoint_url, timeout=30.0)
        return cls(client, config.model or DEFAULT_EMBEDDING_MODEL)

    async def embed(self, texts: Sequence[str]) -> tuple[tuple[float, ...], ...]:
        response = await self._client.embeddings.create(model=self._model, input=list(texts))
        ordered = sorted(response.data, key=lambda item: item.index)
        return validate_embeddings([item.embedding for item in ordered], len(texts))


class EmbeddingProviderFactory:
    async def create(self, config: EmbeddingConfig) -> EmbeddingProvider:
        if config.dimension != EMBEDDING_DIMENSION:
            raise InvalidEmbeddingError("embedding configuration dimension must be 1024")
        if config.provider == "deterministic_fake":
            if get_config("SAYRE_ENV") != "test":
                raise InvalidEmbeddingError("deterministic embedding provider is test-only")
            return DeterministicEmbeddingProvider()
        if config.provider in {"openai", "openai_compatible"}:
            return await OpenAICompatibleEmbeddingProvider.from_config(config)
        raise InvalidEmbeddingError("unsupported embedding provider")


def parse_embedding_task(envelope: MessageEnvelope) -> EmbeddingTask:
    if envelope.type != "embedding.upsert" or not isinstance(envelope.payload, dict):
        raise ValueError("unsupported embedding envelope")
    payload = envelope.payload

    def required(name: str) -> str:
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"embedding payload {name} must be a non-blank string")
        return value

    return EmbeddingTask(
        org_id=envelope.org_id,
        repository_id=required("repository_id"),
        ref_id=required("ref_id"),
        ref_name=required("ref_name"),
        revision_sha=required("revision_sha"),
        chunk_id=required("chunk_id"),
        graph_node_id=required("graph_node_id"),
    )


class EmbeddingConsumer:
    def __init__(self, store: EmbeddingStore, factory: EmbeddingProviderFactory | None = None) -> None:
        self._store = store
        self._factory = factory or EmbeddingProviderFactory()

    async def handle(self, envelope: MessageEnvelope) -> bool:
        task = parse_embedding_task(envelope)
        work = await self._store.load_embedding_work(task)
        if work is None:
            return False
        provider = await self._factory.create(work.config)
        vector = (await provider.embed([work.content]))[0]
        return await self._store.store_embedding(work, vector)

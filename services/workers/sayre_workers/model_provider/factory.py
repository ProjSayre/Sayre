"""Configuration-driven generation provider selection."""

from __future__ import annotations

import asyncio
import hashlib
import json

from sayre_workers.config import get_config

from .anthropic_adapter import AnthropicModelProvider
from .fake import FakeModelProvider
from .openai_compatible_adapter import OpenAICompatibleModelProvider
from .protocol import (
    GenerationConfig,
    InvalidModelProviderConfigError,
    ModelProvider,
)
from .resilience import (
    ProviderCallScope,
    ResiliencePolicy,
    ResilientModelProvider,
)


class ModelProviderFactory:
    def __init__(self) -> None:
        self._providers: dict[str, ResilientModelProvider] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    @staticmethod
    def _cache_key(config: GenerationConfig, scope: ProviderCallScope) -> str:
        try:
            serialized = json.dumps(
                {
                    "org_id": scope.org_id,
                    "purpose": scope.purpose,
                    "provider": config.provider,
                    "model": config.model,
                    "endpoint_url": config.endpoint_url,
                    "credential_ref": config.credential_ref,
                    "options": config.options,
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
        except (TypeError, ValueError):
            raise InvalidModelProviderConfigError(
                "generation provider configuration must be JSON-compatible"
            ) from None
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    async def _create_base(self, config: GenerationConfig) -> ModelProvider:
        if config.provider == "fake_deterministic":
            if get_config("SAYRE_ENV") != "test":
                raise InvalidModelProviderConfigError(
                    "fake_deterministic generation provider is test-only"
                )
            return FakeModelProvider()
        if config.provider == "anthropic":
            return await AnthropicModelProvider.from_config(config)
        if config.provider in {"openai", "openai_compatible"}:
            return await OpenAICompatibleModelProvider.from_config(config)
        raise InvalidModelProviderConfigError("unsupported generation provider")

    async def create(
        self, config: GenerationConfig, scope: ProviderCallScope
    ) -> ModelProvider:
        policy = ResiliencePolicy.from_options(config.options)
        cache_key = self._cache_key(config, scope)
        async with self._lock:
            if self._closed:
                raise RuntimeError("model provider factory is closed")
            existing = self._providers.get(cache_key)
            if existing is not None:
                return existing
            provider = ResilientModelProvider(await self._create_base(config), policy)
            self._providers[cache_key] = provider
            return provider

    async def aclose(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            providers = tuple(self._providers.values())
            self._providers.clear()

        close_failed = False
        for provider in providers:
            try:
                await provider.aclose()
            except Exception:
                close_failed = True
        if close_failed:
            raise RuntimeError("one or more model provider clients failed to close")

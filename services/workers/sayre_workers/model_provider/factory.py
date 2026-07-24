"""Configuration-driven generation provider selection."""

from __future__ import annotations

from sayre_workers.config import get_config

from .anthropic_adapter import AnthropicModelProvider
from .fake import FakeModelProvider
from .openai_compatible_adapter import OpenAICompatibleModelProvider
from .protocol import (
    GenerationConfig,
    InvalidModelProviderConfigError,
    ModelProvider,
)


class ModelProviderFactory:
    async def create(self, config: GenerationConfig) -> ModelProvider:
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

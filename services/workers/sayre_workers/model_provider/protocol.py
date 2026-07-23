"""Vendor-neutral generation model contracts.

The generation boundary is deliberately separate from ``EmbeddingProvider``.  It is
shared by enrichment today and by retrieval once W3-03 consumes this package.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

MAX_OUTPUT_TOKENS = 65_536


class InvalidModelProviderConfigError(ValueError):
    """A provider row cannot safely construct the selected adapter."""


class InvalidGenerationRequestError(ValueError):
    """A generation request is invalid before any network call is attempted."""


class ModelProviderResponseError(RuntimeError):
    """A provider returned no usable response.

    Messages intentionally describe only the failed contract.  They must never include
    prompts, raw response bodies, endpoints containing credentials, or secret values.
    """


@dataclass(frozen=True)
class GenerationConfig:
    provider: str
    model: str
    endpoint_url: str | None = None
    credential_ref: str | None = None
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GenerationRequest:
    system: str
    input: str
    max_output_tokens: int = 1024
    temperature: float | None = None


@dataclass(frozen=True)
class GenerationResponse:
    text: str


@dataclass(frozen=True)
class StructuredGenerationResponse:
    data: dict[str, Any]


class ModelProvider(Protocol):
    async def generate(self, request: GenerationRequest) -> GenerationResponse: ...

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse: ...


def validate_generation_request(request: GenerationRequest) -> None:
    if not isinstance(request.system, str) or not request.system.strip():
        raise InvalidGenerationRequestError("generation system prompt must be non-blank")
    if not isinstance(request.input, str) or not request.input.strip():
        raise InvalidGenerationRequestError("generation input must be non-blank")
    if (
        isinstance(request.max_output_tokens, bool)
        or not isinstance(request.max_output_tokens, int)
        or not 1 <= request.max_output_tokens <= MAX_OUTPUT_TOKENS
    ):
        raise InvalidGenerationRequestError(
            f"max_output_tokens must be between 1 and {MAX_OUTPUT_TOKENS}"
        )
    if request.temperature is not None and (
        isinstance(request.temperature, bool)
        or not isinstance(request.temperature, (int, float))
        or not 0 <= float(request.temperature) <= 2
    ):
        raise InvalidGenerationRequestError("temperature must be between 0 and 2")


def validate_model(config: GenerationConfig) -> str:
    if not isinstance(config.model, str) or not config.model.strip():
        raise InvalidModelProviderConfigError("generation model must be non-blank")
    return config.model.strip()


def configured_temperature(
    request: GenerationRequest, options: Mapping[str, Any]
) -> float | None:
    """Resolve an optional request/config temperature without accepting arbitrary SDK options."""
    value: object = request.temperature
    if value is None:
        value = options.get("temperature")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 2:
        raise InvalidGenerationRequestError("temperature must be between 0 and 2")
    return float(value)

"""Anthropic-native generation adapter.

This is the only generation module allowed to import or construct the Anthropic SDK.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from anthropic import AsyncAnthropic

from sayre_workers.config import get_secret

from .protocol import (
    GenerationConfig,
    GenerationRequest,
    GenerationResponse,
    InvalidModelProviderConfigError,
    ModelProviderResponseError,
    StructuredGenerationResponse,
    configured_temperature,
    validate_generation_request,
    validate_model,
)

_STRUCTURED_TOOL_NAME = "emit_structured_output"


class AnthropicModelProvider:
    def __init__(
        self,
        client: Any,
        model: str,
        *,
        options: Mapping[str, Any] | None = None,
    ) -> None:
        self._client = client
        self._model = model
        self._options = dict(options or {})

    @classmethod
    async def from_config(cls, config: GenerationConfig) -> "AnthropicModelProvider":
        model = validate_model(config)
        if config.endpoint_url is not None:
            raise InvalidModelProviderConfigError(
                "anthropic-native provider does not accept a custom endpoint"
            )
        if config.credential_ref is None:
            raise InvalidModelProviderConfigError(
                "anthropic provider requires a credential reference"
            )
        api_key = await get_secret(config.credential_ref)
        return cls(AsyncAnthropic(api_key=api_key), model, options=config.options)

    def _common_request(self, request: GenerationRequest) -> dict[str, Any]:
        validate_generation_request(request)
        arguments: dict[str, Any] = {
            "model": self._model,
            "max_tokens": request.max_output_tokens,
            "system": request.system,
            "messages": [{"role": "user", "content": request.input}],
        }
        temperature = configured_temperature(request, self._options)
        if temperature is not None:
            arguments["temperature"] = temperature
        return arguments

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        response = await self._client.messages.create(**self._common_request(request))
        text = "".join(
            str(block.text)
            for block in getattr(response, "content", ())
            if getattr(block, "type", None) == "text" and getattr(block, "text", None)
        ).strip()
        if not text:
            raise ModelProviderResponseError("anthropic response contained no text")
        return GenerationResponse(text=text)

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse:
        arguments = self._common_request(request)
        arguments.update(
            {
                "tools": [
                    {
                        "name": _STRUCTURED_TOOL_NAME,
                        "description": "Return the requested structured result.",
                        "input_schema": dict(schema),
                    }
                ],
                "tool_choice": {"type": "tool", "name": _STRUCTURED_TOOL_NAME},
            }
        )
        response = await self._client.messages.create(**arguments)
        for block in getattr(response, "content", ()):
            if (
                getattr(block, "type", None) == "tool_use"
                and getattr(block, "name", None) == _STRUCTURED_TOOL_NAME
            ):
                data = getattr(block, "input", None)
                if isinstance(data, Mapping):
                    return StructuredGenerationResponse(data=dict(data))
                break
        raise ModelProviderResponseError(
            "anthropic response contained no structured tool result"
        )

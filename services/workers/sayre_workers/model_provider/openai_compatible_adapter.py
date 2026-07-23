"""OpenAI-compatible chat-completions generation adapter.

One implementation covers hosted OpenAI and explicitly configured local/self-hosted
servers.  This is the only generation module allowed to import or construct the
OpenAI SDK.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from openai import AsyncOpenAI, DefaultAsyncHttpxClient

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


def _validated_endpoint(value: str | None) -> str:
    if value is None or not value.strip():
        raise InvalidModelProviderConfigError(
            "openai-compatible provider requires an explicit endpoint"
        )
    endpoint = value.strip()
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise InvalidModelProviderConfigError(
            "openai-compatible endpoint must be an absolute HTTP(S) URL "
            "without credentials, query, or fragment"
        )
    return endpoint


class OpenAICompatibleModelProvider:
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
    async def from_config(
        cls, config: GenerationConfig
    ) -> "OpenAICompatibleModelProvider":
        model = validate_model(config)
        if config.provider == "openai":
            if config.endpoint_url is not None:
                raise InvalidModelProviderConfigError(
                    "hosted openai provider does not accept a custom endpoint"
                )
            if config.credential_ref is None:
                raise InvalidModelProviderConfigError(
                    "hosted openai provider requires a credential reference"
                )
            api_key = await get_secret(config.credential_ref)
            client = AsyncOpenAI(api_key=api_key)
        elif config.provider == "openai_compatible":
            endpoint = _validated_endpoint(config.endpoint_url)
            api_key = (
                await get_secret(config.credential_ref)
                if config.credential_ref is not None
                else "local-endpoint-no-key"
            )
            # Supplying base_url explicitly is the structural no-fallback guarantee:
            # the SDK cannot silently select api.openai.com for this provider shape.
            # Disable environment proxy inheritance as well: a customer's local
            # endpoint must not be redirected through a third-party proxy by ambient
            # worker environment.
            client = AsyncOpenAI(
                api_key=api_key,
                base_url=endpoint,
                http_client=DefaultAsyncHttpxClient(trust_env=False),
            )
        else:
            raise InvalidModelProviderConfigError(
                "openai-compatible adapter received the wrong provider selector"
            )
        return cls(client, model, options=config.options)

    def _common_request(self, request: GenerationRequest) -> dict[str, Any]:
        validate_generation_request(request)
        arguments: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": request.input},
            ],
            "max_tokens": request.max_output_tokens,
        }
        temperature = configured_temperature(request, self._options)
        if temperature is not None:
            arguments["temperature"] = temperature
        return arguments

    @staticmethod
    def _content(response: Any) -> str:
        choices = getattr(response, "choices", None)
        if not choices:
            raise ModelProviderResponseError("openai-compatible response contained no choice")
        content = getattr(getattr(choices[0], "message", None), "content", None)
        if not isinstance(content, str) or not content.strip():
            raise ModelProviderResponseError("openai-compatible response contained no text")
        return content.strip()

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        response = await self._client.chat.completions.create(**self._common_request(request))
        return GenerationResponse(text=self._content(response))

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse:
        arguments = self._common_request(request)
        arguments["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "sayre_structured_output",
                "strict": True,
                "schema": dict(schema),
            },
        }
        response = await self._client.chat.completions.create(**arguments)
        try:
            data = json.loads(self._content(response))
        except (TypeError, ValueError):
            raise ModelProviderResponseError(
                "openai-compatible response was not valid structured JSON"
            ) from None
        if not isinstance(data, dict):
            raise ModelProviderResponseError(
                "openai-compatible structured response must be an object"
            )
        return StructuredGenerationResponse(data=data)

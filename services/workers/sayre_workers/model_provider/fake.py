"""Deterministic, network-free generation provider for tests."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from .protocol import (
    GenerationRequest,
    GenerationResponse,
    StructuredGenerationResponse,
    validate_generation_request,
)


def _minimal_schema_value(schema: Mapping[str, Any]) -> Any:
    alternatives = schema.get("oneOf")
    if isinstance(alternatives, list) and alternatives:
        first = alternatives[0]
        if isinstance(first, Mapping):
            return _minimal_schema_value(first)

    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0]
    if "const" in schema:
        return schema["const"]

    schema_type = schema.get("type")
    if schema_type == "object":
        properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(properties, Mapping) or not isinstance(required, list):
            return {}
        return {
            name: _minimal_schema_value(properties[name])
            for name in required
            if name in properties and isinstance(properties[name], Mapping)
        }
    if schema_type == "array":
        minimum = schema.get("minItems", 0)
        items = schema.get("items")
        if (
            isinstance(minimum, int)
            and minimum > 0
            and isinstance(items, Mapping)
        ):
            return [_minimal_schema_value(items) for _ in range(minimum)]
        return []
    if schema_type == "integer":
        return int(schema.get("minimum", 0))
    if schema_type == "number":
        return float(schema.get("minimum", 0))
    if schema_type == "boolean":
        return False
    if schema_type == "null":
        return None
    return "fake"


class FakeModelProvider:
    """Stable stand-in that never imports or constructs a vendor SDK."""

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        validate_generation_request(request)
        digest = hashlib.sha256(
            (
                f"{request.system}\0{request.input}\0{request.max_output_tokens}"
                f"\0{request.temperature}"
            ).encode("utf-8")
        ).hexdigest()
        return GenerationResponse(text=f"fake-generation:{digest}")

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse:
        validate_generation_request(request)
        value = _minimal_schema_value(schema)
        if not isinstance(value, dict):
            value = {}
        return StructuredGenerationResponse(data=value)

    async def aclose(self) -> None:
        return None

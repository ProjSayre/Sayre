"""Strict model boundary for the cold-start Onboarding Tree projection.

The priority lane may emit only graph-internal ``EnvStep`` nodes and ``REQUIRES``
edges.  Commands are deliberately treated as untrusted data here; execution is a
separate, container-only service boundary in ``services/core``.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from sayre_workers.model_provider import GenerationRequest

from .graphify_adapter import GraphifyAdapter
from .models import (
    EnrichmentContext,
    EnrichmentWrite,
    InvalidEnrichmentWriteError,
)

MAX_ONBOARDING_STEPS = 24
MAX_ONBOARDING_COMMAND_CHARS = 4_096

ONBOARDING_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["nodes", "edges"],
    "properties": {
        "nodes": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_ONBOARDING_STEPS,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "label", "properties"],
                "properties": {
                    "id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "label": {"const": "EnvStep"},
                    "properties": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["sequence", "command"],
                        "properties": {
                            "sequence": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": MAX_ONBOARDING_STEPS - 1,
                            },
                            "command": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": MAX_ONBOARDING_COMMAND_CHARS,
                            },
                        },
                    },
                },
            },
        },
        "edges": {
            "type": "array",
            "maxItems": MAX_ONBOARDING_STEPS * (MAX_ONBOARDING_STEPS - 1),
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["source", "target", "relationship"],
                "properties": {
                    "source": {"type": "string", "minLength": 1, "maxLength": 128},
                    "target": {"type": "string", "minLength": 1, "maxLength": 128},
                    "relationship": {"const": "REQUIRES"},
                },
            },
        },
    },
}


def onboarding_output_schema() -> Mapping[str, Any]:
    """Return an isolated schema copy so provider adapters cannot mutate globals."""

    return deepcopy(ONBOARDING_OUTPUT_SCHEMA)


def build_onboarding_request(context: EnrichmentContext) -> GenerationRequest:
    """Build a bounded prompt from graph metadata, never a live checkout."""

    paths = [file.path for file in context.files[:500]]
    languages = sorted(
        {file.language for file in context.files if file.language is not None}
    )
    return GenerationRequest(
        system=(
            "Generate a minimal repository setup workflow. Return only EnvStep graph "
            "primitives matching the supplied JSON schema. Sequences must be unique, "
            "contiguous, and zero-based. A REQUIRES edge points from a later step to "
            "its prerequisite. Commands are untrusted and will run in a networkless, "
            "read-only container with an empty tmpfs workspace; never assume host "
            "filesystem access, secrets, bind mounts, or an interactive terminal."
        ),
        input=(
            f"repository={context.scope.repository_id} "
            f"ref={context.scope.ref_name} "
            f"revision={context.scope.revision_sha} "
            f"languages={languages!r} files={paths!r}"
        ),
        max_output_tokens=2_048,
        temperature=0.0,
    )


def canonicalize_onboarding_write(write: EnrichmentWrite) -> EnrichmentWrite:
    """Fail closed unless the model produced one valid acyclic ordered workflow."""

    if write.property_patches:
        raise InvalidEnrichmentWriteError(
            "onboarding projection cannot patch structural node properties"
        )
    if not write.nodes or len(write.nodes) > MAX_ONBOARDING_STEPS:
        raise InvalidEnrichmentWriteError(
            f"onboarding projection requires 1-{MAX_ONBOARDING_STEPS} EnvStep nodes"
        )

    step_sequence: dict[str, int] = {}
    seen_sequences: set[int] = set()
    for node in write.nodes:
        if node.label != "EnvStep":
            raise InvalidEnrichmentWriteError(
                "onboarding projection may contain only EnvStep nodes"
            )
        if set(node.properties) != {"sequence", "command"}:
            raise InvalidEnrichmentWriteError(
                "EnvStep properties must be exactly sequence and command"
            )
        sequence = node.properties["sequence"]
        command = node.properties["command"]
        if (
            isinstance(sequence, bool)
            or not isinstance(sequence, int)
            or sequence < 0
            or sequence >= MAX_ONBOARDING_STEPS
        ):
            raise InvalidEnrichmentWriteError("EnvStep sequence is outside its bound")
        if sequence in seen_sequences:
            raise InvalidEnrichmentWriteError("EnvStep sequences must be unique")
        if (
            not isinstance(command, str)
            or not command.strip()
            or "\x00" in command
            or len(command) > MAX_ONBOARDING_COMMAND_CHARS
        ):
            raise InvalidEnrichmentWriteError(
                "EnvStep command must be a bounded non-blank string"
            )
        seen_sequences.add(sequence)
        step_sequence[node.uid] = sequence

    expected_sequences = set(range(len(write.nodes)))
    if seen_sequences != expected_sequences:
        raise InvalidEnrichmentWriteError(
            "EnvStep sequences must be contiguous and zero-based"
        )

    seen_edges: set[tuple[str, str]] = set()
    for edge in write.edges:
        if edge.relationship != "REQUIRES":
            raise InvalidEnrichmentWriteError(
                "onboarding projection may contain only REQUIRES edges"
            )
        if edge.properties:
            raise InvalidEnrichmentWriteError(
                "onboarding REQUIRES edges cannot carry model-written properties"
            )
        if edge.source_uid not in step_sequence or edge.target_uid not in step_sequence:
            raise InvalidEnrichmentWriteError(
                "onboarding REQUIRES endpoints must be generated EnvStep nodes"
            )
        if step_sequence[edge.source_uid] <= step_sequence[edge.target_uid]:
            raise InvalidEnrichmentWriteError(
                "an EnvStep may require only an earlier sequence"
            )
        pair = (edge.source_uid, edge.target_uid)
        if pair in seen_edges:
            raise InvalidEnrichmentWriteError(
                "onboarding projection contains a duplicate REQUIRES edge"
            )
        seen_edges.add(pair)

    return EnrichmentWrite(
        scope=write.scope,
        nodes=tuple(sorted(write.nodes, key=lambda node: int(node.properties["sequence"]))),
        edges=tuple(
            sorted(
                write.edges,
                key=lambda edge: (
                    step_sequence[edge.source_uid],
                    step_sequence[edge.target_uid],
                    edge.source_uid,
                    edge.target_uid,
                ),
            )
        ),
    )


class OnboardingGraphifyAdapter:
    """Apply the onboarding-only schema before and after base Graphify shaping."""

    def __init__(self, delegate: GraphifyAdapter) -> None:
        self._delegate = delegate

    def schema(self, context: EnrichmentContext) -> Mapping[str, Any]:
        del context
        return onboarding_output_schema()

    async def shape(self, context: EnrichmentContext, generation: Any) -> EnrichmentWrite:
        shaped = await self._delegate.shape(context, generation)
        return canonicalize_onboarding_write(shaped)

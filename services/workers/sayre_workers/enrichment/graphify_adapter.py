"""Graphify semantic-output shaping boundary.

The pinned PyPI distribution is named ``graphifyy`` but exposes the import module
``graphify``.  This is the only Sayre module allowed to import base Graphify.
Graphify normalizes semantic nodes/edges; W1-01's Tree-sitter structural parser
remains a separate pipeline.
"""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from typing import Any, Protocol

from graphify import build_from_json

from sayre_workers.ingestion.projection import stable_uid
from sayre_workers.model_provider import StructuredGenerationResponse

from .models import (
    ENRICHMENT_EDGE_TYPES,
    ENRICHMENT_NODE_LABELS,
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentNode,
    EnrichmentWrite,
)


class InvalidGraphifyOutputError(ValueError):
    """Structured semantic output cannot be safely converted to graph primitives."""


GRAPHIFY_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["nodes", "edges"],
    "properties": {
        "nodes": {
            "type": "array",
            "items": {
                "oneOf": [
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["id", "label", "properties"],
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "label": {"type": "string", "const": "Feature"},
                            "properties": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["name", "description", "team"],
                                "properties": {
                                    "name": {"type": "string", "minLength": 1},
                                    "description": {"type": "string"},
                                    "team": {"type": ["string", "null"]},
                                },
                            },
                        },
                    },
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["id", "label", "properties"],
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "label": {"type": "string", "const": "EnvStep"},
                            "properties": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["sequence", "command"],
                                "properties": {
                                    "sequence": {"type": "integer", "minimum": 0},
                                    "command": {"type": "string", "minLength": 1},
                                },
                            },
                        },
                    },
                ]
            },
        },
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["source", "target", "relationship"],
                "properties": {
                    "source": {"type": "string", "minLength": 1},
                    "target": {"type": "string", "minLength": 1},
                    "relationship": {
                        "enum": ["PART_OF", "REFERENCES", "REQUIRES"]
                    },
                },
            },
        },
    },
}


class GraphifyAdapter(Protocol):
    def schema(self, context: EnrichmentContext) -> Mapping[str, Any]: ...

    async def shape(
        self,
        context: EnrichmentContext,
        generation: StructuredGenerationResponse,
    ) -> EnrichmentWrite: ...


def _record(
    value: object,
    name: str,
    *,
    keys: frozenset[str],
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise InvalidGraphifyOutputError(f"{name} must be an object")
    actual = frozenset(str(key) for key in value)
    if actual != keys:
        raise InvalidGraphifyOutputError(f"{name} has an invalid field set")
    return value


def _nonblank(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidGraphifyOutputError(f"{name} must be a non-blank string")
    return value.strip()


def _feature_properties(value: object) -> dict[str, Any]:
    item = _record(
        value,
        "Feature.properties",
        keys=frozenset({"name", "description", "team"}),
    )
    name = _nonblank(item["name"], "Feature.properties.name")
    description = item["description"]
    team = item["team"]
    if not isinstance(description, str):
        raise InvalidGraphifyOutputError(
            "Feature.properties.description must be a string"
        )
    if team is not None and (not isinstance(team, str) or not team.strip()):
        raise InvalidGraphifyOutputError(
            "Feature.properties.team must be null or a non-blank string"
        )
    return {
        "name": name,
        "description": description,
        "team": team.strip() if isinstance(team, str) else None,
    }


def _env_step_properties(value: object) -> dict[str, Any]:
    item = _record(
        value,
        "EnvStep.properties",
        keys=frozenset({"sequence", "command"}),
    )
    sequence = item["sequence"]
    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise InvalidGraphifyOutputError(
            "EnvStep.properties.sequence must be a non-negative integer"
        )
    return {
        "sequence": sequence,
        "command": _nonblank(item["command"], "EnvStep.properties.command"),
    }


class BaseGraphifyAdapter:
    """Normalize schema-constrained semantic output through base Graphify."""

    def schema(self, context: EnrichmentContext) -> Mapping[str, Any]:
        del context
        return deepcopy(GRAPHIFY_OUTPUT_SCHEMA)

    async def shape(
        self,
        context: EnrichmentContext,
        generation: StructuredGenerationResponse,
    ) -> EnrichmentWrite:
        payload = generation.data
        if frozenset(payload) != frozenset({"nodes", "edges"}):
            raise InvalidGraphifyOutputError("structured output has an invalid field set")
        raw_nodes = payload["nodes"]
        raw_edges = payload["edges"]
        if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
            raise InvalidGraphifyOutputError("structured nodes and edges must be lists")

        aliases: dict[str, str] = {}
        source_files: dict[str, str] = {}
        extraction_nodes: list[dict[str, Any]] = []
        for file in context.files:
            for alias in (file.uid, file.path):
                previous = aliases.get(alias)
                if previous is not None and previous != file.uid:
                    raise InvalidGraphifyOutputError(
                        "in-context File aliases must be unique"
                    )
                aliases[alias] = file.uid
            source_files[file.uid] = file.path
            extraction_nodes.append(
                {
                    "id": file.uid,
                    "label": file.path,
                    "file_type": "code",
                    "source_file": file.path,
                    "_origin": "ast",
                    "_sayre_label": "File",
                }
            )

        generated: dict[str, tuple[str, dict[str, Any]]] = {}
        for index, value in enumerate(raw_nodes):
            item = _record(
                value,
                f"nodes[{index}]",
                keys=frozenset({"id", "label", "properties"}),
            )
            local_id = _nonblank(item["id"], f"nodes[{index}].id")
            label = _nonblank(item["label"], f"nodes[{index}].label")
            if label not in ENRICHMENT_NODE_LABELS:
                raise InvalidGraphifyOutputError("generated node label is not allowed")
            if local_id in aliases or local_id in generated:
                raise InvalidGraphifyOutputError("generated node id must be unique")
            properties = (
                _feature_properties(item["properties"])
                if label == "Feature"
                else _env_step_properties(item["properties"])
            )
            uid = stable_uid(context.scope, label, local_id)
            aliases[local_id] = uid
            source_files[uid] = "__semantic__/generated.json"
            generated[uid] = (label, properties)
            extraction_nodes.append(
                {
                    "id": uid,
                    "label": properties.get("name", local_id),
                    "file_type": "concept",
                    "source_file": "__semantic__/generated.json",
                    "_sayre_label": label,
                    "_sayre_properties": properties,
                }
            )

        extraction_edges: list[dict[str, Any]] = []
        edge_keys: set[tuple[str, str]] = set()
        for index, value in enumerate(raw_edges):
            item = _record(
                value,
                f"edges[{index}]",
                keys=frozenset({"source", "target", "relationship"}),
            )
            source_ref = _nonblank(item["source"], f"edges[{index}].source")
            target_ref = _nonblank(item["target"], f"edges[{index}].target")
            relationship = _nonblank(
                item["relationship"], f"edges[{index}].relationship"
            )
            if relationship not in ENRICHMENT_EDGE_TYPES:
                raise InvalidGraphifyOutputError(
                    "generated edge relationship is not allowed"
                )
            try:
                source_uid = aliases[source_ref]
                target_uid = aliases[target_ref]
            except KeyError:
                raise InvalidGraphifyOutputError(
                    "generated edge references an unknown node"
                ) from None
            pair = (source_uid, target_uid)
            if pair in edge_keys:
                raise InvalidGraphifyOutputError(
                    "base Graphify requires one semantic edge per endpoint pair"
                )
            edge_keys.add(pair)
            extraction_edges.append(
                {
                    "source": source_uid,
                    "target": target_uid,
                    "relation": relationship,
                    "confidence": "EXTRACTED",
                    "source_file": source_files[source_uid],
                    "_sayre_relationship": relationship,
                }
            )

        graph = build_from_json(
            {"nodes": extraction_nodes, "edges": extraction_edges},
            directed=True,
        )
        if any(uid not in graph for uid in generated):
            raise InvalidGraphifyOutputError(
                "base Graphify did not preserve every generated node"
            )
        if graph.number_of_edges() != len(extraction_edges):
            raise InvalidGraphifyOutputError(
                "base Graphify did not preserve every generated edge"
            )

        nodes = tuple(
            EnrichmentNode(label=label, uid=uid, properties=dict(properties))
            for uid, (label, properties) in sorted(generated.items())
        )
        edges: list[EnrichmentEdge] = []
        for source_uid, target_uid, data in graph.edges(data=True):
            relationship = data.get("_sayre_relationship")
            if relationship not in ENRICHMENT_EDGE_TYPES:
                raise InvalidGraphifyOutputError(
                    "base Graphify returned an invalid relationship"
                )
            edges.append(
                EnrichmentEdge(
                    relationship=relationship,
                    source_uid=str(source_uid),
                    target_uid=str(target_uid),
                )
            )
        edges.sort(
            key=lambda edge: (
                edge.source_uid,
                edge.target_uid,
                edge.relationship,
            )
        )
        return EnrichmentWrite(scope=context.scope, nodes=nodes, edges=tuple(edges))


class FakeGraphifyAdapter:
    """Deterministic W2-05 placeholder retained for isolated tests."""

    def schema(self, context: EnrichmentContext) -> Mapping[str, Any]:
        del context
        return deepcopy(GRAPHIFY_OUTPUT_SCHEMA)

    async def shape(
        self,
        context: EnrichmentContext,
        generation: StructuredGenerationResponse,
    ) -> EnrichmentWrite:
        del generation
        feature_uid = stable_uid(context.scope, "Feature", "__skeleton__")
        nodes = (
            EnrichmentNode(
                label="Feature",
                uid=feature_uid,
                properties={
                    "name": "Unclassified",
                    "description": "<skeleton placeholder — replaced by W3-01>",
                    "team": None,
                },
            ),
        )
        edges = tuple(
            EnrichmentEdge(
                relationship="PART_OF",
                source_uid=file.uid,
                target_uid=feature_uid,
            )
            for file in context.files
        )
        return EnrichmentWrite(scope=context.scope, nodes=nodes, edges=edges)


class GraphifyAdapterFactory:
    def create(self) -> GraphifyAdapter:
        return BaseGraphifyAdapter()

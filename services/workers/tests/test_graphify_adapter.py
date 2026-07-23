from __future__ import annotations

from copy import deepcopy

import pytest

import sayre_workers.enrichment.graphify_adapter as graphify_module
from sayre_workers.enrichment.graphify_adapter import (
    BaseGraphifyAdapter,
    GRAPHIFY_OUTPUT_SCHEMA,
    InvalidGraphifyOutputError,
)
from sayre_workers.enrichment.models import EnrichmentContext, FileContext
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.ingestion.projection import stable_uid
from sayre_workers.model_provider import StructuredGenerationResponse

SHA = "a" * 40


def _context() -> EnrichmentContext:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    return EnrichmentContext(
        scope=scope,
        files=(
            FileContext(
                uid=stable_uid(scope, "File", "src/api.py"),
                path="src/api.py",
                language="python",
            ),
            FileContext(
                uid=stable_uid(scope, "File", "src/ui.tsx"),
                path="src/ui.tsx",
                language="typescript",
            ),
        ),
    )


def _fixture_payload() -> dict[str, object]:
    return {
        "nodes": [
            {
                "id": "authentication",
                "label": "Feature",
                "properties": {
                    "name": "Authentication",
                    "description": "Signs users in.",
                    "team": "Identity",
                },
            }
        ],
        "edges": [
            {
                "source": "src/api.py",
                "target": "authentication",
                "relationship": "PART_OF",
            },
            {
                "source": "src/ui.tsx",
                "target": "authentication",
                "relationship": "REFERENCES",
            },
        ],
    }


def test_schema_is_closed_to_semantic_graph_primitives() -> None:
    schema = BaseGraphifyAdapter().schema(_context())

    assert schema == GRAPHIFY_OUTPUT_SCHEMA
    assert schema is not GRAPHIFY_OUTPUT_SCHEMA
    assert schema["additionalProperties"] is False
    assert schema["properties"]["edges"]["items"]["properties"]["relationship"][
        "enum"
    ] == ["PART_OF", "REFERENCES", "REQUIRES"]


@pytest.mark.asyncio
async def test_base_graphify_shapes_valid_output_and_invokes_base_library(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[dict[str, object], bool]] = []
    real_build = graphify_module.build_from_json

    def recording_build(extraction: dict[str, object], *, directed: bool = False):
        calls.append((deepcopy(extraction), directed))
        return real_build(extraction, directed=directed)

    monkeypatch.setattr(graphify_module, "build_from_json", recording_build)
    context = _context()
    write = await BaseGraphifyAdapter().shape(
        context, StructuredGenerationResponse(data=_fixture_payload())
    )

    assert len(calls) == 1
    assert calls[0][1] is True
    assert write.scope == context.scope
    assert len(write.nodes) == 1
    assert write.nodes[0].uid == stable_uid(
        context.scope, "Feature", "authentication"
    )
    assert write.nodes[0].properties == {
        "name": "Authentication",
        "description": "Signs users in.",
        "team": "Identity",
    }
    assert {(edge.relationship, edge.source_uid, edge.target_uid) for edge in write.edges} == {
        (
            "PART_OF",
            context.files[0].uid,
            write.nodes[0].uid,
        ),
        (
            "REFERENCES",
            context.files[1].uid,
            write.nodes[0].uid,
        ),
    }


@pytest.mark.asyncio
async def test_base_graphify_output_is_stable_across_redelivery() -> None:
    adapter = BaseGraphifyAdapter()
    context = _context()
    response = StructuredGenerationResponse(data=_fixture_payload())

    first = await adapter.shape(context, response)
    second = await adapter.shape(context, response)

    assert first == second


@pytest.mark.asyncio
async def test_base_graphify_accepts_empty_graph_primitive_arrays() -> None:
    write = await BaseGraphifyAdapter().shape(
        _context(),
        StructuredGenerationResponse(data={"nodes": [], "edges": []}),
    )

    assert write.nodes == ()
    assert write.edges == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutate, message",
    [
        (
            lambda payload: payload.update({"org_id": "forged-org"}),
            "invalid field set",
        ),
        (
            lambda payload: payload["nodes"].append(
                {
                    "id": "authentication",
                    "label": "Feature",
                    "properties": {
                        "name": "Duplicate",
                        "description": "",
                        "team": None,
                    },
                }
            ),
            "unique",
        ),
        (
            lambda payload: payload["edges"][0].update({"source": "missing.py"}),
            "unknown node",
        ),
        (
            lambda payload: payload["nodes"][0].update({"label": "Function"}),
            "label is not allowed",
        ),
        (
            lambda payload: payload["edges"][0].update({"relationship": "CALLS"}),
            "relationship is not allowed",
        ),
        (
            lambda payload: payload["nodes"][0]["properties"].update(
                {"text": "free-form prose"}
            ),
            "invalid field set",
        ),
    ],
)
async def test_base_graphify_rejects_malformed_or_unsafe_output(
    mutate, message: str
) -> None:
    payload = _fixture_payload()
    mutate(payload)

    with pytest.raises(InvalidGraphifyOutputError, match=message):
        await BaseGraphifyAdapter().shape(
            _context(), StructuredGenerationResponse(data=payload)
        )


@pytest.mark.asyncio
async def test_base_graphify_rejects_multiple_relationships_on_same_endpoint_pair() -> None:
    payload = _fixture_payload()
    payload["edges"].append(
        {
            "source": "src/api.py",
            "target": "authentication",
            "relationship": "REFERENCES",
        }
    )

    with pytest.raises(InvalidGraphifyOutputError, match="one semantic edge"):
        await BaseGraphifyAdapter().shape(
            _context(), StructuredGenerationResponse(data=payload)
        )

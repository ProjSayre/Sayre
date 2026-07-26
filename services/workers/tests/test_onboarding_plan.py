from __future__ import annotations

import pytest

from sayre_workers.enrichment.models import (
    EnrichmentContext,
    EnrichmentEdge,
    EnrichmentNode,
    EnrichmentWrite,
    FileContext,
    InvalidEnrichmentWriteError,
)
from sayre_workers.enrichment.onboarding_plan import (
    ONBOARDING_OUTPUT_SCHEMA,
    build_onboarding_request,
    canonicalize_onboarding_write,
)
from sayre_workers.ingestion.models import GraphScope

SHA = "a" * 40
SCOPE = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)


def _step(uid: str, sequence: int, command: str = "printf ready") -> EnrichmentNode:
    return EnrichmentNode(
        label="EnvStep",
        uid=uid,
        properties={"sequence": sequence, "command": command},
    )


def test_schema_allows_only_bounded_env_steps_and_requires_edges() -> None:
    [node_schema] = [ONBOARDING_OUTPUT_SCHEMA["properties"]["nodes"]["items"]]
    assert node_schema["properties"]["label"] == {"type": "string", "const": "EnvStep"}
    assert ONBOARDING_OUTPUT_SCHEMA["properties"]["nodes"]["minItems"] == 1
    assert (
        ONBOARDING_OUTPUT_SCHEMA["properties"]["edges"]["items"]["properties"][
            "relationship"
        ]
        == {"type": "string", "const": "REQUIRES"}
    )


def test_canonicalize_orders_steps_and_dependencies() -> None:
    write = canonicalize_onboarding_write(
        EnrichmentWrite(
            scope=SCOPE,
            nodes=(_step("step-2", 1), _step("step-1", 0)),
            edges=(
                EnrichmentEdge(
                    relationship="REQUIRES",
                    source_uid="step-2",
                    target_uid="step-1",
                ),
            ),
        )
    )

    assert [node.uid for node in write.nodes] == ["step-1", "step-2"]
    assert [(edge.source_uid, edge.target_uid) for edge in write.edges] == [
        ("step-2", "step-1")
    ]


@pytest.mark.parametrize(
    "write",
    [
        EnrichmentWrite(scope=SCOPE),
        EnrichmentWrite(scope=SCOPE, nodes=(_step("a", 1),)),
        EnrichmentWrite(scope=SCOPE, nodes=(_step("a", 0), _step("b", 0))),
        EnrichmentWrite(
            scope=SCOPE,
            nodes=(_step("a", 0), _step("b", 1)),
            edges=(
                EnrichmentEdge(
                    relationship="REQUIRES", source_uid="a", target_uid="b"
                ),
            ),
        ),
        EnrichmentWrite(
            scope=SCOPE,
            nodes=(EnrichmentNode(label="Feature", uid="a", properties={}),),
        ),
    ],
)
def test_canonicalize_rejects_empty_gapped_duplicate_reverse_or_non_step_writes(
    write: EnrichmentWrite,
) -> None:
    with pytest.raises(InvalidEnrichmentWriteError):
        canonicalize_onboarding_write(write)


def test_generation_request_uses_bounded_graph_metadata_not_a_checkout() -> None:
    context = EnrichmentContext(
        scope=SCOPE,
        files=(
            FileContext(uid="a", path="package.json", language="json"),
            FileContext(uid="b", path="src/index.ts", language="typescript"),
        ),
    )

    request = build_onboarding_request(context)

    assert "package.json" in request.input
    assert "src/index.ts" in request.input
    assert "networkless" in request.system
    assert request.temperature == 0.0

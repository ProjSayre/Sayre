"""GAP-5 gap-fill: real `MessagingPublisher.graph_updated` envelope proof.

`.pipeline/gaps.json` marked GAP-5 `UNTESTED` (not `MISSING`): the behavior in
`sayre_workers/ingestion/events.py` already exists and is not modified by this
ticket (`events.py` is listed under spec.md's "Read-only reference (not modified)"),
but no test previously drove `MessagingPublisher.graph_updated` directly and
asserted the exact wire envelope it produces -- only the `FakePublisher` test double
in `tests/test_ingestion.py` and the lower-level `sns_client.publish_graph_updated`
transport (`tests/test_sns_client.py`) were ever exercised. This file is the literal
acceptance measurement gap-mode rule 2 calls for ("still write the new @spec test
that makes the measurement literal").

Only the transport (`publish_graph_updated`) is monkeypatched, exactly as
`tests/test_onboarding_priority.py:80-108` does for `publish` -- everything else
(`MessagingPublisher.graph_updated`, `graph_scope_key`, envelope construction) runs
for real.
"""

from __future__ import annotations

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion import events as ingestion_events
from sayre_workers.ingestion.events import MessagingPublisher, graph_scope_key
from sayre_workers.ingestion.models import GraphScope

SHA_A = "a" * 40


def _scope(revision_sha: str = SHA_A) -> GraphScope:
    return GraphScope(
        org_id="org-server-resolved",
        repository_id="repo-server-resolved",
        ref_name="refs/heads/main",
        revision_sha=revision_sha,
    )


@pytest.mark.asyncio
# @spec AC-7 EC-22 EC-23
async def test_graph_updated_envelope_matches_the_literal_acceptance_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[MessageEnvelope] = []
    monkeypatch.setattr(
        ingestion_events, "publish_graph_updated", lambda envelope: published.append(envelope)
    )
    scope = _scope()

    await MessagingPublisher().graph_updated(
        scope=scope,
        graph_version=7,
        full_rebuild=False,
        changed_paths=("src/a.py", "src/b.py"),
        structural_duration_ms=123.4,
        trace_id="trace-1",
    )

    [envelope] = published
    assert envelope.type == "graph.updated"
    assert envelope.source == "ingestion-worker"
    assert envelope.org_id == scope.org_id
    assert envelope.graph_scope_key == graph_scope_key(scope)
    assert envelope.graph_version == 7
    expected_scope_key = graph_scope_key(scope)
    assert envelope.idempotency_key == f"{expected_scope_key}:{scope.revision_sha}:graph.updated"

    # EC-22: no org_id key inside the fanned-out payload itself (tenant identity
    # belongs on the envelope only), matching the assertion
    # test_onboarding_priority.py already makes for onboarding.generate.
    assert "org_id" not in envelope.payload
    assert set(envelope.payload.keys()) == {
        "repository_id",
        "ref_name",
        "revision_sha",
        "full_rebuild",
        "changed_paths",
        "structural_duration_ms",
    }
    assert envelope.payload["repository_id"] == scope.repository_id
    assert envelope.payload["ref_name"] == scope.ref_name
    assert envelope.payload["revision_sha"] == scope.revision_sha
    assert envelope.payload["full_rebuild"] is False
    assert envelope.payload["changed_paths"] == ["src/a.py", "src/b.py"]
    assert isinstance(envelope.payload["changed_paths"], list)
    assert envelope.payload["structural_duration_ms"] == 123.4


@pytest.mark.asyncio
# @spec EC-23
async def test_graph_updated_idempotency_key_is_stable_across_two_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[MessageEnvelope] = []
    monkeypatch.setattr(
        ingestion_events, "publish_graph_updated", lambda envelope: published.append(envelope)
    )
    scope = _scope()

    await MessagingPublisher().graph_updated(
        scope=scope,
        graph_version=1,
        full_rebuild=True,
        changed_paths=(),
        structural_duration_ms=10.0,
        trace_id=None,
    )
    await MessagingPublisher().graph_updated(
        scope=scope,
        graph_version=1,
        full_rebuild=True,
        changed_paths=(),
        structural_duration_ms=99.9,
        trace_id=None,
    )

    first, second = published
    assert first.idempotency_key == second.idempotency_key
    assert first.message_id != second.message_id

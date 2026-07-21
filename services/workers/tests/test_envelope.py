"""Unit tests for the Python side of the shared MessageEnvelope wire contract.

Broker-independent — these do not touch SQS/LocalStack, so they always run and
give coverage even in a broker-less environment. Covers acceptance criterion 4
(org_id REQUIRED, rejected empty/missing) and the envelope-shape edge cases.

Imports use the qualified `workers.messaging.*` form (NOT bare `queue.*`) so the
`queue` name stays bound to the stdlib module for boto3/urllib3 — see Dev's
Deviation #1 in changes.md.
"""

import json
from datetime import datetime

import pytest
from pydantic import ValidationError

from workers.messaging.envelope import MessageEnvelope


def _valid_kwargs(**overrides):
    base = {"org_id": "org_ABC123", "type": "repo.ingest", "source": "ingestion-worker"}
    base.update(overrides)
    return base


def test_valid_envelope_fills_defaults():
    env = MessageEnvelope(**_valid_kwargs())
    assert env.org_id == "org_ABC123"
    assert env.type == "repo.ingest"
    assert env.source == "ingestion-worker"
    # defaults
    assert isinstance(env.message_id, str) and len(env.message_id) >= 32
    assert env.schema_version == 1
    assert isinstance(env.occurred_at, datetime)
    assert env.trace_id is None
    assert env.payload == {}
    assert env.idempotency_key == env.message_id
    assert env.graph_scope_key is None
    assert env.graph_version is None


def test_missing_org_id_rejected():
    with pytest.raises(ValidationError):
        MessageEnvelope(type="t", source="s")  # type: ignore[call-arg]


def test_empty_org_id_rejected():
    # AC4 / edge case: org_id present but empty string -> rejected (min_length=1).
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(org_id=""))


def test_missing_type_rejected():
    with pytest.raises(ValidationError):
        MessageEnvelope(org_id="o", source="s")  # type: ignore[call-arg]


def test_empty_type_rejected():
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(type=""))


def test_missing_source_rejected():
    with pytest.raises(ValidationError):
        MessageEnvelope(org_id="o", type="t")  # type: ignore[call-arg]


def test_empty_source_rejected():
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(source=""))


@pytest.mark.parametrize("field", ["message_id", "org_id", "type", "source"])
def test_whitespace_only_identity_fields_rejected(field):
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(**{field: "   "}))


def test_empty_payload_is_valid():
    # Edge case: empty payload {} is valid and round-trips.
    env = MessageEnvelope(**_valid_kwargs(payload={}))
    assert env.payload == {}


def test_extra_fields_forbidden():
    # ConfigDict(extra="forbid") — unknown keys must be rejected.
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(unexpected="nope"))


def test_wire_keys_are_snake_case():
    env = MessageEnvelope(**_valid_kwargs(trace_id="corr-1", payload={"k": "v"}))
    wire = json.loads(env.to_body())
    assert set(wire.keys()) == {
        "message_id",
        "org_id",
        "type",
        "schema_version",
        "occurred_at",
        "source",
        "trace_id",
        "payload",
        "idempotency_key",
    }
    # No camelCase drift on the wire.
    assert "orgId" not in wire


def test_to_body_from_body_roundtrip():
    env = MessageEnvelope(
        **_valid_kwargs(
            message_id="fixed-id",
            trace_id="corr-9",
            payload={"repo": "acme/widgets", "n": 3},
        )
    )
    restored = MessageEnvelope.from_body(env.to_body())
    assert restored.message_id == "fixed-id"
    assert restored.org_id == env.org_id
    assert restored.type == env.type
    assert restored.source == env.source
    assert restored.trace_id == "corr-9"
    assert restored.payload == {"repo": "acme/widgets", "n": 3}


def test_from_body_rejects_non_json():
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body("this is not json {")


def test_from_body_rejects_missing_org_id():
    body = json.dumps({"type": "t", "source": "s", "schema_version": 1, "payload": {}})
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body(body)


def test_from_body_rejects_empty_org_id():
    body = json.dumps(
        {
            "message_id": "m",
            "idempotency_key": "m",
            "org_id": "",
            "type": "t",
            "source": "s",
            "payload": {},
        }
    )
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body(body)


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_idempotency_key_rejected(value):
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(idempotency_key=value))


def test_wire_requires_serialized_idempotency_key():
    env = MessageEnvelope(**_valid_kwargs())
    body = json.loads(env.to_body())
    del body["idempotency_key"]
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body(json.dumps(body))


@pytest.mark.parametrize(
    ("scope", "version"),
    [("repo:1", None), (None, 1), ("", 1), ("repo:1", -1), ("repo:1", 1.5)],
)
def test_invalid_graph_version_pairs_rejected(scope, version):
    with pytest.raises(ValidationError):
        MessageEnvelope(
            **_valid_kwargs(graph_scope_key=scope, graph_version=version)
        )


def test_graph_updated_requires_scope_and_version():
    with pytest.raises(ValidationError):
        MessageEnvelope(**_valid_kwargs(type="graph.updated"))
    env = MessageEnvelope(
        **_valid_kwargs(
            type="graph.updated", graph_scope_key="org/repo/ref", graph_version=0
        )
    )
    assert env.graph_scope_key == "org/repo/ref"
    assert env.graph_version == 0
    wire = json.loads(env.to_body())
    assert wire["graph_scope_key"] == "org/repo/ref"
    assert wire["graph_version"] == 0


def test_wire_rejects_null_graph_metadata():
    env = MessageEnvelope(**_valid_kwargs())
    body = json.loads(env.to_body())
    body.update({"graph_scope_key": None, "graph_version": None})
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body(json.dumps(body))

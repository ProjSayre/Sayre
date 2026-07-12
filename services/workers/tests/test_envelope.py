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
    body = json.dumps({"org_id": "", "type": "t", "source": "s", "payload": {}})
    with pytest.raises(ValidationError):
        MessageEnvelope.from_body(body)

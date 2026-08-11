"""GAP-10 gap-fill: cross-language regression test for Core's committed
`repo.push` / branch-deletion envelope fixtures.

Mirrors `test_initial_parse_wire_fixture.py`'s existing pattern for
`repo_initial_parse.envelope.json`. Both fixture files this test loads --
`services/core/src/queue/__fixtures__/repo_push.envelope.json` and
`repo_push.branch-deletion.envelope.json` -- are pinned/committed by Core
(spec.md AC-4, Interfaces #6); they do not exist yet, so this file fails at
collection until `dev` creates them.
"""

from __future__ import annotations

import json
from pathlib import Path

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.models import IngestionJob, RefDeletionCommand, classify_ingestion_envelope

FIXTURES_DIR = (
    Path(__file__).resolve().parents[3] / "services" / "core" / "src" / "queue" / "__fixtures__"
)
PUSH_FIXTURE = FIXTURES_DIR / "repo_push.envelope.json"
DELETION_FIXTURE = FIXTURES_DIR / "repo_push.branch-deletion.envelope.json"


# @spec AC-4
def test_core_push_fixture_classifies_as_a_delta_ingestion_job() -> None:
    raw = PUSH_FIXTURE.read_text(encoding="utf-8")
    body = json.loads(raw)
    envelope = MessageEnvelope.from_body(raw)

    command = classify_ingestion_envelope(envelope)

    assert isinstance(command, IngestionJob)
    assert command.kind == "delta"
    assert command.org_id == body["org_id"]
    assert command.ref_name == body["payload"]["ref"]
    assert command.revision_sha == body["payload"]["payload"]["after"].lower()
    assert command.repository.installation_id == int(body["payload"]["installation_id"])


# @spec AC-4
def test_core_branch_deletion_fixture_classifies_as_a_ref_deletion_command() -> None:
    raw = DELETION_FIXTURE.read_text(encoding="utf-8")
    body = json.loads(raw)
    envelope = MessageEnvelope.from_body(raw)

    command = classify_ingestion_envelope(envelope)

    assert isinstance(command, RefDeletionCommand)
    assert command.org_id == body["org_id"]
    assert command.ref_name == body["payload"]["ref"]


# @spec EC-9
def test_committed_fixtures_are_byte_parseable_and_carry_no_secret_material() -> None:
    for path in (PUSH_FIXTURE, DELETION_FIXTURE):
        raw = path.read_text(encoding="utf-8")
        # Byte-parseable by MessageEnvelope.from_body (raises on malformed input).
        envelope = MessageEnvelope.from_body(raw)
        assert envelope.org_id == "22222222-2222-4222-8222-222222222222", (
            "the fixture tenant id must be the same synthetic UUID "
            "repo_initial_parse.envelope.json already uses"
        )

        lowered = raw.lower()
        for forbidden in ("installation_token", "clone_url", "credential", "x-access-token", "password"):
            assert forbidden not in lowered, f"fixture {path.name} leaks a forbidden token: {forbidden}"

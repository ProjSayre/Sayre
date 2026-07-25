"""Cross-language regression test for Core's committed initial-parse envelope."""

from pathlib import Path

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion import parse_ingestion_envelope


FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "services"
    / "core"
    / "src"
    / "queue"
    / "__fixtures__"
    / "repo_initial_parse.envelope.json"
)


def test_core_initial_parse_fixture_is_accepted_by_python_ingestion() -> None:
    envelope = MessageEnvelope.from_body(FIXTURE.read_text(encoding="utf-8"))
    job = parse_ingestion_envelope(envelope)

    assert job.kind == "initial"
    assert job.org_id == "22222222-2222-4222-8222-222222222222"
    assert job.ref_name == "refs/heads/main"
    assert job.revision_sha == "0123456789abcdef0123456789abcdef01234567"
    assert job.repository.installation_id == 555
    assert job.idempotency_key.endswith(job.revision_sha)

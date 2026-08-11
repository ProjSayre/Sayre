"""GAP-8/GAP-9 gap-fill: terminal classification for ingestion-queue messages this
worker deliberately does not parse.

Two cases must acknowledge (never raise, never redeliver into `ingestion-dlq.fifo`,
never head-of-line block the FIFO group): a `repo.branch` envelope (create/delete --
GAP-8), and a `repo.push` envelope that is actually a branch deletion (`deleted: true`
or an all-zero `after` -- GAP-9). Everything outside that enumerated allowlist must
still raise `InvalidIngestionJobError` (EC-2) -- this is not a blanket `except: pass`.
"""

from __future__ import annotations

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.models import (
    IgnoredIngestionMessage,
    InvalidIngestionJobError,
    RefDeletionCommand,
    RefState,
    classify_ingestion_envelope,
    parse_ingestion_envelope,
)
from tests.test_ingestion import FakeSnapshot, push_envelope, service_fixture

ORG_ID = "org-server-resolved"
SHA_A = "a" * 40
SHA_B = "b" * 40
ZERO_SHA = "0" * 40


def _branch_envelope(action: str, *, payload: dict | None = None) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=ORG_ID,
        type="repo.branch",
        source="github-webhook",
        idempotency_key=f"branch:{action}:1",
        payload=(
            payload
            if payload is not None
            else {
                "provider": "github",
                "repo": {"provider_repo_id": "583231", "full_name": "acme/widgets"},
                "ref": "refs/heads/feature-y",
                "installation_id": "555",
                "payload": {"action": action, "ref": "feature-y", "ref_type": "branch"},
            }
        ),
    )


def _deletion_push_envelope(
    *,
    after: str = ZERO_SHA,
    before: str | None = SHA_A,
    deleted: object = True,
    org_id: str = ORG_ID,
) -> MessageEnvelope:
    payload: dict[str, object] = {
        "org_id": "forged-org",
        "provider": "github",
        "repo": {"provider_repo_id": "583231", "full_name": "acme/widgets"},
        "ref": "refs/heads/feature-x",
        "installation_id": "555",
        "payload": {"before": before, "after": after, "deleted": deleted},
    }
    return MessageEnvelope(
        org_id=org_id,
        type="repo.push",
        source="github-webhook",
        idempotency_key=f"push:{after}:{before}",
        payload=payload,
    )


# ---------------------------------------------------------------------------
# AC-2 / EC-1 / EC-2: repo.branch terminal classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("action", ["created", "deleted"])
# @spec AC-2
def test_classify_repo_branch_is_an_ignored_message(action: str) -> None:
    command = classify_ingestion_envelope(_branch_envelope(action))

    assert isinstance(command, IgnoredIngestionMessage)
    assert command.message_type == "repo.branch"
    assert command.reason == "branch_lifecycle_event"


@pytest.mark.parametrize("payload", [{}, {"garbage": True}, {"action": None}])
# @spec EC-1
def test_classify_repo_branch_ignores_junk_or_empty_payload_without_raising(
    payload: dict,
) -> None:
    command = classify_ingestion_envelope(_branch_envelope("created", payload=payload))

    assert isinstance(command, IgnoredIngestionMessage)
    assert command.message_type == "repo.branch"


@pytest.mark.parametrize("event_type", ["repo.tag", "repo.pull_request", "graph.updated"])
# @spec EC-2
def test_classify_unknown_type_still_raises(event_type: str) -> None:
    extra: dict[str, object] = (
        {"graph_scope_key": "scope-key", "graph_version": 0} if event_type == "graph.updated" else {}
    )
    envelope = MessageEnvelope(
        org_id=ORG_ID,
        type=event_type,
        source="github-webhook",
        idempotency_key="x",
        payload={},
        **extra,
    )

    with pytest.raises(InvalidIngestionJobError, match="unsupported ingestion message type"):
        classify_ingestion_envelope(envelope)


@pytest.mark.asyncio
# @spec AC-2
async def test_handle_repo_branch_is_ignored_without_lock_or_checkout() -> None:
    snapshot = FakeSnapshot(revision=SHA_A, tracked=(), sources={})
    service, log, graph, chunks, publisher = service_fixture(snapshot)

    result = await service.handle(_branch_envelope("deleted"))

    assert result.status == "ignored"
    assert result.revision_sha == ""
    assert result.graph_version is None
    assert result.full_rebuild is False
    assert "state-locked" not in log
    assert "checkout" not in log
    assert graph.projections == []
    assert chunks.calls == []
    assert publisher.graph_events == []


# ---------------------------------------------------------------------------
# AC-3 / EC-3..EC-9: repo.push branch-deletion classification
# ---------------------------------------------------------------------------


# @spec AC-3
def test_classify_deleted_true_and_zero_after_both_yield_ref_deletion_command() -> None:
    deleted_true = classify_ingestion_envelope(
        _deletion_push_envelope(after=SHA_B, before=SHA_A, deleted=True)
    )
    zero_after = classify_ingestion_envelope(
        _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=False)
    )

    for command in (deleted_true, zero_after):
        assert isinstance(command, RefDeletionCommand)
        assert command.org_id == ORG_ID
        assert command.ref_name == "refs/heads/feature-x"
        assert command.repository.provider_repo_id == "583231"
    assert deleted_true.previous_revision_sha == SHA_A
    assert zero_after.previous_revision_sha == SHA_A


# @spec AC-3
def test_direct_parse_of_a_zero_after_push_raises() -> None:
    envelope = _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=False)

    with pytest.raises(InvalidIngestionJobError):
        parse_ingestion_envelope(envelope)


@pytest.mark.asyncio
# @spec AC-3
async def test_handle_ref_deletion_push_returns_without_lock_or_checkout() -> None:
    snapshot = FakeSnapshot(revision=SHA_A, tracked=(), sources={})
    service, log, graph, chunks, publisher = service_fixture(snapshot)

    result = await service.handle(
        _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=True)
    )

    assert result.status == "ref_deleted"
    assert result.graph_version is None
    assert result.full_rebuild is False
    assert "state-locked" not in log
    assert "checkout" not in log
    assert graph.projections == []


# @spec EC-3
def test_classify_all_zero_after_with_deleted_false_or_absent_is_still_ref_deletion() -> None:
    deleted_false = classify_ingestion_envelope(
        _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=False)
    )
    assert isinstance(deleted_false, RefDeletionCommand)

    envelope_no_deleted_key = _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=False)
    del envelope_no_deleted_key.payload["payload"]["deleted"]
    absent = classify_ingestion_envelope(envelope_no_deleted_key)
    assert isinstance(absent, RefDeletionCommand)


# @spec EC-4
def test_classify_deleted_true_with_nonzero_after_is_authoritative() -> None:
    command = classify_ingestion_envelope(
        _deletion_push_envelope(after=SHA_B, before=SHA_A, deleted=True)
    )
    assert isinstance(command, RefDeletionCommand)


@pytest.mark.parametrize("bad_value", ["true", 1, None])
# @spec EC-5
def test_classify_non_boolean_deleted_raises(bad_value: object) -> None:
    envelope = _deletion_push_envelope(after=SHA_B, before=SHA_A, deleted=bad_value)

    with pytest.raises(InvalidIngestionJobError):
        classify_ingestion_envelope(envelope)


# @spec EC-6
def test_classify_missing_or_zero_before_yields_none_previous_revision() -> None:
    absent_before = classify_ingestion_envelope(
        _deletion_push_envelope(after=ZERO_SHA, before=None, deleted=True)
    )
    zero_before = classify_ingestion_envelope(
        _deletion_push_envelope(after=ZERO_SHA, before=ZERO_SHA, deleted=True)
    )

    assert absent_before.previous_revision_sha is None
    assert zero_before.previous_revision_sha is None


@pytest.mark.asyncio
# @spec EC-7
async def test_fifo_group_recovers_after_terminal_ack() -> None:
    snapshot = FakeSnapshot(
        revision=SHA_B,
        tracked=("src/app.py",),
        sources={"src/app.py": b"def run():\n    return 1\n"},
        changed=("src/app.py",),
        ancestry={(SHA_A, SHA_B): True},
    )
    current = RefState("ref-from-postgres", SHA_A, 3)
    service, _log, graph, _chunks, _publisher = service_fixture(snapshot, current)

    ignored = await service.handle(_branch_envelope("deleted"))
    assert ignored.status == "ignored"

    # The regression this whole item exists to prevent: the SECOND, legitimate
    # message for the same (org_id, provider_repo_id, ref) FIFO group must still
    # process normally, not be silently stuck behind the first.
    result = await service.handle(push_envelope(SHA_B, before=SHA_A))
    assert result.status == "accepted"
    assert graph.projections


# @spec EC-8
def test_ref_deletion_command_org_id_ignores_forged_payload_org_id() -> None:
    command = classify_ingestion_envelope(
        _deletion_push_envelope(after=ZERO_SHA, before=SHA_A, deleted=True, org_id=ORG_ID)
    )

    assert command.org_id == ORG_ID
    assert command.org_id != "forged-org"

"""Network-free FIFO, single-delivery, heartbeat, and claim-fencing tests."""

from __future__ import annotations

import threading

import pytest

from workers.messaging.envelope import MessageEnvelope
from workers.messaging import sqs_client


class FakeStore:
    def __init__(self, status: str = "acquired", renew_result: bool = True) -> None:
        self.status = status
        self.renew_result = renew_result
        self.claims: list[tuple[str, str, str]] = []
        self.renewals = 0
        self.completions = 0
        self.releases = 0

    def claim(self, consumer_id, key, owner, _lease, **_kwargs):
        self.claims.append((consumer_id, key, owner))
        return self.status

    def renew(self, _consumer_id, _key, _owner, _lease):
        self.renewals += 1
        return self.renew_result

    def complete(self, _consumer_id, _key, _owner):
        self.completions += 1
        return True

    def release(self, _consumer_id, _key, _owner):
        self.releases += 1


class FakeSQS:
    def __init__(self, envelope: MessageEnvelope | None = None) -> None:
        self.envelope = envelope
        self.receives: list[dict[str, object]] = []
        self.sent: list[dict[str, object]] = []
        self.visibility_changes = 0
        self.deletes = 0
        self.fail_heartbeat = False

    def send_message(self, **kwargs):
        self.sent.append(kwargs)
        return {"MessageId": "sqs-message-1"}

    def receive_message(self, **kwargs):
        self.receives.append(kwargs)
        if self.envelope is None:
            return {}
        envelope = self.envelope
        self.envelope = None
        return {
            "Messages": [
                {
                    "MessageId": "broker-1",
                    "ReceiptHandle": "receipt-1",
                    "Body": envelope.to_body(),
                }
            ]
        }

    def change_message_visibility(self, **_kwargs):
        self.visibility_changes += 1
        if self.fail_heartbeat:
            raise RuntimeError("heartbeat unavailable")

    def delete_message(self, **_kwargs):
        self.deletes += 1


def _envelope() -> MessageEnvelope:
    return MessageEnvelope(
        message_id="message-1",
        idempotency_key="delivery-1",
        org_id="org-1",
        type="job",
        source="test",
    )


def test_fifo_publish_requires_group_and_defaults_deduplication(monkeypatch):
    fake = FakeSQS()
    monkeypatch.setattr(sqs_client, "get_queue_url", lambda _name: "queue-url")
    monkeypatch.setattr(sqs_client, "get_client", lambda: fake)
    with pytest.raises(ValueError):
        sqs_client.publish(sqs_client.INGESTION_QUEUE, _envelope())
    assert sqs_client.publish(
        sqs_client.INGESTION_QUEUE, _envelope(), message_group_id="group"
    ) == "sqs-message-1"
    assert fake.sent[0]["MessageGroupId"] == "group"
    assert fake.sent[0]["MessageDeduplicationId"] == "delivery-1"
    with pytest.raises(ValueError):
        sqs_client.publish("standard", _envelope(), message_group_id="group")


def test_consume_once_polls_exactly_one_and_completes_before_delete(monkeypatch):
    fake = FakeSQS(_envelope())
    store = FakeStore()
    monkeypatch.setattr(sqs_client, "get_queue_url", lambda _name: "queue-url")
    monkeypatch.setattr(sqs_client, "get_client", lambda: fake)
    handled: list[MessageEnvelope] = []
    assert (
        sqs_client.consume_once(
            sqs_client.EMBEDDING_UPSERTS_QUEUE,
            handled.append,
            consumer_id="embedding-upserts",
            delivery_store=store,
            visibility_timeout_seconds=1,
            heartbeat_interval_seconds=0.1,
        )
        == 1
    )
    assert fake.receives[0]["MaxNumberOfMessages"] == 1
    assert [envelope.message_id for envelope in handled] == ["message-1"]
    assert [envelope.idempotency_key for envelope in handled] == ["delivery-1"]
    assert store.completions == 1
    assert fake.deletes == 1


def test_completed_duplicate_is_deleted_without_handler(monkeypatch):
    fake = FakeSQS(_envelope())
    store = FakeStore(status="completed")
    monkeypatch.setattr(sqs_client, "get_queue_url", lambda _name: "queue-url")
    monkeypatch.setattr(sqs_client, "get_client", lambda: fake)
    def handler(_envelope):
        pytest.fail("completed duplicate reached handler")

    assert sqs_client.consume_once(
        sqs_client.EMBEDDING_UPSERTS_QUEUE,
        handler,
        consumer_id="embedding-upserts",
        delivery_store=store,
    ) == 1
    assert fake.deletes == 1


def test_heartbeat_failure_fences_completion_and_delete(monkeypatch):
    fake = FakeSQS(_envelope())
    fake.fail_heartbeat = True
    store = FakeStore()
    monkeypatch.setattr(sqs_client, "get_queue_url", lambda _name: "queue-url")
    monkeypatch.setattr(sqs_client, "get_client", lambda: fake)

    def handler(_envelope):
        threading.Event().wait(0.25)

    assert (
        sqs_client.consume_once(
            sqs_client.EMBEDDING_UPSERTS_QUEUE,
            handler,
            consumer_id="embedding-upserts",
            delivery_store=store,
            visibility_timeout_seconds=1,
            heartbeat_interval_seconds=0.1,
        )
        == 0
    )
    assert fake.visibility_changes >= 1
    assert store.completions == 0
    assert store.releases == 1
    assert fake.deletes == 0
    assert not any(thread.name.startswith("sqs-heartbeat-") for thread in threading.enumerate())


def test_production_queue_requires_store_before_receive(monkeypatch):
    monkeypatch.setattr(
        sqs_client,
        "get_client",
        lambda: pytest.fail("client should not be created without a durable store"),
    )
    with pytest.raises(ValueError, match="durable delivery_store"):
        sqs_client.consume_once(
            sqs_client.REALTIME_QUEUE,
            lambda _envelope: None,
            consumer_id="realtime",
        )


@pytest.mark.parametrize("interval", [float("nan"), float("inf"), True])
def test_invalid_heartbeat_interval_fails_before_receive(monkeypatch, interval):
    monkeypatch.setattr(
        sqs_client,
        "get_client",
        lambda: pytest.fail("invalid interval must fail before receiving"),
    )
    with pytest.raises(ValueError, match="heartbeat_interval_seconds"):
        sqs_client.consume_once(
            sqs_client.REALTIME_QUEUE,
            lambda _envelope: None,
            consumer_id="realtime",
            delivery_store=FakeStore(),
            heartbeat_interval_seconds=interval,
        )

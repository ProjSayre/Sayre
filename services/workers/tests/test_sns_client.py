"""Network-free SNS lifecycle, generation-cache, and publication tests."""

from __future__ import annotations

import asyncio
import json
import threading

import pytest

from sayre_workers.config import reset_secrets_for_tests
from workers.messaging import sns_client
from workers.messaging.envelope import MessageEnvelope


class FakeSNS:
    def __init__(self, arn: str = "arn:aws:sns:us-east-1:1:graph-updated") -> None:
        self.arn = arn
        self.closed = 0
        self.published: list[dict[str, str]] = []

    def close(self) -> None:
        self.closed += 1

    def list_topics(self, **_kwargs):
        return {"Topics": [{"TopicArn": self.arn}]}

    def publish(self, **kwargs):
        self.published.append(kwargs)
        return {"MessageId": "sns-message-1"}


@pytest.fixture(autouse=True)
def _configured_loader(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    monkeypatch.setenv("SNS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test-access")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    reset_secrets_for_tests()
    sns_client.close_client()
    yield
    sns_client.close_client()
    reset_secrets_for_tests()


@pytest.mark.asyncio
async def test_concurrent_initialization_constructs_one_client():
    fake = FakeSNS()
    calls = 0

    def factory(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return fake

    first, second = await asyncio.gather(
        sns_client.initialize_client(factory), sns_client.initialize_client(factory)
    )
    assert first is fake
    assert second is fake
    assert calls == 1


@pytest.mark.asyncio
async def test_failed_initialization_is_retryable():
    expected = RuntimeError("constructor failed")

    def failing(*_args, **_kwargs):
        raise expected

    with pytest.raises(RuntimeError) as exc_info:
        await sns_client.initialize_client(failing)
    assert exc_info.value is expected
    fake = FakeSNS()
    assert await sns_client.initialize_client(lambda *_args, **_kwargs: fake) is fake


def test_stale_topic_lookup_cannot_repopulate_cache_after_restart():
    entered = threading.Event()
    release = threading.Event()

    class BlockingSNS(FakeSNS):
        def list_topics(self, **_kwargs):
            entered.set()
            assert release.wait(5)
            return super().list_topics()

    old = BlockingSNS("arn:aws:sns:us-east-1:1:graph-updated")
    new = FakeSNS("arn:aws:sns:us-east-1:2:graph-updated")
    asyncio.run(sns_client.initialize_client(lambda *_args, **_kwargs: old))
    resolved: list[str] = []
    lookup = threading.Thread(target=lambda: resolved.append(sns_client.get_topic_arn()))
    lookup.start()
    assert entered.wait(2)
    sns_client.close_client()
    asyncio.run(sns_client.initialize_client(lambda *_args, **_kwargs: new))
    release.set()
    lookup.join(5)
    assert not lookup.is_alive()
    assert resolved == [new.arn]
    assert sns_client._topic_arn_cache == {
        sns_client.GRAPH_UPDATED_TOPIC: (sns_client._client_generation, new.arn)
    }


def test_publish_graph_updated_validates_and_sends_canonical_body_once():
    fake = FakeSNS()
    asyncio.run(sns_client.initialize_client(lambda *_args, **_kwargs: fake))
    envelope = MessageEnvelope(
        message_id="message-1",
        idempotency_key="delivery-1",
        org_id="org-1",
        type="graph.updated",
        source="ingestion-worker",
        graph_scope_key="org/repo/ref",
        graph_version=4,
        payload={"commit": "abc"},
    )
    assert sns_client.publish_graph_updated(envelope) == "sns-message-1"
    assert len(fake.published) == 1
    assert fake.published[0]["TopicArn"] == fake.arn
    assert json.loads(fake.published[0]["Message"]) == json.loads(envelope.to_body())

    with pytest.raises(ValueError):
        sns_client.publish_graph_updated(
            MessageEnvelope(org_id="org-1", type="other", source="test")
        )

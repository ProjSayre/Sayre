"""Broker-backed PRD-v5 SQS/SNS topology and consumer acceptance tests."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Callable

import boto3
import pytest
from botocore.config import Config

from sayre_workers.config import (
    MissingConfigError,
    get_bool_config,
    get_config,
    reset_secrets_for_tests,
)
from workers.messaging import sns_client, sqs_client
from workers.messaging.envelope import MessageEnvelope
from workers.messaging.idempotency import SqliteDeliveryStore
from workers.messaging.sns_client import publish_graph_updated
from workers.messaging.sqs_client import (
    DYNAMIC_COVERAGE_QUEUE,
    EMBEDDING_UPSERTS_QUEUE,
    ENRICHMENT_DEFAULT_QUEUE,
    ENRICHMENT_PRIORITY_QUEUE,
    INGESTION_QUEUE,
    REALTIME_QUEUE,
    consume_enrichment,
    consume_once,
    get_client,
    get_queue_url,
    ingestion_group_id,
    publish,
)


def _probe() -> bool:
    try:
        endpoint = get_config("SQS_ENDPOINT_URL")
    except MissingConfigError:
        endpoint = "http://localhost:4566"
    client = boto3.client(
        "sqs",
        endpoint_url=endpoint,
        region_name=get_config("AWS_REGION"),
        aws_access_key_id="localstack-test",
        aws_secret_access_key="localstack-test",
        config=Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 0}),
    )
    try:
        client.list_queues()
        return True
    except Exception:
        return False
    finally:
        client.close()


_BROKER_UP = _probe()
if not _BROKER_UP and get_bool_config("MESSAGING_INTEGRATION_REQUIRED"):
    raise RuntimeError("LocalStack SQS/SNS is required but unavailable.")

pytestmark = pytest.mark.skipif(not _BROKER_UP, reason="LocalStack SQS/SNS unavailable")


@pytest.fixture(scope="module", autouse=True)
def _localstack_config():
    patch = pytest.MonkeyPatch()
    patch.setenv("SAYRE_ENV", "test")
    patch.setenv("SQS_ENDPOINT_URL", "http://localhost:4566")
    patch.setenv("SNS_ENDPOINT_URL", "http://localhost:4566")
    patch.setenv("AWS_REGION", "us-east-1")
    patch.setenv("AWS_ACCESS_KEY_ID", "localstack-test")
    patch.setenv("AWS_SECRET_ACCESS_KEY", "localstack-test")
    reset_secrets_for_tests()
    sqs_client.close_client()
    sns_client.close_client()
    yield
    sqs_client.close_client()
    sns_client.close_client()
    reset_secrets_for_tests()
    patch.undo()


def _envelope(**overrides: object) -> MessageEnvelope:
    values: dict[str, object] = {
        "org_id": "org_messaging_test",
        "type": "test.job",
        "source": "messaging-test",
        "payload": {},
    }
    values.update(overrides)
    return MessageEnvelope.model_validate(values)


def _drain(queue_name: str) -> None:
    client = get_client()
    url = get_queue_url(queue_name)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        messages = client.receive_message(
            QueueUrl=url,
            WaitTimeSeconds=0,
            MaxNumberOfMessages=10,
            VisibilityTimeout=1,
        ).get("Messages", [])
        if not messages:
            return
        for message in messages:
            client.delete_message(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"])


def _poll(
    queue_name: str,
    handler: Callable[[MessageEnvelope], None],
    store: SqliteDeliveryStore,
    count: int,
    *,
    consumer_id: str,
    deadline_seconds: float = 10,
) -> None:
    acknowledged = 0
    deadline = time.monotonic() + deadline_seconds
    while acknowledged < count and time.monotonic() < deadline:
        acknowledged += consume_once(
            queue_name,
            handler,
            consumer_id=consumer_id,
            delivery_store=store,
            wait_seconds=1,
            visibility_timeout_seconds=5,
            heartbeat_interval_seconds=1,
        )
    assert acknowledged == count


def test_topology_has_typed_dlqs_restricted_fanout_and_distinct_queues():
    client = get_client()
    pairs = {
        INGESTION_QUEUE: "ingestion-dlq.fifo",
        REALTIME_QUEUE: "graph-updated-realtime-dlq",
        ENRICHMENT_DEFAULT_QUEUE: "enrichment-default-dlq",
        ENRICHMENT_PRIORITY_QUEUE: "enrichment-onboarding-priority-dlq",
        EMBEDDING_UPSERTS_QUEUE: "embedding-upserts-dlq",
    }
    urls = {name: get_queue_url(name) for name in pairs}
    assert len(set(urls.values())) == len(urls)

    for source_name, dlq_name in pairs.items():
        source_attrs = client.get_queue_attributes(
            QueueUrl=urls[source_name], AttributeNames=["All"]
        )["Attributes"]
        redrive = json.loads(source_attrs["RedrivePolicy"])
        assert redrive["maxReceiveCount"] == "5"

        dlq_url = client.get_queue_url(QueueName=dlq_name)["QueueUrl"]
        dlq_attrs = client.get_queue_attributes(
            QueueUrl=dlq_url,
            AttributeNames=["QueueArn", "MessageRetentionPeriod", "FifoQueue"],
        )["Attributes"]
        assert redrive["deadLetterTargetArn"] == dlq_attrs["QueueArn"]
        assert dlq_attrs["MessageRetentionPeriod"] == "1209600"
        source_fifo = source_attrs.get("FifoQueue") == "true"
        dlq_fifo = dlq_attrs.get("FifoQueue") == "true"
        assert source_fifo == source_name.endswith(".fifo")
        assert dlq_fifo == dlq_name.endswith(".fifo")
        assert source_fifo == dlq_fifo
        if source_name == INGESTION_QUEUE:
            assert source_attrs["ContentBasedDeduplication"] == "false"

    topic_arn = sns_client.get_topic_arn()
    subscriptions = sns_client.get_client().list_subscriptions_by_topic(TopicArn=topic_arn)[
        "Subscriptions"
    ]
    endpoints = {item["Endpoint"]: item["SubscriptionArn"] for item in subscriptions}
    for queue_name in (REALTIME_QUEUE, ENRICHMENT_DEFAULT_QUEUE):
        attrs = client.get_queue_attributes(
            QueueUrl=urls[queue_name], AttributeNames=["QueueArn", "Policy"]
        )["Attributes"]
        policy = json.loads(attrs["Policy"])
        statement = policy["Statement"][0]
        assert statement["Principal"] == {"Service": "sns.amazonaws.com"}
        assert statement["Condition"]["ArnEquals"]["aws:SourceArn"] == topic_arn
        subscription_arn = endpoints[attrs["QueueArn"]]
        subscription_attrs = sns_client.get_client().get_subscription_attributes(
            SubscriptionArn=subscription_arn
        )["Attributes"]
        assert subscription_attrs["RawMessageDelivery"] == "true"
    assert all(
        ENRICHMENT_PRIORITY_QUEUE not in endpoint and EMBEDDING_UPSERTS_QUEUE not in endpoint
        for endpoint in endpoints
    )


def test_fifo_grouping_and_per_group_order(tmp_path: Path):
    _drain(INGESTION_QUEUE)
    group_a = ingestion_group_id("org", "repo", "refs/heads/a")
    group_b = ingestion_group_id("org", "repo", "refs/heads/b")
    assert group_a != group_b
    with pytest.raises(ValueError):
        ingestion_group_id("org", " ", "ref")

    for sequence in range(3):
        for label, group in (("A", group_a), ("B", group_b)):
            envelope = _envelope(
                idempotency_key=f"fifo-{label}-{sequence}-{time.time_ns()}",
                payload={"group": label, "sequence": sequence},
            )
            publish(INGESTION_QUEUE, envelope, message_group_id=group)

    observed: dict[str, list[int]] = {"A": [], "B": []}
    with SqliteDeliveryStore(tmp_path / "fifo.sqlite3") as store:
        _poll(
            INGESTION_QUEUE,
            lambda envelope: observed[str(envelope.payload["group"])].append(
                int(envelope.payload["sequence"])
            ),
            store,
            6,
            consumer_id="ingestion-test",
        )
    assert observed == {"A": [0, 1, 2], "B": [0, 1, 2]}


def test_sns_fanout_processes_same_event_once_per_subscription(tmp_path: Path):
    _drain(REALTIME_QUEUE)
    _drain(ENRICHMENT_DEFAULT_QUEUE)
    envelope = _envelope(
        type="graph.updated",
        idempotency_key=f"graph-event-{time.time_ns()}",
        graph_scope_key="org/repo/ref",
        graph_version=7,
        payload={"commit": "abc123"},
    )
    assert publish_graph_updated(envelope)

    realtime: list[MessageEnvelope] = []
    enrichment: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "fanout.sqlite3") as store:
        _poll(REALTIME_QUEUE, realtime.append, store, 1, consumer_id="realtime")
        _poll(
            ENRICHMENT_DEFAULT_QUEUE,
            enrichment.append,
            store,
            1,
            consumer_id="enrichment",
        )
    assert realtime == [envelope]
    assert enrichment == [envelope]


def test_embedding_queue_roundtrip_is_physically_independent(tmp_path: Path):
    _drain(EMBEDDING_UPSERTS_QUEUE)
    envelope = _envelope(idempotency_key=f"embedding-{time.time_ns()}")
    publish(EMBEDDING_UPSERTS_QUEUE, envelope)
    received: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "embedding.sqlite3") as store:
        _poll(
            EMBEDDING_UPSERTS_QUEUE,
            received.append,
            store,
            1,
            consumer_id="embedding-upserts",
        )
    assert received == [envelope]
    assert get_queue_url(EMBEDDING_UPSERTS_QUEUE) not in {
        get_queue_url(INGESTION_QUEUE),
        get_queue_url(ENRICHMENT_DEFAULT_QUEUE),
        get_queue_url(ENRICHMENT_PRIORITY_QUEUE),
    }


def test_dynamic_coverage_queue_roundtrip_is_physically_independent(tmp_path: Path):
    """W4-03's nightly scheduler (scripts/schedule_dynamic_coverage.py) publishes here;
    sayre_workers.dynamic_coverage.consumers.run_coverage_consumer drains it. A
    separate physical queue from every other lane, same as embedding-upserts."""
    _drain(DYNAMIC_COVERAGE_QUEUE)
    envelope = _envelope(
        type="coverage.nightly",
        idempotency_key=f"coverage-nightly-{time.time_ns()}",
        graph_scope_key="org/repo/ref",
        graph_version=0,
        payload={
            "repository_id": "repo-1",
            "ref_name": "refs/heads/main",
            "revision_sha": "a" * 40,
            "changed_paths": ["src/app.py"],
            "parse_complete": True,
            "triggered_at": "2026-07-24T00:00:00+00:00",
        },
    )
    publish(DYNAMIC_COVERAGE_QUEUE, envelope)
    received: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "dynamic-coverage.sqlite3") as store:
        _poll(
            DYNAMIC_COVERAGE_QUEUE,
            received.append,
            store,
            1,
            consumer_id="dynamic-coverage-worker",
        )
    assert received == [envelope]
    assert get_queue_url(DYNAMIC_COVERAGE_QUEUE) not in {
        get_queue_url(INGESTION_QUEUE),
        get_queue_url(ENRICHMENT_DEFAULT_QUEUE),
        get_queue_url(ENRICHMENT_PRIORITY_QUEUE),
        get_queue_url(EMBEDDING_UPSERTS_QUEUE),
    }


def test_priority_only_leaves_default_lane_untouched(tmp_path: Path):
    _drain(ENRICHMENT_PRIORITY_QUEUE)
    _drain(ENRICHMENT_DEFAULT_QUEUE)
    priority = _envelope(idempotency_key=f"priority-{time.time_ns()}")
    default = _envelope(idempotency_key=f"default-{time.time_ns()}")
    publish(ENRICHMENT_PRIORITY_QUEUE, priority)
    publish(ENRICHMENT_DEFAULT_QUEUE, default)
    stop = threading.Event()
    received: list[MessageEnvelope] = []

    def handler(envelope: MessageEnvelope) -> None:
        received.append(envelope)
        stop.set()

    with SqliteDeliveryStore(tmp_path / "priority.sqlite3") as store:
        consume_enrichment(
            handler,
            consumer_id="enrichment",
            mode="priority_only",
            delivery_store=store,
            stop_event=stop,
            visibility_timeout_seconds=5,
        )
    assert received == [priority]
    raw = get_client().receive_message(
        QueueUrl=get_queue_url(ENRICHMENT_DEFAULT_QUEUE),
        WaitTimeSeconds=1,
        MaxNumberOfMessages=1,
    )["Messages"][0]
    assert MessageEnvelope.from_body(raw["Body"]) == default
    get_client().delete_message(
        QueueUrl=get_queue_url(ENRICHMENT_DEFAULT_QUEUE), ReceiptHandle=raw["ReceiptHandle"]
    )


def test_enrichment_deduplicates_same_key_across_physical_lanes(tmp_path: Path):
    _drain(ENRICHMENT_PRIORITY_QUEUE)
    _drain(ENRICHMENT_DEFAULT_QUEUE)
    key = f"cross-lane-{time.time_ns()}"
    priority = _envelope(idempotency_key=key, payload={"lane": "priority"})
    default = _envelope(idempotency_key=key, payload={"lane": "default"})
    publish(ENRICHMENT_PRIORITY_QUEUE, priority)
    publish(ENRICHMENT_DEFAULT_QUEUE, default)
    handled: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "cross-lane.sqlite3") as store:
        _poll(
            ENRICHMENT_PRIORITY_QUEUE,
            handled.append,
            store,
            1,
            consumer_id="enrichment",
        )
        _poll(
            ENRICHMENT_DEFAULT_QUEUE,
            handled.append,
            store,
            1,
            consumer_id="enrichment",
        )
    assert handled == [priority]


def test_weighted_lane_schedule_and_empty_lane_fallback(monkeypatch, tmp_path: Path):
    calls: list[str] = []
    stop = threading.Event()

    def always_nonempty(queue_name: str, *_args, **_kwargs) -> int:
        calls.append(queue_name)
        if len(calls) == 8:
            stop.set()
        return 1

    monkeypatch.setattr(sqs_client, "consume_once", always_nonempty)
    with SqliteDeliveryStore(tmp_path / "weighted.sqlite3") as store:
        consume_enrichment(
            lambda _envelope: None,
            consumer_id="enrichment",
            delivery_store=store,
            stop_event=stop,
        )
    assert calls == [
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_DEFAULT_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        ENRICHMENT_DEFAULT_QUEUE,
    ]

    calls.clear()
    stop.clear()

    def priority_empty(queue_name: str, *_args, **_kwargs) -> int:
        calls.append(queue_name)
        if queue_name == ENRICHMENT_DEFAULT_QUEUE:
            stop.set()
            return 1
        return 0

    monkeypatch.setattr(sqs_client, "consume_once", priority_empty)
    with SqliteDeliveryStore(tmp_path / "fallback.sqlite3") as store:
        consume_enrichment(
            lambda _envelope: None,
            consumer_id="enrichment",
            delivery_store=store,
            stop_event=stop,
        )
    assert calls == [ENRICHMENT_PRIORITY_QUEUE, ENRICHMENT_DEFAULT_QUEUE]


# @spec AC-5 EC-8 EC-9 EC-15
def test_priority_envelope_drains_ahead_of_default_backlog(tmp_path: Path):
    """W0-04's canonical acceptance clause, measured against the live broker.

    docs/product/Ticket-Backlog-by-Feature-2.md §W0-04: "a priority message demonstrably
    drains ahead of a backlog of default messages". Unlike
    test_weighted_lane_schedule_and_empty_lane_fallback above, this test NEVER
    monkeypatches consume_once — the drain order is observed off real LocalStack queues
    holding a real 20-message backlog, which is the whole point of the criterion.
    """
    _drain(ENRICHMENT_PRIORITY_QUEUE)
    _drain(ENRICHMENT_DEFAULT_QUEUE)
    run = time.time_ns()
    backlog = [
        _envelope(
            idempotency_key=f"backlog-{run}-{index}",
            payload={"lane": "default", "index": index},
        )
        for index in range(20)
    ]
    for envelope in backlog:
        publish(ENRICHMENT_DEFAULT_QUEUE, envelope)
    # EC-8: the priority message is published AFTER the entire default backlog, so a
    # pass cannot be an artifact of publish order.
    priority = _envelope(idempotency_key=f"priority-{run}", payload={"lane": "priority"})
    publish(ENRICHMENT_PRIORITY_QUEUE, priority)

    handled: list[str] = []
    default_visible_when_priority_handled: list[int] = []
    stop = threading.Event()
    watchdog = threading.Timer(60, stop.set)

    def handler(envelope: MessageEnvelope) -> None:
        key = envelope.idempotency_key
        assert key is not None
        handled.append(key)
        if key == priority.idempotency_key:
            attributes = get_client().get_queue_attributes(
                QueueUrl=get_queue_url(ENRICHMENT_DEFAULT_QUEUE),
                AttributeNames=["ApproximateNumberOfMessages"],
            )["Attributes"]
            default_visible_when_priority_handled.append(
                int(attributes["ApproximateNumberOfMessages"])
            )
        if len(handled) >= len(backlog) + 1:
            stop.set()

    watchdog.start()
    try:
        with SqliteDeliveryStore(tmp_path / "drain-ahead.sqlite3") as store:
            consume_enrichment(
                handler,
                consumer_id="enrichment-drain-ahead",
                mode="weighted",
                priority_weight=3,
                delivery_store=store,
                stop_event=stop,
                visibility_timeout_seconds=5,
            )
    finally:
        watchdog.cancel()

    assert priority.idempotency_key in handled, handled
    priority_index = handled.index(priority.idempotency_key)
    # AC-5: bounded by priority_weight (3) — O(1) in the size of the backlog, never
    # O(backlog). This is what "drains ahead" means under bounded weighted fairness.
    assert priority_index <= 3, handled[:5]
    assert priority_index < len(backlog), handled
    # ...and the backlog really was still there when the priority message was handled.
    assert default_visible_when_priority_handled, "priority envelope was never handled"
    assert default_visible_when_priority_handled[0] > 0
    # EC-9: weighted fairness must not starve the default lane — the backlog still
    # drains to zero within the same run.
    assert set(handled) == {envelope.idempotency_key for envelope in backlog} | {
        priority.idempotency_key
    }
    remaining = get_client().get_queue_attributes(
        QueueUrl=get_queue_url(ENRICHMENT_DEFAULT_QUEUE),
        AttributeNames=["ApproximateNumberOfMessages"],
    )["Attributes"]
    assert int(remaining["ApproximateNumberOfMessages"]) == 0


def test_visibility_heartbeat_blocks_competing_receive(tmp_path: Path):
    _drain(EMBEDDING_UPSERTS_QUEUE)
    envelope = _envelope(idempotency_key=f"heartbeat-{time.time_ns()}")
    publish(EMBEDDING_UPSERTS_QUEUE, envelope)
    started = threading.Event()
    release = threading.Event()
    store = SqliteDeliveryStore(tmp_path / "heartbeat.sqlite3")

    def handler(_envelope: MessageEnvelope) -> None:
        started.set()
        assert release.wait(4)

    result: list[int] = []
    consumer = threading.Thread(
        target=lambda: result.append(
            consume_once(
                EMBEDDING_UPSERTS_QUEUE,
                handler,
                consumer_id="embedding-upserts",
                delivery_store=store,
                visibility_timeout_seconds=1,
                heartbeat_interval_seconds=0.2,
            )
        )
    )
    consumer.start()
    assert started.wait(3)
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        competing = get_client().receive_message(
            QueueUrl=get_queue_url(EMBEDDING_UPSERTS_QUEUE),
            WaitTimeSeconds=0,
            MaxNumberOfMessages=1,
            VisibilityTimeout=1,
        ).get("Messages", [])
        assert competing == []
        threading.Event().wait(0.1)
    release.set()
    consumer.join(5)
    store.close()
    assert not consumer.is_alive()
    assert result == [1]
    assert not any(thread.name.startswith("sqs-heartbeat-") for thread in threading.enumerate())


def test_stop_after_receive_leaves_delivery_for_redelivery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A stop racing with receive must not invoke, claim, heartbeat, or acknowledge.

    SQS keeps the unacknowledged message invisible until its bounded visibility
    timeout, after which another consumer can receive it safely.
    """
    _drain(EMBEDDING_UPSERTS_QUEUE)
    envelope = _envelope(idempotency_key=f"stop-race-{time.time_ns()}")
    publish(EMBEDDING_UPSERTS_QUEUE, envelope)
    real_client = get_client()
    queue_url = get_queue_url(EMBEDDING_UPSERTS_QUEUE)
    stop = threading.Event()

    class StopAfterReceiveClient:
        def __init__(self) -> None:
            self.deletes = 0
            self.heartbeats = 0

        def receive_message(self, **kwargs):
            response = real_client.receive_message(**kwargs)
            if response.get("Messages"):
                stop.set()
            return response

        def delete_message(self, **kwargs):
            self.deletes += 1
            return real_client.delete_message(**kwargs)

        def change_message_visibility(self, **kwargs):
            self.heartbeats += 1
            return real_client.change_message_visibility(**kwargs)

    proxy = StopAfterReceiveClient()
    handled: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "stop-race.sqlite3") as store:
        with monkeypatch.context() as patcher:
            patcher.setattr(sqs_client, "get_queue_url", lambda _name: queue_url)
            patcher.setattr(sqs_client, "get_client", lambda: proxy)
            result = consume_once(
                EMBEDDING_UPSERTS_QUEUE,
                handled.append,
                consumer_id="embedding-upserts",
                delivery_store=store,
                stop_event=stop,
                visibility_timeout_seconds=1,
                heartbeat_interval_seconds=0.2,
            )

    assert result == 0
    assert handled == []
    assert proxy.deletes == 0
    assert proxy.heartbeats == 0
    assert not any(thread.name.startswith("sqs-heartbeat-") for thread in threading.enumerate())

    deadline = time.monotonic() + 5
    redelivery = None
    while redelivery is None and time.monotonic() < deadline:
        messages = real_client.receive_message(
            QueueUrl=queue_url,
            WaitTimeSeconds=1,
            MaxNumberOfMessages=1,
            VisibilityTimeout=1,
        ).get("Messages", [])
        if messages:
            redelivery = messages[0]
    assert redelivery is not None
    assert MessageEnvelope.from_body(redelivery["Body"]) == envelope
    real_client.delete_message(
        QueueUrl=queue_url, ReceiptHandle=redelivery["ReceiptHandle"]
    )


def test_poison_delivery_reaches_configured_dlq_after_five_receives():
    source_name = ENRICHMENT_PRIORITY_QUEUE
    dlq_name = "enrichment-onboarding-priority-dlq"
    _drain(source_name)
    _drain(dlq_name)
    client = get_client()
    source_url = get_queue_url(source_name)
    dlq_url = client.get_queue_url(QueueName=dlq_name)["QueueUrl"]
    marker = f"poison-{time.time_ns()}"
    client.send_message(QueueUrl=source_url, MessageBody=marker)

    for _ in range(5):
        deadline = time.monotonic() + 5
        delivery = None
        while delivery is None and time.monotonic() < deadline:
            messages = client.receive_message(
                QueueUrl=source_url,
                WaitTimeSeconds=1,
                MaxNumberOfMessages=1,
                VisibilityTimeout=1,
                AttributeNames=["ApproximateReceiveCount"],
            ).get("Messages", [])
            if messages:
                delivery = messages[0]
        assert delivery is not None
        client.change_message_visibility(
            QueueUrl=source_url,
            ReceiptHandle=delivery["ReceiptHandle"],
            VisibilityTimeout=0,
        )

    deadline = time.monotonic() + 10
    dead_letter = None
    while dead_letter is None and time.monotonic() < deadline:
        # Trigger redrive evaluation, then poll the DLQ by deadline.
        client.receive_message(
            QueueUrl=source_url,
            WaitTimeSeconds=0,
            MaxNumberOfMessages=1,
            VisibilityTimeout=0,
        )
        messages = client.receive_message(
            QueueUrl=dlq_url, WaitTimeSeconds=1, MaxNumberOfMessages=1
        ).get("Messages", [])
        if messages:
            dead_letter = messages[0]
    assert dead_letter is not None
    assert dead_letter["Body"] == marker
    client.delete_message(QueueUrl=dlq_url, ReceiptHandle=dead_letter["ReceiptHandle"])

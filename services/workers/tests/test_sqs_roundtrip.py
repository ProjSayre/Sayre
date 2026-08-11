"""SQS publish -> consume integration round-trip against LocalStack.

W0-04 (GAP-4a): this file is a same-language (Python -> Python) round-trip, NOT the
W0-04 cross-language acceptance proof. W0-04's canonical acceptance line is
docs/product/Ticket-Backlog-by-Feature-2.md §W0-04 ("cross-language test messages
consumed correctly; a priority message demonstrably drains ahead of a backlog of
default messages") — docs/backlog.md's shorter reword ("Python->Python SQS roundtrip
and Node->Node BullMQ roundtrip") is superseded. The actual cross-language evidence is
tests/test_cross_runtime_roundtrip.py. What remains here is real, valuable coverage in
its own right: the SQS edge cases from the spec — malformed / invalid-envelope messages
are skipped (not passed to the handler, not deleted) while the loop survives and later
valid messages still process; empty-queue consume; idempotent ensure_queue /
get_queue_url-on-missing-queue.

These are INTEGRATION tests: they require LocalStack SQS to be reachable at
SQS_ENDPOINT_URL. When the broker is unreachable the module skips during ordinary
local development; centrally configured required mode turns that into a hard failure.

Imports use the qualified `workers.messaging.*` form (see Dev Deviation #1). The
package was renamed from `queue/` to `messaging/` at the W0-04/W0-06 merge, so it no
longer shadows the stdlib `queue` module boto3/urllib3 need — PYTHONSAFEPATH is no
longer required.
"""

import functools
import json
import threading
from uuid import uuid4

import pytest

import boto3  # noqa: E402
from botocore.config import Config  # noqa: E402

from sayre_workers.config import (  # noqa: E402
    MissingConfigError,
    get_bool_config,
    get_config,
    reset_secrets_for_tests,
)
from workers.messaging import sqs_client  # noqa: E402
from workers.messaging.envelope import MessageEnvelope  # noqa: E402
from workers.messaging.sqs_client import (  # noqa: E402
    ENRICHMENT_QUEUE,
    INGESTION_QUEUE,
    SELFTEST_QUEUE,
    consume,
    ensure_queue,
    get_client,
    get_queue_url,
    publish,
)


@functools.lru_cache(maxsize=1)
def _broker_reachable() -> bool:
    """Short-timeout probe so a down broker skips quickly instead of hanging."""
    try:
        endpoint_url = get_config("SQS_ENDPOINT_URL")
    except MissingConfigError:
        endpoint_url = "http://localhost:4566"
    cfg = Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 0})
    client = boto3.client(
        "sqs",
        endpoint_url=endpoint_url,
        region_name=get_config("AWS_REGION"),
        aws_access_key_id="localstack-test",
        aws_secret_access_key="localstack-test",
        config=cfg,
    )
    try:
        client.list_queues()
        return True
    except Exception:
        return False


_BROKER_REACHABLE = _broker_reachable()
if not _BROKER_REACHABLE and get_bool_config("MESSAGING_INTEGRATION_REQUIRED"):
    raise RuntimeError("LocalStack SQS is required but unavailable.")

pytestmark = pytest.mark.skipif(
    not _BROKER_REACHABLE,
    reason=(
        "LocalStack SQS unreachable at "
        "http://localhost:4566 — skipping SQS integration round-trip"
    ),
)


@pytest.fixture(scope="module", autouse=True)
def _localstack_loader_config():
    """Configure the real loader through pytest's environment abstraction."""
    patch = pytest.MonkeyPatch()
    patch.setenv("SAYRE_ENV", "test")
    patch.setenv("SQS_ENDPOINT_URL", "http://localhost:4566")
    patch.setenv("AWS_REGION", "us-east-1")
    patch.setenv("AWS_ACCESS_KEY_ID", "localstack-test")
    patch.setenv("AWS_SECRET_ACCESS_KEY", "localstack-test")
    reset_secrets_for_tests()
    yield
    sqs_client.close_client()
    reset_secrets_for_tests()
    patch.undo()


def _make_env(**overrides) -> MessageEnvelope:
    base = {
        "org_id": "org_ABC123",
        "type": "repo.ingest",
        "source": "ingestion-worker",
        "payload": {"repo": "acme/widgets"},
    }
    base.update(overrides)
    return MessageEnvelope(**base)


def _consume_until(queue_name, predicate, *, timeout=15, visibility_timeout=30):
    """Run consume() in a background thread until `predicate(env)` is satisfied or
    timeout elapses. Returns (received_envelopes, matched_bool)."""
    received: list[MessageEnvelope] = []
    matched = threading.Event()
    stop = threading.Event()

    def handler(env: MessageEnvelope) -> None:
        received.append(env)
        if predicate(env):
            matched.set()
            stop.set()

    t = threading.Thread(
        target=consume,
        args=(queue_name, handler),
        kwargs={
            "consumer_id": "sqs-roundtrip-test",
            "wait_seconds": 1,
            "max_messages": 10,
            "visibility_timeout": visibility_timeout,
            "stop": stop,
        },
        daemon=True,
    )
    t.start()
    ok = matched.wait(timeout)
    stop.set()
    t.join(timeout=5)
    return received, ok


@pytest.fixture
def ephemeral_queue():
    """A fresh, uniquely-named queue that is deleted (and un-cached) afterwards, so
    each edge-case test is isolated from leftover messages / other tests."""
    name = f"w004-test-{uuid4().hex[:12]}"
    url = ensure_queue(name)
    yield name, url
    try:
        get_client().delete_queue(QueueUrl=url)
    except Exception:
        pass
    with sqs_client._queue_url_lock:
        sqs_client._queue_url_cache.pop(name, None)


# --- Same-language publish -> consume round-trip (see module docstring) -----


def test_selftest_queue_roundtrip():
    """AC1: publish(SELFTEST_QUEUE, env) is received by consume(SELFTEST_QUEUE, ...)
    and the handler observes the same org_id / type / payload."""
    env = _make_env(
        org_id="org_selftest_1",
        type="repo.ingest",
        payload={"repo": "acme/widgets", "sha": "deadbeef"},
    )
    ensure_queue(SELFTEST_QUEUE)
    publish(SELFTEST_QUEUE, env)

    received, matched = _consume_until(
        SELFTEST_QUEUE, lambda e: e.message_id == env.message_id
    )
    assert matched, "consume did not receive the published message within timeout"
    got = next(e for e in received if e.message_id == env.message_id)
    assert got.org_id == "org_selftest_1"
    assert got.type == "repo.ingest"
    assert got.payload == {"repo": "acme/widgets", "sha": "deadbeef"}


def test_empty_payload_roundtrips(ephemeral_queue):
    name, _ = ephemeral_queue
    env = _make_env(org_id="org_empty", payload={})
    publish(name, env)
    received, matched = _consume_until(name, lambda e: e.message_id == env.message_id)
    assert matched
    got = next(e for e in received if e.message_id == env.message_id)
    assert got.payload == {}
    assert got.org_id == "org_empty"


def test_publish_returns_sqs_message_id(ephemeral_queue):
    name, _ = ephemeral_queue
    msg_id = publish(name, _make_env())
    assert isinstance(msg_id, str) and msg_id


# --- Malformed / invalid input: skipped, not deleted, loop survives ----------


def test_malformed_and_invalid_messages_skipped_valid_still_processes(ephemeral_queue):
    """Edge case: a non-JSON body and a JSON-but-missing-org_id body must both be
    skipped (never reach the handler, not delete), yet a subsequent well-formed
    message still processes on the same running loop (loop must not crash)."""
    name, url = ephemeral_queue
    client = get_client()

    # 1) raw non-JSON body (ValueError path)
    client.send_message(QueueUrl=url, MessageBody="this is <not> json {")
    # 2) valid JSON but fails envelope validation — no org_id (ValidationError path)
    client.send_message(
        QueueUrl=url,
        MessageBody=json.dumps({"type": "t", "source": "s", "payload": {}}),
    )
    # 3) a good message that MUST still process
    good = _make_env(org_id="org_after_bad", payload={"ok": True})
    publish(name, good)

    received, matched = _consume_until(
        name, lambda e: e.message_id == good.message_id, timeout=15
    )
    assert matched, "the well-formed message after malformed ones was never processed"
    # The handler must only ever have seen the good message; the two bad bodies
    # never reach it.
    assert [e.message_id for e in received] == [good.message_id]
    assert received[0].org_id == "org_after_bad"


def test_invalid_message_is_not_deleted(ephemeral_queue):
    """A message that fails envelope validation is left on the queue (redelivers
    after the visibility timeout) — the wrapper must NOT delete it. This deliberately
    ephemeral test queue has no DLQ; every provisioned production queue does."""
    name, url = ephemeral_queue
    client = get_client()
    client.send_message(
        QueueUrl=url, MessageBody=json.dumps({"type": "t", "source": "s"})
    )

    # No valid message -> predicate never matches -> times out; short visibility
    # timeout so we can observe the message is still present afterwards.
    received, matched = _consume_until(
        name, lambda e: True, timeout=4, visibility_timeout=1
    )
    assert not matched
    assert received == [], "an invalid-envelope message must never reach the handler"

    attrs = client.get_queue_attributes(
        QueueUrl=url,
        AttributeNames=[
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
        ],
    )["Attributes"]
    total = int(attrs["ApproximateNumberOfMessages"]) + int(
        attrs["ApproximateNumberOfMessagesNotVisible"]
    )
    assert total >= 1, "invalid message was deleted but should have been retained"


# --- Handler exception: at-least-once redelivery -----------------------------


def test_handler_exception_leaves_message_for_redelivery(ephemeral_queue):
    """Edge case (concurrent/partial failure): when the handler raises mid-
    processing, the message is NOT deleted (at-least-once redelivery) and the
    consume loop does not crash — it keeps polling."""
    name, url = ephemeral_queue
    env = _make_env(org_id="org_handler_raises")
    publish(name, env)

    calls: list[str] = []
    stop = threading.Event()

    def raising_handler(e: MessageEnvelope) -> None:
        calls.append(e.message_id)
        stop.set()  # stop after the first delivery so the test is bounded
        raise RuntimeError("boom in business logic")

    t = threading.Thread(
        target=consume,
        args=(name, raising_handler),
        kwargs={
            "consumer_id": "sqs-roundtrip-test",
            "wait_seconds": 1,
            "visibility_timeout": 1,
            "stop": stop,
        },
        daemon=True,
    )
    t.start()
    t.join(timeout=10)
    assert not t.is_alive(), "consume loop did not exit / crashed after handler raised"
    assert calls, "handler was never invoked"

    # Message must still be present (not deleted) — in-flight or visible again.
    attrs = get_client().get_queue_attributes(
        QueueUrl=url,
        AttributeNames=[
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
        ],
    )["Attributes"]
    total = int(attrs["ApproximateNumberOfMessages"]) + int(
        attrs["ApproximateNumberOfMessagesNotVisible"]
    )
    assert total >= 1, "message was deleted despite handler raising"


# --- Empty queue -------------------------------------------------------------


def test_consume_empty_queue_calls_no_handler_and_stops(ephemeral_queue):
    """Long-poll an empty queue: the handler is never called, and consume returns
    promptly once `stop` is set."""
    name, _ = ephemeral_queue
    received, matched = _consume_until(name, lambda e: True, timeout=3)
    assert not matched
    assert received == []


# --- Structural: ingestion / enrichment are separate physical queues ---------


def test_ingestion_and_enrichment_are_distinct_queues():
    """FIFO ingestion and default enrichment are distinct provisioned SQS queues so
    structural sync never blocks on LLM enrichment. Names are per-work-type, not
    per-tenant (AC12) — no org_id anywhere in the queue name."""
    assert INGESTION_QUEUE == "ingestion.fifo"
    assert ENRICHMENT_QUEUE == "enrichment-default"
    assert INGESTION_QUEUE != ENRICHMENT_QUEUE
    ingestion_url = get_queue_url(INGESTION_QUEUE)
    enrichment_url = get_queue_url(ENRICHMENT_QUEUE)
    assert ingestion_url != enrichment_url
    # Per-work-type, not per-tenant: no org id embedded in the queue names.
    assert "org" not in ingestion_url.rsplit("/", 1)[-1]
    assert "org" not in enrichment_url.rsplit("/", 1)[-1]


# --- Queue-URL resolution / idempotent ensure_queue --------------------------


def test_get_queue_url_missing_raises_then_ensure_queue_is_idempotent():
    client = get_client()
    name = f"w004-missing-{uuid4().hex[:12]}"

    # get_queue_url on a queue that does not exist -> QueueDoesNotExist.
    with pytest.raises(client.exceptions.QueueDoesNotExist):
        get_queue_url(name)

    try:
        # ensure_queue creates it and is safe to call repeatedly (idempotent).
        url1 = ensure_queue(name)
        url2 = ensure_queue(name)
        assert url1 == url2
        # now it resolves.
        assert get_queue_url(name) == url1
    finally:
        try:
            client.delete_queue(QueueUrl=ensure_queue(name))
        except Exception:
            pass
        with sqs_client._queue_url_lock:
            sqs_client._queue_url_cache.pop(name, None)

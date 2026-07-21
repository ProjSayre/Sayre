"""SQS publish/consume wrapper for the Python worker fleet.

Permanent split (`.claude/rules/async-messaging.md`): SQS backs the Python worker
fleet; BullMQ backs Node integration workers. Do not add a BullMQ/Redis client here —
the Node-side equivalent lives at `services/core/src/queue/bullmq.ts`.

Baseline queues are per-work-type, NOT per-tenant — tenant context lives in the
envelope's `org_id` field, never in the queue name (`.claude/rules/security-multitenancy.md`).
`ingestion` and `enrichment` are deliberately separate queues so structural sync never
blocks on LLM enrichment latency.

Webhook-trust invariant: callers that originate from a webhook MUST HMAC/signature-
validate the payload and resolve `org_id` server-side (from the installation/account ->
org mapping in Postgres) BEFORE calling `publish()`. Never copy `org_id` from webhook
body input. This module enforces the envelope shape (org_id required); it does not
implement webhook receivers (out of scope for this ticket).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import threading
from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Mapping
from uuid import uuid4

import boto3
from pydantic import ValidationError
from sayre_workers.config import MissingConfigError, SecretNotFoundError, get_config, get_secret

from .envelope import MessageEnvelope
from .idempotency import DeliveryStore

logger = logging.getLogger(__name__)

# Canonical physical queues (per-work-type, NOT per-tenant).
INGESTION_QUEUE = "ingestion.fifo"
REALTIME_QUEUE = "graph-updated-realtime"
ENRICHMENT_DEFAULT_QUEUE = "enrichment-default"
ENRICHMENT_PRIORITY_QUEUE = "enrichment-onboarding-priority"
EMBEDDING_UPSERTS_QUEUE = "embedding-upserts"
SELFTEST_QUEUE = "w0-04-selftest"  # used only by the round-trip integration test

# Source-compatible aliases for the pre-v5 wrapper surface.
ENRICHMENT_QUEUE = ENRICHMENT_DEFAULT_QUEUE
GRAPH_EVENTS_QUEUE = REALTIME_QUEUE

_PRODUCTION_QUEUES = frozenset(
    {
        INGESTION_QUEUE,
        REALTIME_QUEUE,
        ENRICHMENT_DEFAULT_QUEUE,
        ENRICHMENT_PRIORITY_QUEUE,
        EMBEDDING_UPSERTS_QUEUE,
    }
)

_client_lock = threading.Lock()
_client = None
_client_generation = 0
_client_pending: dict[int, Future[Any]] = {}

_queue_url_lock = threading.Lock()
_queue_url_cache: dict[str, tuple[int, str]] = {}


class SQSClientInitializationCancelledError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("SQS client initialization was cancelled by shutdown.")


class SQSClientCloseError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("SQS client close failed.")


async def _optional_secret(ref: str) -> str | None:
    try:
        return await get_secret(ref)
    except SecretNotFoundError:
        return None


async def _await_pending_initialization(pending: Future[Any]):
    return await asyncio.shield(asyncio.wrap_future(pending))


def _remove_pending_if_current(generation: int, pending: Future[Any]) -> None:
    if _client_pending.get(generation) is pending:
        _client_pending.pop(generation, None)


def _complete_failed_initialization(
    generation: int,
    pending: Future[Any],
    error: Exception,
) -> bool:
    """Publish one failure to waiters; return whether shutdown won the race."""
    with _client_lock:
        cancelled = generation != _client_generation or pending.done()
        _remove_pending_if_current(generation, pending)
        if not pending.done():
            pending.set_exception(
                SQSClientInitializationCancelledError() if cancelled else error
            )
        return cancelled


def _abandon_cancelled_initialization(generation: int, pending: Future[Any]) -> None:
    with _client_lock:
        _remove_pending_if_current(generation, pending)
        if not pending.done():
            pending.cancel()


def _close_client_instance(client: Any, *, suppress_errors: bool = False) -> None:
    failed = False
    try:
        close = getattr(client, "close", None)
        if callable(close):
            close()
    except Exception:
        failed = True
    if failed and not suppress_errors:
        raise SQSClientCloseError from None


async def _close_candidate_after_owner_cancellation(
    construction: asyncio.Task[Any],
) -> None:
    """Wait out an uninterruptible thread constructor and close its late result."""
    while True:
        try:
            candidate = await asyncio.shield(construction)
            break
        except asyncio.CancelledError:
            if construction.done():
                try:
                    candidate = construction.result()
                except BaseException:
                    return
                break
            continue
        except BaseException:
            return
    _close_client_instance(candidate, suppress_errors=True)


async def initialize_client(
    client_factory: Callable[..., Any] | None = None,
):
    """Resolve configuration and credentials before constructing the SQS client.

    Explicit environment credentials are optional because production may use an IAM
    role. When present, access key and secret key must be provisioned together.
    """
    global _client
    if client_factory is not None and get_config("SAYRE_ENV") != "test":
        raise RuntimeError("SQS client factory injection is unavailable outside tests.")

    with _client_lock:
        if _client is not None:
            return _client
        generation = _client_generation
        pending = _client_pending.get(generation)
        owns_initialization = pending is None
        if pending is None:
            pending = Future()
            _client_pending[generation] = pending

    if not owns_initialization:
        return await _await_pending_initialization(pending)

    try:
        try:
            endpoint_url: str | None = get_config("SQS_ENDPOINT_URL")
        except MissingConfigError:
            endpoint_url = None
        region = get_config("AWS_REGION")
        access_key, secret_key, session_token = await asyncio.gather(
            _optional_secret("env://AWS_ACCESS_KEY_ID"),
            _optional_secret("env://AWS_SECRET_ACCESS_KEY"),
            _optional_secret("env://AWS_SESSION_TOKEN"),
        )
        if (access_key is None) != (secret_key is None):
            raise RuntimeError("AWS access-key credentials must be provisioned as a complete pair.")
        if session_token is not None and access_key is None:
            raise RuntimeError("AWS session credentials require an access-key credential pair.")
    except asyncio.CancelledError:
        _abandon_cancelled_initialization(generation, pending)
        raise
    except Exception as error:
        if _complete_failed_initialization(generation, pending, error):
            raise SQSClientInitializationCancelledError from None
        raise

    with _client_lock:
        cancelled = generation != _client_generation or pending.done()
        if cancelled:
            _remove_pending_if_current(generation, pending)
    if cancelled:
        raise SQSClientInitializationCancelledError

    factory = client_factory or boto3.client
    construction = asyncio.create_task(
        asyncio.to_thread(
            factory,
            "sqs",
            endpoint_url=endpoint_url,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            aws_session_token=session_token,
        )
    )
    try:
        candidate = await asyncio.shield(construction)
    except asyncio.CancelledError:
        _abandon_cancelled_initialization(generation, pending)
        await _close_candidate_after_owner_cancellation(construction)
        raise
    except Exception as error:
        if _complete_failed_initialization(generation, pending, error):
            raise SQSClientInitializationCancelledError from None
        raise

    with _client_lock:
        publish = (
            generation == _client_generation
            and _client_pending.get(generation) is pending
            and not pending.done()
            and _client is None
        )
        if publish:
            _client = candidate
            _client_pending.pop(generation, None)
            pending.set_result(candidate)
        else:
            _remove_pending_if_current(generation, pending)

    if publish:
        return candidate

    try:
        _close_client_instance(candidate, suppress_errors=True)
    finally:
        raise SQSClientInitializationCancelledError from None


def close_client() -> None:
    """Cancel in-flight initialization and close/detach the production client."""
    global _client, _client_generation
    with _client_lock:
        _client_generation += 1
        client = _client
        _client = None
        pending_initializations = list(_client_pending.values())
        _client_pending.clear()
        for pending in pending_initializations:
            if not pending.done():
                pending.set_exception(SQSClientInitializationCancelledError())
        with _queue_url_lock:
            _queue_url_cache.clear()
    _close_client_instance(client)


def get_client():
    """Cached boto3 SQS client.

    `endpoint_url` comes from `SQS_ENDPOINT_URL` (LocalStack locally; unset targets
    real AWS SQS in prod). Region from `AWS_REGION` (default `us-east-1`). Credentials
    are resolved through the central loader when explicitly provisioned; otherwise
    boto3 may use workload identity from its standard provider chain.
    """
    if _client is not None:
        return _client
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(initialize_client())
    raise RuntimeError(
        "SQS client is not initialized; await initialize_client() before using "
        "the synchronous queue wrapper from an async service."
    )


def _bind_client_and_cached_queue_url(queue_name: str) -> tuple[Any, int, str | None]:
    """Atomically bind a queue operation to the current client generation."""
    while True:
        client = get_client()
        with _client_lock:
            if client is not _client or client is None:
                continue
            generation = _client_generation
            with _queue_url_lock:
                cached = _queue_url_cache.get(queue_name)
                if cached is not None and cached[0] == generation:
                    return client, generation, cached[1]
            return client, generation, None


def _cache_queue_url_if_current(
    queue_name: str,
    queue_url: str,
    client: Any,
    generation: int,
) -> bool:
    """Cache only when the RPC's client/generation is still current."""
    with _client_lock:
        if generation != _client_generation or client is not _client:
            return False
        with _queue_url_lock:
            _queue_url_cache[queue_name] = (generation, queue_url)
        return True


def _client_binding_is_current(client: Any, generation: int) -> bool:
    with _client_lock:
        return generation == _client_generation and client is _client


def ensure_queue(queue_name: str) -> str:
    """Test-only idempotent queue creation helper.

    Production callers use ``get_queue_url`` and fail visibly if checked-in
    provisioning has not created the canonical queue with its DLQ/policy.
    """
    if queue_name in _PRODUCTION_QUEUES:
        return get_queue_url(queue_name)
    while True:
        client, generation, _ = _bind_client_and_cached_queue_url(queue_name)
        try:
            create_args: dict[str, Any] = {"QueueName": queue_name}
            if queue_name.endswith(".fifo"):
                create_args["Attributes"] = {
                    "FifoQueue": "true",
                    "ContentBasedDeduplication": "false",
                }
            response = client.create_queue(**create_args)
        except Exception:
            if _client_binding_is_current(client, generation):
                raise
            continue
        queue_url = response["QueueUrl"]
        if _cache_queue_url_if_current(queue_name, queue_url, client, generation):
            return queue_url


def get_queue_url(queue_name: str) -> str:
    """Resolve (and cache) a queue's URL. Raises the boto3 `QueueDoesNotExist` error
    if the queue has not been provisioned. Call `ensure_queue` first if the caller
    wants idempotent auto-creation instead."""
    while True:
        client, generation, cached = _bind_client_and_cached_queue_url(queue_name)
        if cached is not None:
            return cached
        try:
            response = client.get_queue_url(QueueName=queue_name)
        except Exception:
            if _client_binding_is_current(client, generation):
                raise
            continue
        queue_url = response["QueueUrl"]
        if _cache_queue_url_if_current(queue_name, queue_url, client, generation):
            return queue_url


def ingestion_group_id(org_id: str, repo_id: str, ref_name: str) -> str:
    """Hash an unambiguous length-prefixed org/repo/ref tuple for FIFO grouping."""
    components = (org_id, repo_id, ref_name)
    encoded = bytearray()
    for name, component in zip(("org_id", "repo_id", "ref_name"), components, strict=True):
        if not isinstance(component, str) or not component.strip():
            raise ValueError(f"{name} must not be blank")
        part = component.encode("utf-8")
        encoded.extend(len(part).to_bytes(8, "big"))
        encoded.extend(part)
    return hashlib.sha256(encoded).hexdigest()


def _validated_envelope(
    payload: MessageEnvelope | Mapping[str, object],
) -> MessageEnvelope:
    if isinstance(payload, MessageEnvelope):
        return payload
    return MessageEnvelope.model_validate(payload)


def publish(
    queue_name: str,
    payload: MessageEnvelope | Mapping[str, object],
    *,
    message_group_id: str | None = None,
    deduplication_id: str | None = None,
) -> str:
    """Validate an envelope and publish only to an already-provisioned queue."""
    message = _validated_envelope(payload)
    is_fifo = queue_name.endswith(".fifo")
    if is_fifo:
        if message_group_id is None or not message_group_id.strip():
            raise ValueError("message_group_id is required for FIFO queues")
        if deduplication_id is not None and not deduplication_id.strip():
            raise ValueError("deduplication_id must not be blank")
    elif message_group_id is not None or deduplication_id is not None:
        raise ValueError("FIFO publishing arguments are invalid for a standard queue")

    queue_url = get_queue_url(queue_name)
    client = get_client()
    send_args: dict[str, Any] = {"QueueUrl": queue_url, "MessageBody": message.to_body()}
    if is_fifo:
        send_args["MessageGroupId"] = message_group_id
        send_args["MessageDeduplicationId"] = deduplication_id or message.idempotency_key
    response = client.send_message(**send_args)
    return response["MessageId"]


class _HeartbeatController:
    """Renew one SQS visibility timeout and its matching durable claim."""

    def __init__(
        self,
        *,
        client: Any,
        queue_url: str,
        receipt_handle: str,
        queue_name: str,
        consumer_id: str,
        idempotency_key: str,
        owner_id: str,
        visibility_timeout_seconds: int,
        interval_seconds: float,
        delivery_store: DeliveryStore | None,
        global_stop: threading.Event | None,
    ) -> None:
        self._client = client
        self._queue_url = queue_url
        self._receipt_handle = receipt_handle
        self._queue_name = queue_name
        self._consumer_id = consumer_id
        self._idempotency_key = idempotency_key
        self._owner_id = owner_id
        self._visibility_timeout_seconds = visibility_timeout_seconds
        self._interval_seconds = interval_seconds
        self._delivery_store = delivery_store
        self._global_stop = global_stop
        self._stop = threading.Event()
        self.lost = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"sqs-heartbeat-{queue_name}",
            daemon=True,
        )

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval_seconds):
            if self._global_stop is not None and self._global_stop.is_set():
                self.lost.set()
                return
            lease_until = datetime.now(timezone.utc) + timedelta(
                seconds=self._visibility_timeout_seconds
            )
            try:
                self._client.change_message_visibility(
                    QueueUrl=self._queue_url,
                    ReceiptHandle=self._receipt_handle,
                    VisibilityTimeout=self._visibility_timeout_seconds,
                )
                if self._delivery_store is not None and not self._delivery_store.renew(
                    self._consumer_id,
                    self._idempotency_key,
                    self._owner_id,
                    lease_until,
                ):
                    self.lost.set()
                    return
            except Exception:
                logger.warning(
                    "Visibility/claim heartbeat failed for queue %r; delivery is fenced.",
                    self._queue_name,
                )
                self.lost.set()
                return

    def stop_and_join(self) -> None:
        self._stop.set()
        self._thread.join()


def _safe_release(
    delivery_store: DeliveryStore | None,
    consumer_id: str,
    idempotency_key: str,
    owner_id: str,
) -> None:
    if delivery_store is None:
        return
    try:
        delivery_store.release(consumer_id, idempotency_key, owner_id)
    except Exception:
        logger.warning("Delivery claim release failed for consumer %r.", consumer_id)


def _require_consumer_id(consumer_id: str) -> None:
    if not isinstance(consumer_id, str) or not consumer_id.strip():
        raise ValueError("consumer_id must not be blank")


def consume_once(
    queue_name: str,
    handler: Callable[[MessageEnvelope], None],
    *,
    consumer_id: str,
    delivery_store: DeliveryStore | None = None,
    stop_event: threading.Event | None = None,
    wait_seconds: int = 0,
    visibility_timeout_seconds: int = 30,
    heartbeat_interval_seconds: float | None = None,
) -> int:
    """Receive and safely acknowledge at most one delivery."""
    _require_consumer_id(consumer_id)
    if queue_name in _PRODUCTION_QUEUES and delivery_store is None:
        raise ValueError("A durable delivery_store is required for production work queues.")
    if not 0 <= wait_seconds <= 20:
        raise ValueError("wait_seconds must be between 0 and 20")
    if not 1 <= visibility_timeout_seconds <= 43_200:
        raise ValueError("visibility_timeout_seconds must be between 1 and 43200")
    interval = (
        heartbeat_interval_seconds
        if heartbeat_interval_seconds is not None
        else max(0.1, visibility_timeout_seconds / 3)
    )
    if (
        isinstance(interval, bool)
        or not isinstance(interval, (int, float))
        or not math.isfinite(interval)
        or interval <= 0
        or interval >= visibility_timeout_seconds / 2
    ):
        raise ValueError("heartbeat_interval_seconds must be positive and below half visibility")
    if stop_event is not None and stop_event.is_set():
        return 0

    queue_url = get_queue_url(queue_name)
    client = get_client()
    response = client.receive_message(
        QueueUrl=queue_url,
        WaitTimeSeconds=wait_seconds,
        MaxNumberOfMessages=1,
        VisibilityTimeout=visibility_timeout_seconds,
    )
    messages = response.get("Messages", [])
    if not messages or (stop_event is not None and stop_event.is_set()):
        return 0

    raw_message = messages[0]
    receipt_handle = raw_message["ReceiptHandle"]
    try:
        envelope = MessageEnvelope.from_body(raw_message.get("Body", ""))
    except (ValidationError, ValueError):
        logger.warning(
            "Malformed envelope on queue %r (sqs message id %s); not deleting.",
            queue_name,
            raw_message.get("MessageId"),
        )
        return 0

    idempotency_key = envelope.idempotency_key
    if idempotency_key is None:  # guarded by MessageEnvelope validation
        return 0
    owner_id = str(uuid4())
    if delivery_store is not None:
        try:
            status = delivery_store.claim(
                consumer_id,
                idempotency_key,
                owner_id,
                datetime.now(timezone.utc) + timedelta(seconds=visibility_timeout_seconds),
                graph_scope_key=envelope.graph_scope_key,
                graph_version=envelope.graph_version,
            )
        except Exception:
            logger.warning("Delivery claim failed for queue %r; not deleting.", queue_name)
            return 0
        if status in {"completed", "stale"}:
            client.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
            return 1
        if status == "busy":
            return 0
        if status != "acquired":
            logger.warning("Delivery store returned an invalid claim status for queue %r.", queue_name)
            return 0

    heartbeat = _HeartbeatController(
        client=client,
        queue_url=queue_url,
        receipt_handle=receipt_handle,
        queue_name=queue_name,
        consumer_id=consumer_id,
        idempotency_key=idempotency_key,
        owner_id=owner_id,
        visibility_timeout_seconds=visibility_timeout_seconds,
        interval_seconds=interval,
        delivery_store=delivery_store,
        global_stop=stop_event,
    )
    heartbeat.start()
    handler_succeeded = False
    try:
        handler(envelope)
        handler_succeeded = True
    except Exception:
        logger.warning(
            "Handler failed for message_id=%s on queue %r; not deleting.",
            envelope.message_id,
            queue_name,
        )
    finally:
        heartbeat.stop_and_join()

    if not handler_succeeded or heartbeat.lost.is_set():
        _safe_release(delivery_store, consumer_id, idempotency_key, owner_id)
        return 0
    if delivery_store is not None:
        try:
            completed = delivery_store.complete(consumer_id, idempotency_key, owner_id)
        except Exception:
            logger.warning("Delivery claim completion failed for queue %r; not deleting.", queue_name)
            _safe_release(delivery_store, consumer_id, idempotency_key, owner_id)
            return 0
        if not completed:
            _safe_release(delivery_store, consumer_id, idempotency_key, owner_id)
            return 0

    client.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)
    return 1


def consume(
    queue_name: str,
    handler: Callable[[MessageEnvelope], None],
    *,
    consumer_id: str,
    delivery_store: DeliveryStore | None = None,
    stop_event: threading.Event | None = None,
    wait_seconds: int = 20,
    visibility_timeout_seconds: int = 30,
    # Legacy keyword aliases remain accepted; receiving is intentionally fixed at one.
    max_messages: int | None = None,
    visibility_timeout: int | None = None,
    stop: threading.Event | None = None,
) -> None:
    """Long-poll using the single-delivery, heartbeat-safe primitive."""
    _require_consumer_id(consumer_id)
    del max_messages
    if stop_event is not None and stop is not None and stop_event is not stop:
        raise ValueError("stop_event and stop cannot disagree")
    effective_stop = stop_event or stop
    if visibility_timeout is not None:
        visibility_timeout_seconds = visibility_timeout
    while effective_stop is None or not effective_stop.is_set():
        consume_once(
            queue_name,
            handler,
            consumer_id=consumer_id,
            delivery_store=delivery_store,
            stop_event=effective_stop,
            wait_seconds=wait_seconds,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )


def consume_enrichment(
    handler: Callable[[MessageEnvelope], None],
    *,
    consumer_id: str,
    mode: Literal["priority_only", "weighted"] = "weighted",
    priority_weight: int = 3,
    delivery_store: DeliveryStore,
    stop_event: threading.Event | None = None,
    visibility_timeout_seconds: int = 30,
) -> None:
    """Consume the priority lane alone or with deterministic bounded fairness."""
    _require_consumer_id(consumer_id)
    if mode not in {"priority_only", "weighted"}:
        raise ValueError("mode must be priority_only or weighted")
    if (
        isinstance(priority_weight, bool)
        or not isinstance(priority_weight, int)
        or priority_weight < 1
    ):
        raise ValueError("priority_weight must be a positive integer")

    if mode == "priority_only":
        while stop_event is None or not stop_event.is_set():
            consume_once(
                ENRICHMENT_PRIORITY_QUEUE,
                handler,
                consumer_id=consumer_id,
                delivery_store=delivery_store,
                stop_event=stop_event,
                wait_seconds=1,
                visibility_timeout_seconds=visibility_timeout_seconds,
            )
        return

    schedule = [ENRICHMENT_PRIORITY_QUEUE] * priority_weight + [ENRICHMENT_DEFAULT_QUEUE]
    slot = 0
    while stop_event is None or not stop_event.is_set():
        scheduled = schedule[slot % len(schedule)]
        slot += 1
        handled = consume_once(
            scheduled,
            handler,
            consumer_id=consumer_id,
            delivery_store=delivery_store,
            stop_event=stop_event,
            wait_seconds=0,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )
        if handled == 0 and (stop_event is None or not stop_event.is_set()):
            alternate = (
                ENRICHMENT_DEFAULT_QUEUE
                if scheduled == ENRICHMENT_PRIORITY_QUEUE
                else ENRICHMENT_PRIORITY_QUEUE
            )
            handled = consume_once(
                alternate,
                handler,
                consumer_id=consumer_id,
                delivery_store=delivery_store,
                stop_event=stop_event,
                wait_seconds=0,
                visibility_timeout_seconds=visibility_timeout_seconds,
            )
        if handled == 0:
            if stop_event is not None:
                stop_event.wait(0.1)
            else:
                threading.Event().wait(0.1)

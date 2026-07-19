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
import logging
import threading
from concurrent.futures import Future
from typing import Any, Callable

import boto3
from pydantic import ValidationError
from sayre_workers.config import MissingConfigError, SecretNotFoundError, get_config, get_secret

from .envelope import MessageEnvelope

logger = logging.getLogger(__name__)

# Baseline SQS queue names (per-work-type, NOT per-tenant — org_id lives in the envelope).
INGESTION_QUEUE = "ingestion"  # structural sync / Tree-sitter delta parse jobs
ENRICHMENT_QUEUE = "enrichment"  # LLM semantic enrichment — SEPARATE queue (see rule)
GRAPH_EVENTS_QUEUE = "graph-events"  # graph.updated fan-out events (consumed by Realtime Svc)
SELFTEST_QUEUE = "w0-04-selftest"  # used only by the round-trip integration test

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
    """Idempotent create-queue; returns the queue URL. Safe to call repeatedly."""
    while True:
        client, generation, _ = _bind_client_and_cached_queue_url(queue_name)
        try:
            response = client.create_queue(QueueName=queue_name)
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


def publish(queue_name: str, message: MessageEnvelope) -> str:
    """Serialize the (already-validated) envelope and SendMessage.

    Returns the SQS MessageId. `message` is a `MessageEnvelope`, so `org_id` is
    guaranteed present by construction — this function never accepts a raw payload.
    """
    queue_url = ensure_queue(queue_name)
    client = get_client()
    response = client.send_message(QueueUrl=queue_url, MessageBody=message.to_body())
    return response["MessageId"]


def consume(
    queue_name: str,
    handler: Callable[[MessageEnvelope], None],
    *,
    wait_seconds: int = 20,
    max_messages: int = 10,
    visibility_timeout: int = 30,
    stop: threading.Event | None = None,
) -> None:
    """Long-poll loop until `stop` is set (runs forever if `stop` is None).

    Per message: parse+validate -> handler -> DeleteMessage on success.

    - On parse/validation failure (bad JSON or missing/empty `org_id`/`type`/`source`):
      log (with message_id if recoverable) and do NOT delete and do NOT call the
      handler — the message redelivers after the visibility timeout expires.
    - On handler exception: log and do NOT delete (at-least-once redelivery).
    """
    queue_url = ensure_queue(queue_name)
    client = get_client()

    while stop is None or not stop.is_set():
        response = client.receive_message(
            QueueUrl=queue_url,
            WaitTimeSeconds=wait_seconds,
            MaxNumberOfMessages=max_messages,
            VisibilityTimeout=visibility_timeout,
        )
        messages = response.get("Messages", [])

        for raw_message in messages:
            receipt_handle = raw_message["ReceiptHandle"]
            body = raw_message.get("Body", "")

            try:
                envelope = MessageEnvelope.from_body(body)
            except ValidationError:
                logger.exception(
                    "Malformed/invalid envelope on queue %r (sqs message id %s); "
                    "leaving for redelivery, not deleting.",
                    queue_name,
                    raw_message.get("MessageId"),
                )
                continue
            except ValueError:
                logger.exception(
                    "Non-JSON body on queue %r (sqs message id %s); leaving for "
                    "redelivery, not deleting.",
                    queue_name,
                    raw_message.get("MessageId"),
                )
                continue

            try:
                handler(envelope)
            except Exception:
                logger.exception(
                    "Handler raised for message_id=%s on queue %r; leaving for "
                    "at-least-once redelivery, not deleting.",
                    envelope.message_id,
                    queue_name,
                )
                continue

            client.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt_handle)

        if stop is not None and stop.is_set():
            return

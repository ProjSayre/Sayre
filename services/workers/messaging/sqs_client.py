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

import logging
import os
import threading
from typing import Callable

import boto3
from pydantic import ValidationError

from .envelope import MessageEnvelope

logger = logging.getLogger(__name__)

# Baseline SQS queue names (per-work-type, NOT per-tenant — org_id lives in the envelope).
INGESTION_QUEUE = "ingestion"  # structural sync / Tree-sitter delta parse jobs
ENRICHMENT_QUEUE = "enrichment"  # LLM semantic enrichment — SEPARATE queue (see rule)
GRAPH_EVENTS_QUEUE = "graph-events"  # graph.updated fan-out events (consumed by Realtime Svc)
SELFTEST_QUEUE = "w0-04-selftest"  # used only by the round-trip integration test

_client_lock = threading.Lock()
_client = None

_queue_url_lock = threading.Lock()
_queue_url_cache: dict[str, str] = {}


def get_client():
    """Cached boto3 SQS client.

    `endpoint_url` comes from `SQS_ENDPOINT_URL` (LocalStack locally; unset targets
    real AWS SQS in prod). Region from `AWS_REGION` (default `us-east-1`). Credentials
    come from the standard AWS env chain (dummy `test`/`test` locally, via
    `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).
    """
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            endpoint_url = os.environ.get("SQS_ENDPOINT_URL") or None
            region = os.environ.get("AWS_REGION", "us-east-1")
            _client = boto3.client(
                "sqs",
                endpoint_url=endpoint_url,
                region_name=region,
            )
        return _client


def ensure_queue(queue_name: str) -> str:
    """Idempotent create-queue; returns the queue URL. Safe to call repeatedly."""
    client = get_client()
    response = client.create_queue(QueueName=queue_name)
    queue_url = response["QueueUrl"]
    with _queue_url_lock:
        _queue_url_cache[queue_name] = queue_url
    return queue_url


def get_queue_url(queue_name: str) -> str:
    """Resolve (and cache) a queue's URL. Raises the boto3 `QueueDoesNotExist` error
    if the queue has not been provisioned. Call `ensure_queue` first if the caller
    wants idempotent auto-creation instead."""
    with _queue_url_lock:
        cached = _queue_url_cache.get(queue_name)
    if cached is not None:
        return cached
    client = get_client()
    response = client.get_queue_url(QueueName=queue_name)
    queue_url = response["QueueUrl"]
    with _queue_url_lock:
        _queue_url_cache[queue_name] = queue_url
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

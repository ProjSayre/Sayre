"""SNS publication wrapper for canonical ``graph.updated`` fanout."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future
from typing import Any, Callable, Mapping

import boto3
from sayre_workers.config import MissingConfigError, SecretNotFoundError, get_config, get_secret

from .envelope import MessageEnvelope

GRAPH_UPDATED_TOPIC = "graph-updated"

_client_lock = threading.Lock()
_client: Any | None = None
_client_generation = 0
_client_pending: dict[int, Future[Any]] = {}
_topic_arn_lock = threading.Lock()
_topic_arn_cache: dict[str, tuple[int, str]] = {}


class SNSClientInitializationCancelledError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("SNS client initialization was cancelled by shutdown.")


class SNSClientCloseError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("SNS client close failed.")


class SNSTopicNotFoundError(RuntimeError):
    def __init__(self, topic_name: str) -> None:
        super().__init__(f"Provisioned SNS topic {topic_name!r} was not found.")


async def _optional_secret(ref: str) -> str | None:
    try:
        return await get_secret(ref)
    except SecretNotFoundError:
        return None


async def _await_pending_initialization(pending: Future[Any]) -> Any:
    return await asyncio.shield(asyncio.wrap_future(pending))


def _remove_pending_if_current(generation: int, pending: Future[Any]) -> None:
    if _client_pending.get(generation) is pending:
        _client_pending.pop(generation, None)


def _complete_failed_initialization(
    generation: int, pending: Future[Any], error: Exception
) -> bool:
    with _client_lock:
        cancelled = generation != _client_generation or pending.done()
        _remove_pending_if_current(generation, pending)
        if not pending.done():
            pending.set_exception(
                SNSClientInitializationCancelledError() if cancelled else error
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
        raise SNSClientCloseError from None


async def _close_candidate_after_owner_cancellation(construction: asyncio.Task[Any]) -> None:
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


async def initialize_client(client_factory: Callable[..., Any] | None = None) -> Any:
    """Initialize one generation-bound SNS client from central config/secrets."""
    global _client
    if client_factory is not None and get_config("SAYRE_ENV") != "test":
        raise RuntimeError("SNS client factory injection is unavailable outside tests.")

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
            endpoint_url: str | None = get_config("SNS_ENDPOINT_URL")
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
            raise SNSClientInitializationCancelledError from None
        raise

    with _client_lock:
        cancelled = generation != _client_generation or pending.done()
        if cancelled:
            _remove_pending_if_current(generation, pending)
    if cancelled:
        raise SNSClientInitializationCancelledError

    factory = client_factory or boto3.client
    construction = asyncio.create_task(
        asyncio.to_thread(
            factory,
            "sns",
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
            raise SNSClientInitializationCancelledError from None
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
        raise SNSClientInitializationCancelledError from None


def get_client() -> Any:
    if _client is not None:
        return _client
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(initialize_client())
    raise RuntimeError(
        "SNS client is not initialized; await initialize_client() before synchronous use."
    )


def close_client() -> None:
    """Cancel initialization, clear generation-bound ARN state, and detach client."""
    global _client, _client_generation
    with _client_lock:
        _client_generation += 1
        client = _client
        _client = None
        pending_initializations = list(_client_pending.values())
        _client_pending.clear()
        for pending in pending_initializations:
            if not pending.done():
                pending.set_exception(SNSClientInitializationCancelledError())
        with _topic_arn_lock:
            _topic_arn_cache.clear()
    _close_client_instance(client)


def _binding_and_cached_topic(topic_name: str) -> tuple[Any, int, str | None]:
    while True:
        client = get_client()
        with _client_lock:
            if client is _client and client is not None:
                generation = _client_generation
                with _topic_arn_lock:
                    cached = _topic_arn_cache.get(topic_name)
                    if cached is not None and cached[0] == generation:
                        return client, generation, cached[1]
                return client, generation, None


def _binding_is_current(client: Any, generation: int) -> bool:
    with _client_lock:
        return client is _client and generation == _client_generation


def get_topic_arn(topic_name: str = GRAPH_UPDATED_TOPIC) -> str:
    """Resolve a provisioned topic without silently creating a typo."""
    if not topic_name.strip():
        raise ValueError("topic_name must not be blank")
    while True:
        client, generation, cached = _binding_and_cached_topic(topic_name)
        if cached is not None:
            return cached

        next_token: str | None = None
        found: str | None = None
        while True:
            kwargs = {"NextToken": next_token} if next_token else {}
            try:
                response = client.list_topics(**kwargs)
            except Exception:
                if _binding_is_current(client, generation):
                    raise
                break
            suffix = f":{topic_name}"
            found = next(
                (
                    topic["TopicArn"]
                    for topic in response.get("Topics", [])
                    if topic.get("TopicArn", "").endswith(suffix)
                ),
                None,
            )
            if found is not None:
                break
            next_token = response.get("NextToken")
            if not next_token:
                break
        if not _binding_is_current(client, generation):
            continue
        if found is None:
            raise SNSTopicNotFoundError(topic_name)
        with _client_lock:
            if client is not _client or generation != _client_generation:
                continue
            with _topic_arn_lock:
                _topic_arn_cache[topic_name] = (generation, found)
            return found


def publish_graph_updated(payload: MessageEnvelope | Mapping[str, object]) -> str:
    envelope = (
        payload if isinstance(payload, MessageEnvelope) else MessageEnvelope.model_validate(payload)
    )
    if envelope.type != "graph.updated":
        raise ValueError("publish_graph_updated accepts only graph.updated envelopes")
    if envelope.graph_scope_key is None or envelope.graph_version is None:
        raise ValueError("graph.updated requires graph_scope_key and graph_version")
    while True:
        client, generation, _ = _binding_and_cached_topic(GRAPH_UPDATED_TOPIC)
        topic_arn = get_topic_arn(GRAPH_UPDATED_TOPIC)
        if _binding_is_current(client, generation):
            break
    # Publish is side-effecting: never replay an ambiguous failed request internally.
    response = client.publish(TopicArn=topic_arn, Message=envelope.to_body())
    return response["MessageId"]

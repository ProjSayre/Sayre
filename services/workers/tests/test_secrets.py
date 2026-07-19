"""Focused tests for strict, asynchronous worker secret resolution."""

import asyncio
import sys
import threading
import traceback

import pytest

import sayre_workers.config.secrets as secrets_module
from sayre_workers.config import (
    EmptySecretError,
    InvalidSecretReferenceError,
    SecretNotFoundError,
    SecretResolutionError,
    UnauthorizedSecretReferenceError,
    UnsupportedSecretSchemeError,
    get_secret,
    reset_secrets_for_tests,
    set_secret_backend_for_tests,
)
from workers.messaging import sqs_client


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    sqs_client.close_client()
    reset_secrets_for_tests()
    yield
    sqs_client.close_client()
    monkeypatch.setenv("SAYRE_ENV", "test")
    reset_secrets_for_tests()


async def test_real_env_backend_returns_value_unchanged(monkeypatch):
    monkeypatch.setenv("DATABASE_RUNTIME_URL", "  keep surrounding space  ")
    assert await get_secret("env://DATABASE_RUNTIME_URL") == "  keep surrounding space  "


@pytest.mark.parametrize(
    "ref",
    [
        "DATABASE_ADMIN_URL",
        "env://",
        "env:///DATABASE_ADMIN_URL",
        "env://database_url",
        "env://BAD-NAME",
        "env://BAD.NAME",
        "env://BAD NAME",
        "env://DATABASE_ADMIN_URL?x=1",
        "env://DATABASE_ADMIN_URL#x",
        "env://DATABASE_ADMIN_URL/path",
    ],
)
async def test_malformed_references_rejected_before_backend(ref):
    calls = 0

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        return "unused"

    set_secret_backend_for_tests(backend)
    with pytest.raises(InvalidSecretReferenceError):
        await get_secret(ref)
    assert calls == 0


async def test_unlisted_reference_rejected_before_backend_or_cache():
    calls = 0

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        return "must-not-resolve"

    set_secret_backend_for_tests(backend)
    with pytest.raises(UnauthorizedSecretReferenceError):
        await get_secret("env://WELL_FORMED_BUT_UNLISTED")
    assert calls == 0


@pytest.mark.parametrize("ref", ["vault://DB", "aws-sm://DB", "ENV://DB"])
async def test_unsupported_scheme_is_redacted(ref):
    with pytest.raises(UnsupportedSecretSchemeError) as exc:
        await get_secret(ref)
    assert ref not in str(exc.value)


async def test_missing_and_whitespace_environment_values_have_distinct_errors(monkeypatch):
    monkeypatch.delenv("JWT_SIGNING_KEY", raising=False)
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "   ")
    with pytest.raises(SecretNotFoundError):
        await get_secret("env://JWT_SIGNING_KEY")
    with pytest.raises(EmptySecretError):
        await get_secret("env://GITHUB_WEBHOOK_SECRET")


async def test_empty_injected_backend_result_fails_closed():
    async def backend(_ref: str) -> str:
        return "   "

    set_secret_backend_for_tests(backend)
    with pytest.raises(EmptySecretError):
        await get_secret("env://REDIS_PASSWORD")


@pytest.mark.parametrize(
    "make_error",
    [
        InvalidSecretReferenceError,
        lambda: UnsupportedSecretSchemeError("backend"),
        UnauthorizedSecretReferenceError,
        lambda: SecretNotFoundError("backend"),
        lambda: EmptySecretError("backend"),
        lambda: SecretResolutionError("backend"),
    ],
    ids=[
        "invalid-reference",
        "unsupported-scheme",
        "unauthorized-reference",
        "not-found",
        "empty",
        "resolution",
    ],
)
async def test_backend_supplied_exported_errors_are_fully_sanitized(make_error, capsys):
    sentinel = "SENTINEL_BACKEND_EXCEPTION_VALUE"
    backend_error = make_error()
    backend_error.args = (sentinel,)

    async def backend(_ref: str) -> str:
        raise backend_error

    set_secret_backend_for_tests(backend)
    with pytest.raises(Exception) as exc_info:
        await get_secret("env://ANTHROPIC_API_KEY")

    error = exc_info.value
    if isinstance(backend_error, SecretNotFoundError):
        assert isinstance(error, SecretNotFoundError)
    elif isinstance(backend_error, EmptySecretError):
        assert isinstance(error, EmptySecretError)
    else:
        assert isinstance(error, SecretResolutionError)
    print(error)
    print(repr(error), file=sys.stderr)
    captured = capsys.readouterr()
    visible_error = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    for output in (str(error), repr(error), visible_error, captured.out, captured.err):
        assert sentinel not in output
    assert error.__cause__ is None
    assert error.__context__ is None


async def test_concurrent_calls_share_one_task_and_cache_success():
    calls = 0

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return "resolved"

    set_secret_backend_for_tests(backend)
    assert await asyncio.gather(
        get_secret("env://REDIS_PASSWORD"),
        get_secret("env://REDIS_PASSWORD"),
    ) == ["resolved", "resolved"]
    assert await get_secret("env://REDIS_PASSWORD") == "resolved"
    assert calls == 1


def test_inflight_resolution_is_shared_across_threads_and_event_loops(monkeypatch):
    backend_started = threading.Event()
    waiter_started = threading.Event()
    release = threading.Event()
    calls = 0
    state_lock = threading.Lock()
    results: list[str] = []
    errors: list[BaseException] = []

    original_await = secrets_module._await_shared_resolution

    async def observed_await(resolution):
        waiter_started.set()
        return await original_await(resolution)

    async def backend(_ref: str) -> str:
        nonlocal calls
        with state_lock:
            calls += 1
        backend_started.set()
        if not await asyncio.to_thread(release.wait, 2):
            raise TimeoutError("test release timed out")
        return "resolved-across-loops"

    def resolve_from_thread() -> None:
        try:
            value = asyncio.run(get_secret("env://REDIS_PASSWORD"))
            with state_lock:
                results.append(value)
        except BaseException as error:
            with state_lock:
                errors.append(error)

    monkeypatch.setattr(secrets_module, "_await_shared_resolution", observed_await)
    set_secret_backend_for_tests(backend)
    first = threading.Thread(target=resolve_from_thread, daemon=True)
    second = threading.Thread(target=resolve_from_thread, daemon=True)

    first.start()
    try:
        assert backend_started.wait(timeout=1)
        second.start()
        assert waiter_started.wait(timeout=1)
    finally:
        release.set()
        first.join(timeout=2)
        if second.ident is not None:
            second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert errors == []
    assert results == ["resolved-across-loops", "resolved-across-loops"]
    assert calls == 1


async def test_failed_task_is_evicted_for_retry():
    calls = 0

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary")
        return "recovered"

    set_secret_backend_for_tests(backend)
    with pytest.raises(SecretResolutionError):
        await get_secret("env://NEO4J_PASSWORD")
    assert await get_secret("env://NEO4J_PASSWORD") == "recovered"
    assert calls == 2


async def test_cancelled_resolution_is_evicted_for_retry():
    calls = 0
    started = asyncio.Event()

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            await asyncio.Future()
        return "recovered-after-cancellation"

    set_secret_backend_for_tests(backend)
    first = asyncio.create_task(get_secret("env://NEO4J_PASSWORD"))
    await asyncio.wait_for(started.wait(), timeout=1)
    first.cancel()

    with pytest.raises(asyncio.CancelledError):
        await first

    assert await get_secret("env://NEO4J_PASSWORD") == "recovered-after-cancellation"
    assert calls == 2


async def test_backend_cancellation_is_sanitized_for_owner_and_waiters_and_retryable(
    monkeypatch,
    capsys,
):
    sentinel = "SENTINEL_BACKEND_CANCELLED_ERROR"
    calls = 0
    backend_started = asyncio.Event()
    waiter_started = asyncio.Event()
    release_backend = asyncio.Event()
    original_await = secrets_module._await_shared_resolution

    async def observed_await(resolution):
        waiter_started.set()
        return await original_await(resolution)

    async def backend(_ref: str) -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            backend_started.set()
            await release_backend.wait()
            raise asyncio.CancelledError(sentinel, {"detail": sentinel}, 42)
        return "recovered-after-backend-cancellation"

    monkeypatch.setattr(secrets_module, "_await_shared_resolution", observed_await)
    set_secret_backend_for_tests(backend)
    owner = asyncio.create_task(get_secret("env://NEO4J_PASSWORD"))
    await asyncio.wait_for(backend_started.wait(), timeout=1)
    waiter = asyncio.create_task(get_secret("env://NEO4J_PASSWORD"))
    await asyncio.wait_for(waiter_started.wait(), timeout=1)
    release_backend.set()

    errors = []
    for task in (owner, waiter):
        with pytest.raises(asyncio.CancelledError) as exc_info:
            await task
        errors.append(exc_info.value)

    for error in errors:
        print(error)
        print(repr(error), file=sys.stderr)
        visible_error = "".join(
            traceback.format_exception(type(error), error, error.__traceback__)
        )
        assert error.args == ()
        assert sentinel not in str(error)
        assert sentinel not in repr(error)
        assert sentinel not in visible_error
        assert error.__cause__ is None
        assert error.__context__ is None

    assert errors[0].__suppress_context__ is True
    captured = capsys.readouterr()
    assert sentinel not in captured.out
    assert sentinel not in captured.err
    assert await get_secret("env://NEO4J_PASSWORD") == (
        "recovered-after-backend-cancellation"
    )
    assert calls == 2


async def test_backend_errors_never_expose_sentinel_value():
    sentinel = "sentinel-super-secret-value"

    async def backend(_ref: str) -> str:
        raise RuntimeError(sentinel)

    set_secret_backend_for_tests(backend)
    with pytest.raises(SecretResolutionError) as exc:
        await get_secret("env://ANTHROPIC_API_KEY")
    assert sentinel not in str(exc.value)


def test_mutating_helpers_reject_outside_exact_test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "production")

    async def backend(_ref: str) -> str:
        return "x"

    with pytest.raises(SecretResolutionError):
        set_secret_backend_for_tests(backend)
    with pytest.raises(SecretResolutionError):
        reset_secrets_for_tests()


async def test_sqs_initialization_resolves_every_value_before_fake_constructor(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "resolved-access")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "resolved-secret")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "resolved-session")
    reset_secrets_for_tests()
    calls = []
    fake_client = object()

    def factory(service_name: str, **kwargs):
        calls.append((service_name, kwargs))
        return fake_client

    try:
        assert await sqs_client.initialize_client(factory) is fake_client
        assert calls == [
            (
                "sqs",
                {
                    "endpoint_url": "http://localstack.invalid:4566",
                    "region_name": "us-test-1",
                    "aws_access_key_id": "resolved-access",
                    "aws_secret_access_key": "resolved-secret",
                    "aws_session_token": "resolved-session",
                },
            )
        ]
    finally:
        sqs_client.close_client()


async def test_sqs_empty_environment_credential_rejects_before_factory(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "   ")
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
    monkeypatch.delenv("AWS_SESSION_TOKEN", raising=False)
    reset_secrets_for_tests()
    calls = []

    def factory(*_args, **_kwargs):
        calls.append("constructed")
        return object()

    with pytest.raises(EmptySecretError):
        await sqs_client.initialize_client(factory)
    assert calls == []


async def test_sqs_empty_backend_credential_rejects_before_factory(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")

    async def backend(ref: str) -> str:
        if ref == "env://AWS_ACCESS_KEY_ID":
            return "   "
        raise SecretNotFoundError("untrusted-backend-name")

    set_secret_backend_for_tests(backend)
    calls = []

    def factory(*_args, **_kwargs):
        calls.append("constructed")
        return object()

    with pytest.raises(EmptySecretError):
        await sqs_client.initialize_client(factory)
    assert calls == []


async def test_sqs_factory_injection_rejects_outside_test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "production")
    with pytest.raises(RuntimeError, match="unavailable outside tests"):
        await sqs_client.initialize_client(lambda *_args, **_kwargs: object())


async def test_concurrent_sqs_initialization_constructs_exactly_one_client(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    started = asyncio.Event()
    release = asyncio.Event()
    resolutions: list[str] = []
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        resolutions.append(ref)
        if len(resolutions) == 3:
            started.set()
        await release.wait()
        return values[ref]

    set_secret_backend_for_tests(backend)
    constructed = []

    class FakeClient:
        def close(self) -> None:
            pass

    fake_client = FakeClient()

    def factory(*_args, **_kwargs):
        constructed.append(fake_client)
        return fake_client

    first = asyncio.create_task(sqs_client.initialize_client(factory))
    second = asyncio.create_task(sqs_client.initialize_client(factory))
    await asyncio.wait_for(started.wait(), timeout=1)
    release.set()

    clients = await asyncio.gather(first, second)
    assert clients == [fake_client, fake_client]
    assert constructed == [fake_client]


async def test_sqs_shutdown_during_initialization_cancels_without_late_leak(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    started = asyncio.Event()
    release = asyncio.Event()
    resolutions: list[str] = []
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        resolutions.append(ref)
        if len(resolutions) == 3:
            started.set()
        await release.wait()
        return values[ref]

    set_secret_backend_for_tests(backend)
    constructed = []

    class FakeClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    def factory(*_args, **_kwargs):
        client = FakeClient()
        constructed.append(client)
        return client

    initialization = asyncio.create_task(sqs_client.initialize_client(factory))
    await asyncio.wait_for(started.wait(), timeout=1)
    sqs_client.close_client()
    release.set()

    with pytest.raises(sqs_client.SQSClientInitializationCancelledError):
        await initialization
    assert constructed == []
    assert sqs_client._client is None

    restarted = await sqs_client.initialize_client(factory)
    assert restarted is constructed[0]
    sqs_client.close_client()
    assert constructed[0].close_calls == 1


async def test_sqs_factory_does_not_block_same_loop_shutdown(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        return values[ref]

    set_secret_backend_for_tests(backend)
    loop_thread = threading.get_ident()
    factory_started = threading.Event()
    release_factory = threading.Event()
    shutdown_complete = asyncio.Event()
    factory_threads: list[int] = []
    constructed = []

    class FakeClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    def factory(*_args, **_kwargs):
        client = FakeClient()
        constructed.append(client)
        factory_threads.append(threading.get_ident())
        if len(constructed) == 1:
            factory_started.set()
            if not release_factory.wait(timeout=2):
                raise TimeoutError("test factory release timed out")
        return client

    async def shutdown_on_same_loop() -> None:
        started = await asyncio.to_thread(factory_started.wait, 1)
        assert started
        sqs_client.close_client()
        shutdown_complete.set()

    initialization = asyncio.create_task(sqs_client.initialize_client(factory))
    shutdown = asyncio.create_task(shutdown_on_same_loop())
    try:
        await asyncio.wait_for(shutdown_complete.wait(), timeout=1)
        assert not initialization.done()
    finally:
        release_factory.set()

    await shutdown
    with pytest.raises(sqs_client.SQSClientInitializationCancelledError):
        await initialization
    assert factory_threads[0] != loop_thread
    assert constructed[0].close_calls == 1
    assert sqs_client._client is None

    restarted = await sqs_client.initialize_client(factory)
    assert restarted is constructed[1]
    sqs_client.close_client()
    assert constructed[1].close_calls == 1


async def test_sqs_cancelled_owner_closes_offloaded_candidate_and_can_retry(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    factory_started = threading.Event()
    release_factory = threading.Event()
    constructed = []

    class FakeClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    def factory(*_args, **_kwargs):
        client = FakeClient()
        constructed.append(client)
        if len(constructed) == 1:
            factory_started.set()
            if not release_factory.wait(timeout=2):
                raise TimeoutError("test factory release timed out")
        return client

    initialization = asyncio.create_task(sqs_client.initialize_client(factory))
    assert await asyncio.to_thread(factory_started.wait, 1)
    initialization.cancel()
    await asyncio.sleep(0)
    assert not initialization.done()
    release_factory.set()

    with pytest.raises(asyncio.CancelledError):
        await initialization
    assert constructed[0].close_calls == 1
    assert sqs_client._client is None

    restarted = await sqs_client.initialize_client(factory)
    assert restarted is constructed[1]
    sqs_client.close_client()
    assert constructed[1].close_calls == 1


async def test_sqs_normal_close_failure_is_fixed_detached_and_restartable(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    sentinel = "SENTINEL_SQS_NORMAL_CLOSE_SECRET"

    class FailingCloseClient:
        def close(self) -> None:
            raise RuntimeError(f"close leaked {sentinel}")

    class RestartedClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    old_client = FailingCloseClient()
    restarted_client = RestartedClient()
    assert await sqs_client.initialize_client(
        lambda *_args, **_kwargs: old_client
    ) is old_client
    with sqs_client._client_lock:
        generation = sqs_client._client_generation
        with sqs_client._queue_url_lock:
            sqs_client._queue_url_cache["close-test"] = (
                generation,
                "https://old.invalid/close-test",
            )

    with pytest.raises(sqs_client.SQSClientCloseError) as exc_info:
        sqs_client.close_client()

    error = exc_info.value
    visible_error = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    assert sentinel not in str(error)
    assert sentinel not in repr(error)
    assert sentinel not in visible_error
    assert error.__context__ is None
    assert sqs_client._client is None
    with sqs_client._queue_url_lock:
        assert sqs_client._queue_url_cache == {}

    restarted = await sqs_client.initialize_client(
        lambda *_args, **_kwargs: restarted_client
    )
    assert restarted is restarted_client
    sqs_client.close_client()
    assert restarted_client.close_calls == 1


async def test_sqs_owner_cancellation_survives_late_candidate_close_failure(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    sentinel = "SENTINEL_SQS_LATE_CLOSE_SECRET"
    factory_started = threading.Event()
    release_factory = threading.Event()
    constructed = []

    class FailingCloseClient:
        def close(self) -> None:
            raise RuntimeError(f"late close leaked {sentinel}")

    class RestartedClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    restarted_client = RestartedClient()

    def factory(*_args, **_kwargs):
        if not constructed:
            client = FailingCloseClient()
            constructed.append(client)
            factory_started.set()
            if not release_factory.wait(timeout=2):
                raise TimeoutError("test factory release timed out")
            return client
        return restarted_client

    initialization = asyncio.create_task(sqs_client.initialize_client(factory))
    assert await asyncio.to_thread(factory_started.wait, 1)
    initialization.cancel()
    await asyncio.sleep(0)
    release_factory.set()

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await initialization
    error = exc_info.value
    visible_error = "".join(
        traceback.format_exception(type(error), error, error.__traceback__)
    )
    assert sentinel not in str(error)
    assert sentinel not in repr(error)
    assert sentinel not in visible_error
    assert sqs_client._client is None

    restarted = await sqs_client.initialize_client(factory)
    assert restarted is restarted_client
    sqs_client.close_client()
    assert restarted_client.close_calls == 1


def test_sqs_blocked_factory_shutdown_cancels_all_callers_and_closes_candidate_once(
    monkeypatch,
):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        return values[ref]

    set_secret_backend_for_tests(backend)
    factory_started = threading.Event()
    waiter_started = threading.Event()
    release_factory = threading.Event()
    state_lock = threading.Lock()
    constructed = []
    results = []
    errors: list[BaseException] = []

    class FakeClient:
        def __init__(self) -> None:
            self.close_calls = 0

        def close(self) -> None:
            self.close_calls += 1

    def factory(*_args, **_kwargs):
        client = FakeClient()
        with state_lock:
            constructed.append(client)
            first_construction = len(constructed) == 1
        if first_construction:
            factory_started.set()
            if not release_factory.wait(timeout=2):
                raise TimeoutError("test factory release timed out")
        return client

    original_await = sqs_client._await_pending_initialization

    async def observed_await(pending):
        waiter_started.set()
        return await original_await(pending)

    def initialize_from_thread() -> None:
        try:
            client = sqs_client.get_client()
            with state_lock:
                results.append(client)
        except BaseException as error:
            with state_lock:
                errors.append(error)

    monkeypatch.setattr(sqs_client, "_await_pending_initialization", observed_await)
    monkeypatch.setattr(sqs_client.boto3, "client", factory)
    owner = threading.Thread(target=initialize_from_thread, daemon=True)
    waiter = threading.Thread(target=initialize_from_thread, daemon=True)

    owner.start()
    try:
        assert factory_started.wait(timeout=1)
        waiter.start()
        assert waiter_started.wait(timeout=1)
        sqs_client.close_client()
        assert owner.is_alive()
    finally:
        release_factory.set()
        owner.join(timeout=2)
        if waiter.ident is not None:
            waiter.join(timeout=2)

    assert not owner.is_alive()
    assert not waiter.is_alive()
    assert results == []
    assert len(errors) == 2
    assert all(
        isinstance(error, sqs_client.SQSClientInitializationCancelledError) for error in errors
    )
    assert len(constructed) == 1
    assert constructed[0].close_calls == 1
    assert sqs_client._client is None

    restarted = sqs_client.get_client()
    assert restarted is constructed[1]
    assert sqs_client._client is restarted
    sqs_client.close_client()
    assert constructed[1].close_calls == 1


async def test_stale_queue_url_lookup_cannot_repopulate_cache_after_restart(monkeypatch):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        return values[ref]

    set_secret_backend_for_tests(backend)
    old_lookup_started = threading.Event()
    release_old_lookup = threading.Event()
    resolved_urls: list[str] = []
    errors: list[BaseException] = []

    class FakeClient:
        def __init__(self, queue_url: str, *, block_lookup: bool = False) -> None:
            self.queue_url = queue_url
            self.block_lookup = block_lookup
            self.lookup_calls = 0
            self.close_calls = 0

        def get_queue_url(self, *, QueueName: str):
            assert QueueName == "generation-bound"
            self.lookup_calls += 1
            if self.block_lookup:
                old_lookup_started.set()
                if not release_old_lookup.wait(timeout=2):
                    raise TimeoutError("test queue lookup release timed out")
            return {"QueueUrl": self.queue_url}

        def close(self) -> None:
            self.close_calls += 1

    old_url = "https://old.invalid/queue/generation-bound"
    new_url = "https://new.invalid/queue/generation-bound"
    old_client = FakeClient(old_url, block_lookup=True)
    new_client = FakeClient(new_url)
    assert await sqs_client.initialize_client(lambda *_args, **_kwargs: old_client) is old_client

    def resolve_queue_url() -> None:
        try:
            resolved_urls.append(sqs_client.get_queue_url("generation-bound"))
        except BaseException as error:
            errors.append(error)

    lookup = threading.Thread(target=resolve_queue_url, daemon=True)
    lookup.start()
    try:
        assert await asyncio.to_thread(old_lookup_started.wait, 1)
        sqs_client.close_client()
        restarted = await sqs_client.initialize_client(
            lambda *_args, **_kwargs: new_client
        )
        assert restarted is new_client
    finally:
        release_old_lookup.set()
        await asyncio.to_thread(lookup.join, 2)

    assert not lookup.is_alive()
    assert errors == []
    assert resolved_urls == [new_url]
    assert old_client.lookup_calls == 1
    assert old_client.close_calls == 1
    assert new_client.lookup_calls == 1
    with sqs_client._client_lock:
        generation = sqs_client._client_generation
        with sqs_client._queue_url_lock:
            assert sqs_client._queue_url_cache == {
                "generation-bound": (generation, new_url)
            }


@pytest.mark.parametrize(
    ("operation_name", "rpc_name"),
    [
        ("get_queue_url", "get_queue_url"),
        ("ensure_queue", "create_queue"),
    ],
)
async def test_stale_queue_rpc_failures_retry_for_all_callers_after_restart(
    monkeypatch,
    operation_name,
    rpc_name,
):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        return values[ref]

    set_secret_backend_for_tests(backend)
    caller_count = 3
    old_calls_started = threading.Event()
    release_old_calls = threading.Event()
    state_lock = threading.Lock()
    resolved_urls: list[str] = []
    errors: list[BaseException] = []

    class StaleTransportError(RuntimeError):
        pass

    class FakeClient:
        def __init__(self, queue_url: str, *, stale: bool) -> None:
            self.queue_url = queue_url
            self.stale = stale
            self.rpc_calls = 0
            self.close_calls = 0

        def _rpc(self, queue_name: str):
            assert queue_name == "generation-failure"
            with state_lock:
                self.rpc_calls += 1
                if self.stale and self.rpc_calls == caller_count:
                    old_calls_started.set()
            if self.stale:
                if not release_old_calls.wait(timeout=2):
                    raise TimeoutError("test stale RPC release timed out")
                raise StaleTransportError("old generation transport failed")
            return {"QueueUrl": self.queue_url}

        def get_queue_url(self, *, QueueName: str):
            return self._rpc(QueueName)

        def create_queue(self, *, QueueName: str):
            return self._rpc(QueueName)

        def close(self) -> None:
            self.close_calls += 1

    old_url = "https://old.invalid/queue/generation-failure"
    new_url = "https://new.invalid/queue/generation-failure"
    old_client = FakeClient(old_url, stale=True)
    new_client = FakeClient(new_url, stale=False)
    assert await sqs_client.initialize_client(
        lambda *_args, **_kwargs: old_client
    ) is old_client
    operation = getattr(sqs_client, operation_name)

    def call_operation() -> None:
        try:
            value = operation("generation-failure")
            with state_lock:
                resolved_urls.append(value)
        except BaseException as error:
            with state_lock:
                errors.append(error)

    callers = [threading.Thread(target=call_operation, daemon=True) for _ in range(caller_count)]
    for caller in callers:
        caller.start()
    try:
        assert await asyncio.to_thread(old_calls_started.wait, 1)
        assert old_client.rpc_calls == caller_count
        sqs_client.close_client()
        restarted = await sqs_client.initialize_client(
            lambda *_args, **_kwargs: new_client
        )
        assert restarted is new_client
    finally:
        release_old_calls.set()
        for caller in callers:
            await asyncio.to_thread(caller.join, 2)

    assert all(not caller.is_alive() for caller in callers)
    assert errors == []
    assert resolved_urls == [new_url] * caller_count
    assert old_client.rpc_calls == caller_count
    assert old_client.close_calls == 1
    if rpc_name == "create_queue":
        assert new_client.rpc_calls == caller_count
    else:
        assert 1 <= new_client.rpc_calls <= caller_count
    with sqs_client._client_lock:
        generation = sqs_client._client_generation
        with sqs_client._queue_url_lock:
            assert sqs_client._queue_url_cache == {
                "generation-failure": (generation, new_url)
            }


@pytest.mark.parametrize(
    ("operation_name", "rpc_name"),
    [
        ("get_queue_url", "get_queue_url"),
        ("ensure_queue", "create_queue"),
    ],
)
async def test_current_queue_rpc_failure_is_reraised_unchanged(
    monkeypatch,
    operation_name,
    rpc_name,
):
    monkeypatch.setenv("SQS_ENDPOINT_URL", "http://localstack.invalid:4566")
    monkeypatch.setenv("AWS_REGION", "us-test-1")
    values = {
        "env://AWS_ACCESS_KEY_ID": "resolved-access",
        "env://AWS_SECRET_ACCESS_KEY": "resolved-secret",
        "env://AWS_SESSION_TOKEN": "resolved-session",
    }

    async def backend(ref: str) -> str:
        return values[ref]

    set_secret_backend_for_tests(backend)

    class CurrentTransportError(RuntimeError):
        pass

    failure = CurrentTransportError("current generation transport failed")

    class FakeClient:
        def __init__(self) -> None:
            self.rpc_calls = 0

        def _fail(self):
            self.rpc_calls += 1
            raise failure

        def get_queue_url(self, *, QueueName: str):
            assert QueueName == "current-failure"
            return self._fail()

        def create_queue(self, *, QueueName: str):
            assert QueueName == "current-failure"
            return self._fail()

        def close(self) -> None:
            pass

    client = FakeClient()
    assert await sqs_client.initialize_client(
        lambda *_args, **_kwargs: client
    ) is client
    operation = getattr(sqs_client, operation_name)

    with pytest.raises(CurrentTransportError) as exc_info:
        operation("current-failure")

    assert exc_info.value is failure
    assert client.rpc_calls == 1
    assert getattr(client, rpc_name).__self__ is client
    with sqs_client._queue_url_lock:
        assert sqs_client._queue_url_cache == {}

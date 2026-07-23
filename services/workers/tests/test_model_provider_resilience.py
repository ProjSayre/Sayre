from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from sayre_workers.model_provider import (
    CircuitBreaker,
    GenerationConfig,
    GenerationRequest,
    GenerationResponse,
    InvalidModelProviderConfigError,
    ModelProviderFactory,
    ProviderCallFailedError,
    ProviderCallScope,
    ResiliencePolicy,
    ResilientModelProvider,
    StructuredGenerationResponse,
)

REQUEST = GenerationRequest(system="system", input="input")


class StubProvider:
    def __init__(self, outcomes: list[object] | None = None) -> None:
        self.outcomes = list(outcomes or [GenerationResponse(text="ok")])
        self.calls = 0
        self.closed = 0

    async def _next(self) -> object:
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, asyncio.Event):
            await outcome.wait()
            return GenerationResponse(text="late")
        return outcome

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        assert request is REQUEST
        result = await self._next()
        assert isinstance(result, GenerationResponse)
        return result

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse:
        assert request is REQUEST
        assert schema == {"type": "object"}
        result = await self._next()
        assert isinstance(result, StructuredGenerationResponse)
        return result

    async def aclose(self) -> None:
        self.closed += 1


@pytest.mark.parametrize(
    "resilience",
    [
        "not-an-object",
        {"unknown": 1},
        {"fallback_mode": "hosted"},
        {"timeout_seconds": True},
        {"timeout_seconds": 0},
        {"timeout_seconds": float("inf")},
        {"failure_threshold": 0},
        {"failure_threshold": 1.5},
        {"max_retries": 11},
        {"initial_backoff_seconds": -1},
        {"initial_backoff_seconds": 2, "max_backoff_seconds": 1},
    ],
)
def test_resilience_policy_rejects_unbounded_or_unknown_configuration(
    resilience: object,
) -> None:
    with pytest.raises(InvalidModelProviderConfigError):
        ResiliencePolicy.from_options({"resilience": resilience})


def test_resilience_policy_uses_bounded_defaults_for_missing_or_empty_options() -> None:
    assert ResiliencePolicy.from_options({}) == ResiliencePolicy()
    assert ResiliencePolicy.from_options({"resilience": {}}) == ResiliencePolicy()


@pytest.mark.asyncio
async def test_wrapper_bounds_plain_and_structured_calls_with_same_timeout() -> None:
    plain_wait = asyncio.Event()
    structured_wait = asyncio.Event()
    base = StubProvider([plain_wait, structured_wait])
    provider = ResilientModelProvider(
        base,
        ResiliencePolicy(timeout_seconds=0.01, failure_threshold=100),
    )

    with pytest.raises(ProviderCallFailedError) as plain:
        await provider.generate(REQUEST)
    with pytest.raises(ProviderCallFailedError) as structured:
        await provider.generate_structured(REQUEST, {"type": "object"})

    assert plain.value.reason == "timeout"
    assert structured.value.reason == "timeout"
    assert plain.value.__cause__ is None
    assert structured.value.__cause__ is None
    assert base.calls == 2


@pytest.mark.asyncio
async def test_retry_is_bounded_uses_capped_backoff_and_never_changes_provider() -> None:
    base = StubProvider([RuntimeError("private-1"), RuntimeError("private-2"), RuntimeError("private-3")])
    sleeps: list[float] = []

    async def record_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    provider = ResilientModelProvider(
        base,
        ResiliencePolicy(
            fallback_mode="retry",
            max_retries=2,
            failure_threshold=100,
            initial_backoff_seconds=0.2,
            max_backoff_seconds=0.3,
        ),
        sleep=record_sleep,
    )

    with pytest.raises(ProviderCallFailedError) as failure:
        await provider.generate(REQUEST)

    assert failure.value.reason == "retry_exhausted"
    assert failure.value.fallback_mode == "retry"
    assert "private" not in str(failure.value)
    assert failure.value.__cause__ is None
    assert base.calls == 3
    assert sleeps == [0.2, 0.3]


@pytest.mark.asyncio
async def test_retry_zero_is_one_attempt_and_a_later_attempt_can_recover() -> None:
    no_retry = StubProvider([RuntimeError("private")])
    no_retry_wrapper = ResilientModelProvider(
        no_retry,
        ResiliencePolicy(
            fallback_mode="retry",
            max_retries=0,
            failure_threshold=100,
        ),
    )
    with pytest.raises(ProviderCallFailedError) as exhausted:
        await no_retry_wrapper.generate(REQUEST)
    assert exhausted.value.reason == "retry_exhausted"
    assert no_retry.calls == 1

    sleeps: list[float] = []

    async def record_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    recovers = StubProvider(
        [RuntimeError("private"), GenerationResponse(text="recovered")]
    )
    recovering_wrapper = ResilientModelProvider(
        recovers,
        ResiliencePolicy(
            fallback_mode="retry",
            max_retries=1,
            failure_threshold=100,
            initial_backoff_seconds=0,
            max_backoff_seconds=0,
        ),
        sleep=record_sleep,
    )
    assert (await recovering_wrapper.generate(REQUEST)).text == "recovered"
    assert recovers.calls == 2
    assert sleeps == [0]


@pytest.mark.asyncio
async def test_circuit_opens_allows_one_half_open_probe_and_recovers() -> None:
    now = 10.0
    policy = ResiliencePolicy(failure_threshold=1, recovery_timeout_seconds=5)
    breaker = CircuitBreaker(policy, clock=lambda: now)

    first = await breaker.before_call()
    await breaker.record_failure(first)
    assert breaker.state == "open"
    with pytest.raises(ProviderCallFailedError) as open_failure:
        await breaker.before_call()
    assert open_failure.value.reason == "circuit_open"

    now = 15.0
    probe = await breaker.before_call()
    assert breaker.state == "half_open"
    with pytest.raises(ProviderCallFailedError):
        await breaker.before_call()

    await breaker.record_success(probe)
    assert breaker.state == "closed"
    await breaker.record_success(await breaker.before_call())


@pytest.mark.asyncio
async def test_cancelled_half_open_probe_reopens_without_swallowing_cancellation() -> None:
    now = 0.0
    policy = ResiliencePolicy(failure_threshold=1, recovery_timeout_seconds=1)
    breaker = CircuitBreaker(policy, clock=lambda: now)
    permit = await breaker.before_call()
    await breaker.record_failure(permit)
    now = 1.0
    probe = await breaker.before_call()

    await breaker.record_cancelled(probe)

    assert breaker.state == "open"


@pytest.mark.asyncio
async def test_concurrent_recovery_callers_admit_exactly_one_half_open_probe() -> None:
    now = 0.0
    breaker = CircuitBreaker(
        ResiliencePolicy(failure_threshold=1, recovery_timeout_seconds=1),
        clock=lambda: now,
    )
    first = await breaker.before_call()
    await breaker.record_failure(first)
    now = 1.0

    async def request_permit():
        try:
            return await breaker.before_call()
        except ProviderCallFailedError:
            return None

    permits = await asyncio.gather(*(request_permit() for _ in range(20)))
    admitted = [permit for permit in permits if permit is not None]

    assert len(admitted) == 1
    assert admitted[0].probe is True
    assert breaker.state == "half_open"
    await breaker.record_success(admitted[0])
    assert breaker.state == "closed"


@pytest.mark.asyncio
async def test_wrapper_propagates_cancellation_without_counting_a_closed_call_failure() -> None:
    wait = asyncio.Event()
    policy = ResiliencePolicy(failure_threshold=1)
    breaker = CircuitBreaker(policy)
    provider = ResilientModelProvider(
        StubProvider([wait]),
        policy,
        breaker=breaker,
    )
    task = asyncio.create_task(provider.generate(REQUEST))
    await asyncio.sleep(0)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert breaker.state == "closed"


@pytest.mark.asyncio
async def test_factory_reuses_per_org_config_and_closes_each_client_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = ModelProviderFactory()
    created: list[StubProvider] = []

    async def build(_config: GenerationConfig) -> StubProvider:
        provider = StubProvider()
        created.append(provider)
        return provider

    monkeypatch.setattr(factory, "_create_base", build)
    config = GenerationConfig(provider="fixture", model="model")
    scope_a = ProviderCallScope("org-a")
    scope_b = ProviderCallScope("org-b")

    a1 = await factory.create(config, scope_a)
    a2 = await factory.create(config, scope_a)
    b = await factory.create(config, scope_b)

    assert a1 is a2
    assert b is not a1
    assert len(created) == 2

    await factory.aclose()
    await factory.aclose()

    assert [provider.closed for provider in created] == [1, 1]
    with pytest.raises(RuntimeError, match="closed"):
        await factory.create(config, scope_a)


@pytest.mark.asyncio
async def test_factory_does_not_share_changed_config_or_purpose_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = ModelProviderFactory()

    async def build(_config: GenerationConfig) -> StubProvider:
        return StubProvider()

    monkeypatch.setattr(factory, "_create_base", build)
    base = GenerationConfig(
        provider="fixture",
        model="model",
        credential_ref="env://FIRST",
    )
    changed_credential = GenerationConfig(
        provider="fixture",
        model="model",
        credential_ref="env://SECOND",
    )
    changed_options = GenerationConfig(
        provider="fixture",
        model="model",
        credential_ref="env://FIRST",
        options={"resilience": {"failure_threshold": 1}},
    )

    providers = [
        await factory.create(base, ProviderCallScope("org-a", "generation")),
        await factory.create(base, ProviderCallScope("org-a", "embedding")),
        await factory.create(changed_credential, ProviderCallScope("org-a", "generation")),
        await factory.create(changed_options, ProviderCallScope("org-a", "generation")),
    ]

    assert len({id(provider) for provider in providers}) == 4
    await factory.aclose()


@pytest.mark.asyncio
async def test_identical_configs_have_tenant_isolated_breakers_and_concurrent_progress(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    factory = ModelProviderFactory()
    slow = StubProvider([asyncio.Event()])
    fast = StubProvider([GenerationResponse(text="fast")])
    providers = iter((slow, fast))

    async def build(_config: GenerationConfig) -> StubProvider:
        return next(providers)

    monkeypatch.setattr(factory, "_create_base", build)
    config = GenerationConfig(
        provider="fixture",
        model="model",
        options={
            "resilience": {
                "timeout_seconds": 0.02,
                "failure_threshold": 1,
                "fallback_mode": "degrade",
            }
        },
    )
    provider_a = await factory.create(config, ProviderCallScope("org-a"))
    provider_b = await factory.create(config, ProviderCallScope("org-b"))

    slow_task = asyncio.create_task(provider_a.generate(REQUEST))
    fast_result = await asyncio.wait_for(provider_b.generate(REQUEST), timeout=0.01)
    with pytest.raises(ProviderCallFailedError) as failure:
        await slow_task

    assert fast_result.text == "fast"
    assert failure.value.reason == "timeout"
    assert slow.calls == 1
    assert fast.calls == 1
    await factory.aclose()

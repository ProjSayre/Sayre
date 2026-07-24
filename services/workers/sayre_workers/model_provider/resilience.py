"""Bounded, tenant-isolated resilience for vendor-neutral model providers.

The wrapper deliberately knows nothing about vendor SDKs or alternate providers.  It
can only call the adapter it wraps, so retry/degrade/fail can never turn into a hosted
fallback.  Circuit state is owned by ``ModelProviderFactory`` and therefore shared by
matching calls for one org/purpose/config for the life of a worker process.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from .protocol import (
    GenerationRequest,
    GenerationResponse,
    InvalidModelProviderConfigError,
    ModelProvider,
    StructuredGenerationResponse,
)

FallbackMode = Literal["retry", "degrade", "fail"]
ProviderFailureReason = Literal[
    "timeout", "circuit_open", "provider_error", "retry_exhausted"
]
CircuitState = Literal["closed", "open", "half_open"]

_T = TypeVar("_T")
_POLICY_KEYS = frozenset(
    {
        "timeout_seconds",
        "failure_threshold",
        "recovery_timeout_seconds",
        "fallback_mode",
        "max_retries",
        "initial_backoff_seconds",
        "max_backoff_seconds",
    }
)


def _number(
    raw: object,
    *,
    name: str,
    default: float,
    minimum: float,
    maximum: float,
    allow_zero: bool = False,
) -> float:
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise InvalidModelProviderConfigError(f"resilience {name} must be a number")
    value = float(raw)
    if not math.isfinite(value):
        raise InvalidModelProviderConfigError(f"resilience {name} must be finite")
    lower_ok = value >= minimum if allow_zero else value > minimum
    if not lower_ok or value > maximum:
        qualifier = "between" if allow_zero else "greater than"
        raise InvalidModelProviderConfigError(
            f"resilience {name} must be {qualifier} its configured bounds"
        )
    return value


def _integer(
    raw: object,
    *,
    name: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise InvalidModelProviderConfigError(f"resilience {name} must be an integer")
    if not minimum <= raw <= maximum:
        raise InvalidModelProviderConfigError(
            f"resilience {name} must be between {minimum} and {maximum}"
        )
    return raw


@dataclass(frozen=True)
class ProviderCallScope:
    org_id: str
    purpose: str = "generation"

    def __post_init__(self) -> None:
        if not isinstance(self.org_id, str) or not self.org_id.strip():
            raise InvalidModelProviderConfigError("provider call org_id must be non-blank")
        if not isinstance(self.purpose, str) or not self.purpose.strip():
            raise InvalidModelProviderConfigError("provider call purpose must be non-blank")


@dataclass(frozen=True)
class ResiliencePolicy:
    timeout_seconds: float = 30.0
    failure_threshold: int = 3
    recovery_timeout_seconds: float = 30.0
    fallback_mode: FallbackMode = "fail"
    max_retries: int = 0
    initial_backoff_seconds: float = 0.1
    max_backoff_seconds: float = 1.0

    @classmethod
    def from_options(cls, options: Mapping[str, Any]) -> "ResiliencePolicy":
        raw = options.get("resilience")
        if raw is None:
            return cls()
        if not isinstance(raw, Mapping):
            raise InvalidModelProviderConfigError(
                "generation resilience options must be a JSON object"
            )
        unknown = set(raw) - _POLICY_KEYS
        if unknown:
            raise InvalidModelProviderConfigError(
                "generation resilience options contain unsupported keys"
            )

        fallback_mode = raw.get("fallback_mode", "fail")
        if fallback_mode not in {"retry", "degrade", "fail"}:
            raise InvalidModelProviderConfigError(
                "resilience fallback_mode must be retry, degrade, or fail"
            )
        initial_backoff = _number(
            raw.get("initial_backoff_seconds"),
            name="initial_backoff_seconds",
            default=0.1,
            minimum=0,
            maximum=60,
            allow_zero=True,
        )
        max_backoff = _number(
            raw.get("max_backoff_seconds"),
            name="max_backoff_seconds",
            default=1.0,
            minimum=0,
            maximum=300,
            allow_zero=True,
        )
        if max_backoff < initial_backoff:
            raise InvalidModelProviderConfigError(
                "resilience max_backoff_seconds must not be below initial_backoff_seconds"
            )
        return cls(
            timeout_seconds=_number(
                raw.get("timeout_seconds"),
                name="timeout_seconds",
                default=30,
                minimum=0,
                maximum=300,
            ),
            failure_threshold=_integer(
                raw.get("failure_threshold"),
                name="failure_threshold",
                default=3,
                minimum=1,
                maximum=100,
            ),
            recovery_timeout_seconds=_number(
                raw.get("recovery_timeout_seconds"),
                name="recovery_timeout_seconds",
                default=30,
                minimum=0,
                maximum=3600,
            ),
            fallback_mode=fallback_mode,
            max_retries=_integer(
                raw.get("max_retries"),
                name="max_retries",
                default=0,
                minimum=0,
                maximum=10,
            ),
            initial_backoff_seconds=initial_backoff,
            max_backoff_seconds=max_backoff,
        )


class ProviderCallFailedError(RuntimeError):
    """Sanitized terminal provider failure.

    Raw SDK exceptions are intentionally not attached as a cause or included in the
    message.  Callers may persist the closed enum fields only.
    """

    def __init__(
        self, reason: ProviderFailureReason, fallback_mode: FallbackMode
    ) -> None:
        self.reason = reason
        self.fallback_mode = fallback_mode
        super().__init__(f"model provider call failed ({reason})")


@dataclass(frozen=True)
class _CircuitPermit:
    epoch: int
    probe: bool


class CircuitBreaker:
    def __init__(
        self,
        policy: ResiliencePolicy,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._policy = policy
        self._clock = clock
        self._lock = asyncio.Lock()
        self._state: CircuitState = "closed"
        self._consecutive_failures = 0
        self._opened_at: float | None = None
        self._epoch = 0

    @property
    def state(self) -> CircuitState:
        return self._state

    async def before_call(self) -> _CircuitPermit:
        async with self._lock:
            if self._state == "closed":
                return _CircuitPermit(epoch=self._epoch, probe=False)
            if self._state == "open":
                assert self._opened_at is not None
                if self._clock() - self._opened_at < self._policy.recovery_timeout_seconds:
                    raise ProviderCallFailedError(
                        "circuit_open", self._policy.fallback_mode
                    )
                self._state = "half_open"
                self._epoch += 1
                return _CircuitPermit(epoch=self._epoch, probe=True)
            # A half-open circuit admits exactly one probe. Other calls fail fast.
            raise ProviderCallFailedError("circuit_open", self._policy.fallback_mode)

    async def record_success(self, permit: _CircuitPermit) -> None:
        async with self._lock:
            if permit.epoch != self._epoch:
                return
            if permit.probe and self._state == "half_open":
                self._state = "closed"
                self._opened_at = None
                self._consecutive_failures = 0
                self._epoch += 1
            elif not permit.probe and self._state == "closed":
                self._consecutive_failures = 0

    async def record_failure(self, permit: _CircuitPermit) -> None:
        async with self._lock:
            if permit.epoch != self._epoch:
                return
            if permit.probe and self._state == "half_open":
                self._open()
                return
            if not permit.probe and self._state == "closed":
                self._consecutive_failures += 1
                if self._consecutive_failures >= self._policy.failure_threshold:
                    self._open()

    async def record_cancelled(self, permit: _CircuitPermit) -> None:
        # Normal closed-state cancellation is a worker lifecycle concern, not a
        # provider failure. A cancelled half-open probe must reopen so its exclusive
        # lease cannot strand the circuit forever.
        if not permit.probe:
            return
        async with self._lock:
            if permit.epoch == self._epoch and self._state == "half_open":
                self._open()

    def _open(self) -> None:
        self._state = "open"
        self._opened_at = self._clock()
        self._consecutive_failures = 0
        self._epoch += 1


class ResilientModelProvider:
    def __init__(
        self,
        provider: ModelProvider,
        policy: ResiliencePolicy,
        *,
        breaker: CircuitBreaker | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._provider = provider
        self.policy = policy
        self._breaker = breaker or CircuitBreaker(policy)
        self._sleep = sleep

    async def _invoke(self, operation: Callable[[], Awaitable[_T]]) -> _T:
        attempts = 1 + self.policy.max_retries if self.policy.fallback_mode == "retry" else 1
        terminal_reason: ProviderFailureReason = "provider_error"

        for attempt in range(attempts):
            permit = await self._breaker.before_call()
            try:
                async with asyncio.timeout(self.policy.timeout_seconds):
                    result = await operation()
            except asyncio.CancelledError:
                await self._breaker.record_cancelled(permit)
                raise
            except TimeoutError:
                terminal_reason = "timeout"
                await self._breaker.record_failure(permit)
            except Exception:
                terminal_reason = "provider_error"
                await self._breaker.record_failure(permit)
            else:
                await self._breaker.record_success(permit)
                return result

            if attempt + 1 < attempts:
                backoff = min(
                    self.policy.initial_backoff_seconds * (2**attempt),
                    self.policy.max_backoff_seconds,
                )
                await self._sleep(backoff)

        if self.policy.fallback_mode == "retry":
            terminal_reason = "retry_exhausted"
        raise ProviderCallFailedError(
            terminal_reason, self.policy.fallback_mode
        ) from None

    async def generate(self, request: GenerationRequest) -> GenerationResponse:
        return await self._invoke(lambda: self._provider.generate(request))

    async def generate_structured(
        self, request: GenerationRequest, schema: Mapping[str, Any]
    ) -> StructuredGenerationResponse:
        return await self._invoke(
            lambda: self._provider.generate_structured(request, schema)
        )

    async def aclose(self) -> None:
        await self._provider.aclose()

"""Asynchronous secret-reference resolution for the Python worker fleet."""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from threading import Lock

SecretBackend = Callable[[str], Awaitable[str]]

# Closed production catalog. Keep identical to packages/config and SECRETS.md.
SECRET_NAMES: tuple[str, ...] = (
    "DATABASE_ADMIN_URL",
    "DATABASE_RUNTIME_URL",
    "POSTGRES_PASSWORD",
    "JWT_SIGNING_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "JIRA_OAUTH_CLIENT_SECRET",
    # W3-10: per-org Jira access/refresh tokens now live encrypted in
    # jira_connections (Postgres), resolved through Node's getOrgSecret --
    # JIRA_ACCESS_TOKEN/JIRA_REFRESH_TOKEN are REMOVED from this catalog (kept
    # identical to packages/config; see that file's matching comment).
    "JIRA_TOKEN_ENC_KEY",
    "LINEAR_OAUTH_CLIENT_SECRET",
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_REFRESH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "MCP_TOKEN_PEPPER",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "REDIS_PASSWORD",
    "NEO4J_PASSWORD",
    "NEO4J_AUTH",
)
_SECRET_NAME_SET = frozenset(SECRET_NAMES)

_ENV_REF = re.compile(r"^env://([A-Z_][A-Z0-9_]*)$")
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://")


class InvalidSecretReferenceError(ValueError):
    def __init__(self) -> None:
        super().__init__("Invalid secret reference.")


class UnsupportedSecretSchemeError(ValueError):
    def __init__(self, scheme: str) -> None:
        super().__init__(f"Unsupported secret reference scheme: {scheme}.")


class UnauthorizedSecretReferenceError(ValueError):
    def __init__(self) -> None:
        super().__init__("Secret reference is not authorized.")


class SecretNotFoundError(RuntimeError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Secret {name} is missing.")


class EmptySecretError(RuntimeError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Secret {name} is empty.")


class SecretResolutionError(RuntimeError):
    def __init__(self, name: str) -> None:
        super().__init__(f"Secret {name} could not be resolved.")


def _parse_reference(ref: str) -> tuple[str, str]:
    match = _ENV_REF.fullmatch(ref)
    if match:
        return ref, match.group(1)
    scheme = _SCHEME.match(ref)
    if scheme and scheme.group(1) != "env":
        raise UnsupportedSecretSchemeError(scheme.group(1))
    raise InvalidSecretReferenceError()


async def _environment_backend(ref: str) -> str:
    _, name = _parse_reference(ref)
    value = os.environ.get(name)
    if value is None:
        raise SecretNotFoundError(name)
    if not value.strip():
        raise EmptySecretError(name)
    return value


_backend: SecretBackend = _environment_backend
_cache: dict[str, Future[str]] = {}
_cache_lock = Lock()


def _require_test_environment() -> None:
    if os.environ.get("SAYRE_ENV") != "test":
        raise SecretResolutionError("test helper")


async def _resolve(ref: str, name: str, backend: SecretBackend) -> str:
    sanitized_error: BaseException
    try:
        value = await backend(ref)
        if not value.strip():
            raise EmptySecretError(name)
        return value
    except asyncio.CancelledError:
        sanitized_error = asyncio.CancelledError()
    except SecretNotFoundError:
        sanitized_error = SecretNotFoundError(name)
    except EmptySecretError:
        sanitized_error = EmptySecretError(name)
    except Exception:
        sanitized_error = SecretResolutionError(name)
    raise sanitized_error from None


async def _await_shared_resolution(resolution: Future[str]) -> str:
    # concurrent.futures.Future is not bound to the owner's event loop. Shielding
    # prevents cancellation of one waiter from cancelling the shared resolution.
    return await asyncio.shield(asyncio.wrap_future(resolution))


def _evict_if_current(canonical: str, resolution: Future[str]) -> None:
    with _cache_lock:
        if _cache.get(canonical) is resolution:
            _cache.pop(canonical, None)


async def get_secret(ref: str) -> str:
    """Resolve and cache a strict ``env://NAME`` reference without logging values."""
    canonical, name = _parse_reference(ref)
    if name not in _SECRET_NAME_SET:
        raise UnauthorizedSecretReferenceError

    backend: SecretBackend | None = None
    with _cache_lock:
        resolution = _cache.get(canonical)
        owns_resolution = resolution is None
        if resolution is None:
            resolution = Future()
            _cache[canonical] = resolution
            backend = _backend

    if not owns_resolution:
        return await _await_shared_resolution(resolution)

    assert backend is not None
    try:
        value = await _resolve(canonical, name, backend)
    except asyncio.CancelledError:
        _evict_if_current(canonical, resolution)
        resolution.cancel()
        raise
    except Exception as error:
        _evict_if_current(canonical, resolution)
        resolution.set_exception(error)
        raise
    else:
        resolution.set_result(value)
        return value


def set_secret_backend_for_tests(backend: SecretBackend) -> None:
    _require_test_environment()
    global _backend
    with _cache_lock:
        _backend = backend
        _cache.clear()


def reset_secrets_for_tests() -> None:
    _require_test_environment()
    global _backend
    with _cache_lock:
        _backend = _environment_backend
        _cache.clear()

"""In-memory GitHub App installation authentication for repository fetches."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Protocol
from urllib.parse import urlsplit

import httpx
import jwt

from sayre_workers.config import get_config, get_secret

_APP_ID = re.compile(r"^[1-9][0-9]{0,15}$")
_TOKEN = re.compile(r"^[A-Za-z0-9._~-]+$")
_TOKEN_MAX_BYTES = 2_048
_RESPONSE_MAX_BYTES = 64 * 1_024
_APP_JWT_LIFETIME_SECONDS = 9 * 60
_INSTALLATION_TOKEN_MAX_LIFETIME_SECONDS = 65 * 60
_INSTALLATION_TOKEN_MIN_LIFETIME_SECONDS = 30

SecretLoader = Callable[[str], Awaitable[str]]


class InstallationTokenProvider(Protocol):
    async def mint_token(self, installation_id: int) -> str: ...


class GitHubInstallationAuthError(RuntimeError):
    """Sanitized failure to mint a short-lived GitHub installation token."""


def _validated_api_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise GitHubInstallationAuthError("GitHub API base URL is invalid.")
    path = parsed.path.rstrip("/")
    return f"https://{parsed.netloc}{path}"


def _validated_app_id(value: str) -> str:
    if not _APP_ID.fullmatch(value):
        raise GitHubInstallationAuthError("GitHub App ID is invalid.")
    return value


def _validated_expiry(value: object, now: float) -> None:
    if not isinstance(value, str):
        raise GitHubInstallationAuthError("GitHub returned an invalid installation token.")
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise GitHubInstallationAuthError(
            "GitHub returned an invalid installation token."
        ) from None
    if expiry.tzinfo is None:
        raise GitHubInstallationAuthError("GitHub returned an invalid installation token.")
    lifetime = expiry.astimezone(timezone.utc).timestamp() - now
    if not (
        _INSTALLATION_TOKEN_MIN_LIFETIME_SECONDS
        <= lifetime
        <= _INSTALLATION_TOKEN_MAX_LIFETIME_SECONDS
    ):
        raise GitHubInstallationAuthError("GitHub returned an invalid installation token.")


class GitHubInstallationTokenProvider:
    """Mint one bounded-lifetime credential without persisting or logging it."""

    def __init__(
        self,
        *,
        app_id: str,
        api_base_url: str,
        timeout_seconds: float = 10.0,
        secret_loader: SecretLoader = get_secret,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if timeout_seconds <= 0 or timeout_seconds > 30:
            raise GitHubInstallationAuthError("GitHub token timeout is invalid.")
        self._app_id = _validated_app_id(app_id)
        self._api_base_url = _validated_api_base_url(api_base_url)
        self._timeout_seconds = timeout_seconds
        self._secret_loader = secret_loader
        self._transport = transport
        self._clock = clock

    @classmethod
    def from_config(cls) -> GitHubInstallationTokenProvider:
        return cls(
            app_id=get_config("GITHUB_APP_ID"),
            api_base_url=get_config("GITHUB_API_BASE_URL"),
        )

    def _app_jwt(self, private_key: str, now: int) -> str:
        try:
            encoded = jwt.encode(
                {
                    "iat": now - 60,
                    "exp": now + _APP_JWT_LIFETIME_SECONDS,
                    "iss": self._app_id,
                },
                private_key,
                algorithm="RS256",
            )
        except Exception:
            raise GitHubInstallationAuthError("GitHub App authentication failed.") from None
        if not isinstance(encoded, str) or not encoded:
            raise GitHubInstallationAuthError("GitHub App authentication failed.")
        return encoded

    async def mint_token(self, installation_id: int) -> str:
        if (
            isinstance(installation_id, bool)
            or not isinstance(installation_id, int)
            or not 1 <= installation_id <= 9_007_199_254_740_991
        ):
            raise GitHubInstallationAuthError("GitHub installation ID is invalid.")

        try:
            async with asyncio.timeout(self._timeout_seconds):
                private_key = await self._secret_loader("env://GITHUB_APP_PRIVATE_KEY")
                now = self._clock()
                app_jwt = self._app_jwt(private_key, int(now))
                async with httpx.AsyncClient(
                    base_url=self._api_base_url,
                    timeout=httpx.Timeout(self._timeout_seconds),
                    follow_redirects=False,
                    trust_env=False,
                    transport=self._transport,
                    headers={
                        "Accept": "application/vnd.github+json",
                        "Authorization": f"Bearer {app_jwt}",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                ) as client:
                    async with client.stream(
                        "POST",
                        f"/app/installations/{installation_id}/access_tokens",
                    ) as response:
                        if response.status_code != 201:
                            raise GitHubInstallationAuthError(
                                "GitHub installation token request was rejected "
                                f"(status {response.status_code})."
                            )
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > _RESPONSE_MAX_BYTES:
                                raise GitHubInstallationAuthError(
                                    "GitHub returned an invalid installation token."
                                )
        except TimeoutError:
            raise GitHubInstallationAuthError(
                "GitHub installation token request timed out."
            ) from None
        except GitHubInstallationAuthError:
            raise
        except httpx.TimeoutException:
            raise GitHubInstallationAuthError(
                "GitHub installation token request timed out."
            ) from None
        except httpx.HTTPError:
            raise GitHubInstallationAuthError(
                "GitHub installation token request failed."
            ) from None
        except Exception:
            raise GitHubInstallationAuthError("GitHub App authentication failed.") from None

        try:
            body = json.loads(content)
        except (UnicodeDecodeError, ValueError):
            raise GitHubInstallationAuthError(
                "GitHub returned an invalid installation token."
            ) from None
        if not isinstance(body, dict):
            raise GitHubInstallationAuthError("GitHub returned an invalid installation token.")
        token = body.get("token")
        if (
            not isinstance(token, str)
            or not token
            or token != token.strip()
            or not _TOKEN.fullmatch(token)
            or len(token.encode("utf-8")) > _TOKEN_MAX_BYTES
        ):
            raise GitHubInstallationAuthError("GitHub returned an invalid installation token.")
        _validated_expiry(body.get("expires_at"), now)
        return token

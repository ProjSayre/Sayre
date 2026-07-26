from __future__ import annotations

import asyncio
import base64
import subprocess
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from sayre_workers.ingestion import github_installation
from sayre_workers.ingestion.github_installation import (
    GitHubInstallationAuthError,
    GitHubInstallationTokenProvider,
)
from sayre_workers.ingestion.models import RepositoryLocator
from sayre_workers.ingestion.repository import (
    GitCommandError,
    GitRepositorySource,
    _GitRunner,
    _git_http_auth_environment,
    _sanitized_git_environment,
)

SHA = "a" * 40
INSTALLATION_TOKEN = "ghs_private_installation_token"
APP_PRIVATE_KEY = "private-key-material-that-must-never-escape"
APP_JWT = "signed.app.jwt"
NOW = 1_800_000_000.0


def _expires_at(seconds: int = 3_600) -> str:
    return datetime.fromtimestamp(NOW + seconds, timezone.utc).isoformat().replace("+00:00", "Z")


async def _secret_loader(reference: str) -> str:
    assert reference == "env://GITHUB_APP_PRIVATE_KEY"
    return APP_PRIVATE_KEY


def _provider(
    monkeypatch: pytest.MonkeyPatch,
    handler: httpx.AsyncBaseTransport,
    *,
    timeout_seconds: float = 1.0,
) -> GitHubInstallationTokenProvider:
    def encode(payload: dict[str, object], key: str, *, algorithm: str) -> str:
        assert payload == {
            "iat": int(NOW) - 60,
            "exp": int(NOW) + 9 * 60,
            "iss": "12345",
        }
        assert key == APP_PRIVATE_KEY
        assert algorithm == "RS256"
        return APP_JWT

    monkeypatch.setattr(github_installation.jwt, "encode", encode)
    return GitHubInstallationTokenProvider(
        app_id="12345",
        api_base_url="https://api.github.test",
        timeout_seconds=timeout_seconds,
        secret_loader=_secret_loader,
        transport=handler,
        clock=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_token_provider_uses_loader_and_bounded_no_redirect_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            201,
            json={"token": INSTALLATION_TOKEN, "expires_at": _expires_at()},
        )

    provider = _provider(monkeypatch, httpx.MockTransport(respond))

    assert await provider.mint_token(555) == INSTALLATION_TOKEN
    assert len(requests) == 1
    assert requests[0].method == "POST"
    assert str(requests[0].url) == (
        "https://api.github.test/app/installations/555/access_tokens"
    )
    assert requests[0].headers["authorization"] == f"Bearer {APP_JWT}"


@pytest.mark.asyncio
async def test_token_provider_does_not_follow_redirects_or_echo_secret_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            302,
            headers={"location": f"https://attacker.invalid/{INSTALLATION_TOKEN}"},
            text=f"{APP_PRIVATE_KEY}:{INSTALLATION_TOKEN}",
        )

    provider = _provider(monkeypatch, httpx.MockTransport(redirect))

    with pytest.raises(GitHubInstallationAuthError, match=r"status 302") as caught:
        await provider.mint_token(555)

    assert len(requests) == 1
    assert APP_PRIVATE_KEY not in str(caught.value)
    assert INSTALLATION_TOKEN not in str(caught.value)


@pytest.mark.asyncio
async def test_token_provider_sanitizes_timeout_and_unauthorized_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def slow(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.1)
        return httpx.Response(201, json={})

    timeout_provider = _provider(
        monkeypatch,
        httpx.MockTransport(slow),
        timeout_seconds=0.01,
    )
    with pytest.raises(GitHubInstallationAuthError, match="timed out") as timeout:
        await timeout_provider.mint_token(555)
    assert APP_PRIVATE_KEY not in str(timeout.value)

    def unauthorized(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            text=f"{APP_PRIVATE_KEY}:{INSTALLATION_TOKEN}",
        )

    unauthorized_provider = _provider(monkeypatch, httpx.MockTransport(unauthorized))
    with pytest.raises(GitHubInstallationAuthError, match=r"status 401") as unauthorized_error:
        await unauthorized_provider.mint_token(555)
    assert APP_PRIVATE_KEY not in str(unauthorized_error.value)
    assert INSTALLATION_TOKEN not in str(unauthorized_error.value)


class _FixedTokenProvider:
    def __init__(self, token: str = INSTALLATION_TOKEN) -> None:
        self.token = token
        self.installation_ids: list[int] = []

    async def mint_token(self, installation_id: int) -> str:
        self.installation_ids.append(installation_id)
        return self.token


def test_git_environment_uses_non_secret_central_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", "approved-tool-path")
    monkeypatch.setenv("DATABASE_RUNTIME_URL", "database-secret-that-must-not-escape")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", APP_PRIVATE_KEY)
    monkeypatch.setenv("GIT_TRACE", "trace-target")

    environment = _sanitized_git_environment()

    assert environment["PATH"] == "approved-tool-path"
    assert environment["GIT_CONFIG_NOSYSTEM"] == "1"
    assert "DATABASE_RUNTIME_URL" not in environment
    assert "GITHUB_APP_PRIVATE_KEY" not in environment
    assert "GIT_TRACE" not in environment
    assert APP_PRIVATE_KEY not in environment.values()


class _RecordingGitRunner:
    instances: list[_RecordingGitRunner] = []

    def __init__(self, repository_path: Path, *, timeout_seconds: float = 60.0) -> None:
        del timeout_seconds
        self.repository_path = repository_path
        self.calls: list[tuple[tuple[str, ...], Mapping[str, str] | None]] = []
        self.__class__.instances.append(self)

    async def run(
        self,
        *arguments: str,
        check: bool = True,
        environment: Mapping[str, str] | None = None,
    ) -> bytes:
        del check
        self.calls.append((arguments, environment))
        return f"{SHA}\n".encode() if arguments[:1] == ("rev-parse",) else b""

    async def succeeds(self, *arguments: str) -> bool:
        self.calls.append((arguments, None))
        return True


@pytest.mark.asyncio
async def test_checkout_scopes_auth_to_fetch_environment_and_cleans_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RecordingGitRunner.instances.clear()
    monkeypatch.setattr(
        "sayre_workers.ingestion.repository._GitRunner",
        _RecordingGitRunner,
    )
    token_provider = _FixedTokenProvider()
    source = GitRepositorySource(token_provider=token_provider)
    locator = RepositoryLocator(
        provider="github",
        provider_repo_id="42",
        full_name="acme/widgets",
        installation_id=555,
    )

    async with source.checkout(locator, "refs/heads/main", SHA, None) as snapshot:
        scratch = snapshot.scratch_root
        assert scratch.exists()

    assert not scratch.exists()
    assert token_provider.installation_ids == [555]
    calls = _RecordingGitRunner.instances[0].calls
    encoded_token = base64.b64encode(
        f"x-access-token:{INSTALLATION_TOKEN}".encode()
    ).decode()
    for arguments, _environment in calls:
        rendered = "\0".join(arguments)
        assert INSTALLATION_TOKEN not in rendered
        assert encoded_token not in rendered

    fetch_calls = [call for call in calls if call[0][:1] == ("fetch",)]
    assert len(fetch_calls) == 1
    auth_environment = fetch_calls[0][1]
    assert auth_environment is not None
    assert auth_environment["GIT_CONFIG_VALUE_0"] == f"Authorization: Basic {encoded_token}"
    assert auth_environment["GIT_CONFIG_VALUE_1"] == "false"
    assert auth_environment["GIT_CONFIG_VALUE_2"] == ""
    assert all(
        environment is None
        for arguments, environment in calls
        if arguments[:1] not in {("fetch",)}
    )


@pytest.mark.asyncio
async def test_ephemeral_header_is_not_written_to_git_config(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    subprocess.run(["git", "init", "--quiet", str(repository)], check=True)
    runner = _GitRunner(repository)
    await runner.run(
        "remote",
        "add",
        "origin",
        "https://github.com/acme/widgets.git",
    )

    config = (repository / ".git" / "config").read_text(encoding="utf-8")
    auth_environment = _git_http_auth_environment(INSTALLATION_TOKEN)
    encoded_token = base64.b64encode(
        f"x-access-token:{INSTALLATION_TOKEN}".encode()
    ).decode()

    assert INSTALLATION_TOKEN not in config
    assert encoded_token not in config
    assert "extraheader" not in config.lower()
    assert auth_environment["GIT_CONFIG_VALUE_0"].endswith(encoded_token)


@pytest.mark.asyncio
async def test_auth_failure_still_destroys_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RecordingGitRunner.instances.clear()
    monkeypatch.setattr(
        "sayre_workers.ingestion.repository._GitRunner",
        _RecordingGitRunner,
    )

    class FailingTokenProvider:
        async def mint_token(self, _installation_id: int) -> str:
            raise GitHubInstallationAuthError("GitHub App authentication failed.")

    source = GitRepositorySource(token_provider=FailingTokenProvider())
    locator = RepositoryLocator(
        provider="github",
        provider_repo_id="42",
        full_name="acme/widgets",
        installation_id=555,
    )

    with pytest.raises(GitHubInstallationAuthError, match="authentication failed"):
        async with source.checkout(locator, "refs/heads/main", SHA, None):
            raise AssertionError("checkout must not be yielded")

    scratch = _RecordingGitRunner.instances[0].repository_path.parent
    assert not scratch.exists()


@pytest.mark.asyncio
async def test_github_checkout_without_installation_auth_fails_closed_and_cleans_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _RecordingGitRunner.instances.clear()
    monkeypatch.setattr(
        "sayre_workers.ingestion.repository._GitRunner",
        _RecordingGitRunner,
    )
    source = GitRepositorySource()
    locator = RepositoryLocator(
        provider="github",
        provider_repo_id="42",
        full_name="acme/widgets",
    )

    with pytest.raises(GitCommandError, match="authentication is unavailable"):
        async with source.checkout(locator, "refs/heads/main", SHA, None):
            raise AssertionError("checkout must not be yielded")

    scratch = _RecordingGitRunner.instances[0].repository_path.parent
    assert not scratch.exists()

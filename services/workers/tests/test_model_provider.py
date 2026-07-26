from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from anthropic import AsyncAnthropic

from sayre_workers.enrichment.config_store import PostgresGenerationConfigStore
from sayre_workers.enrichment.graphify_adapter import (
    BaseGraphifyAdapter,
    GraphifyAdapterFactory,
)
from sayre_workers.enrichment.models import (
    EnrichmentContext,
    EnrichmentWrite,
    FileContext,
)
from sayre_workers.enrichment.service import EnrichmentService
from sayre_workers.enrichment.state_store import ProviderJobState
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.ingestion.projection import stable_uid
from sayre_workers.model_provider import (
    AnthropicModelProvider,
    GenerationConfig,
    GenerationRequest,
    InvalidGenerationRequestError,
    InvalidModelProviderConfigError,
    ModelProviderFactory,
    ModelProviderResponseError,
    OpenAICompatibleModelProvider,
    ProviderCallScope,
)

SHA = "b" * 40


def _semantic_payload() -> dict[str, Any]:
    return {
        "nodes": [
            {
                "id": "authentication",
                "label": "Feature",
                "properties": {
                    "name": "Authentication",
                    "description": "Signs users in.",
                    "team": "Identity",
                },
            }
        ],
        "edges": [
            {
                "source": "src/auth.py",
                "target": "authentication",
                "relationship": "PART_OF",
            }
        ],
    }


def _context() -> EnrichmentContext:
    scope = GraphScope("org-real", "repo-1", "refs/heads/main", SHA)
    return EnrichmentContext(
        scope=scope,
        files=(
            FileContext(
                uid=stable_uid(scope, "File", "src/auth.py"),
                path="src/auth.py",
                language="python",
            ),
        ),
    )


@pytest.mark.asyncio
async def test_postgres_config_store_preserves_json_options_and_generation_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    options = {"temperature": 0.2, "vendor_extension": {"enabled": True}}
    statements: list[tuple[str, tuple[str, ...]]] = []

    class Cursor:
        async def fetchone(self) -> dict[str, Any]:
            return {
                "provider": "openai_compatible",
                "model": "local-fixture",
                "endpoint_url": "http://localhost:11434/v1",
                "credential_ref": None,
                "config": options,
            }

    class Connection:
        async def __aenter__(self) -> Connection:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

        async def execute(self, statement: str, params: tuple[str, ...]) -> Cursor:
            statements.append((statement, params))
            return Cursor()

    store = PostgresGenerationConfigStore("postgresql://not-used")

    @asynccontextmanager
    async def connect(org_id: str):
        assert org_id == "org-real"
        yield Connection()

    monkeypatch.setattr(store, "_connect", connect)

    config = await store.load_generation_config("org-real")

    assert config == GenerationConfig(
        provider="openai_compatible",
        model="local-fixture",
        endpoint_url="http://localhost:11434/v1",
        credential_ref=None,
        options=options,
    )
    assert config.options is not options
    assert len(statements) == 1
    statement, params = statements[0]
    assert "WHERE org_id = %s AND purpose = 'generation'" in statement
    assert params == ("org-real",)


@pytest.mark.asyncio
async def test_generation_config_store_reads_fresh_settings_for_each_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        {
            "provider": "anthropic",
            "model": "claude-first",
            "endpoint_url": None,
            "credential_ref": "env://ANTHROPIC_API_KEY",
            "config": {},
        },
        {
            "provider": "openai",
            "model": "gpt-next",
            "endpoint_url": None,
            "credential_ref": "env://OPENAI_API_KEY",
            "config": {},
        },
    ]
    queries: list[tuple[str, tuple[str, ...]]] = []

    class Cursor:
        def __init__(self, row: dict[str, Any]) -> None:
            self._row = row

        async def fetchone(self) -> dict[str, Any]:
            return self._row

    class Connection:
        async def __aenter__(self) -> Connection:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

        async def execute(self, statement: str, params: tuple[str, ...]) -> Cursor:
            queries.append((statement, params))
            return Cursor(rows.pop(0))

    store = PostgresGenerationConfigStore("postgresql://not-used")

    @asynccontextmanager
    async def connect(org_id: str):
        assert org_id == "org-real"
        yield Connection()

    monkeypatch.setattr(store, "_connect", connect)

    first = await store.load_generation_config("org-real")
    second = await store.load_generation_config("org-real")

    assert first is not None and first.model == "claude-first"
    assert second is not None and second.model == "gpt-next"
    assert len(queries) == 2
    assert all(
        "WHERE org_id = %s AND purpose = 'generation'" in statement
        and params == ("org-real",)
        for statement, params in queries
    )


@pytest.mark.asyncio
async def test_anthropic_adapter_uses_real_sdk_contract_for_plain_and_structured_output() -> None:
    captured: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured.append(body)
        if body.get("tools"):
            content = [
                {
                    "type": "tool_use",
                    "id": "toolu_fixture",
                    "name": "emit_structured_output",
                    "input": _semantic_payload(),
                }
            ]
            stop_reason = "tool_use"
        else:
            content = [{"type": "text", "text": "fixture answer"}]
            stop_reason = "end_turn"
        return httpx.Response(
            200,
            request=request,
            json={
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "model": "claude-fixture",
                "content": content,
                "stop_reason": stop_reason,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 10},
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncAnthropic(
        api_key="test-only",
        base_url="https://anthropic.invalid",
        http_client=http_client,
    )
    provider = AnthropicModelProvider(client, "claude-fixture")
    request = GenerationRequest(system="Return an answer.", input="fixture")
    try:
        plain = await provider.generate(request)
        structured = await provider.generate_structured(
            request, BaseGraphifyAdapter().schema(_context())
        )
    finally:
        await client.close()

    assert plain.text == "fixture answer"
    write = await BaseGraphifyAdapter().shape(_context(), structured)
    assert len(write.nodes) == 1
    assert len(write.edges) == 1
    assert captured[1]["tool_choice"] == {
        "type": "tool",
        "name": "emit_structured_output",
    }
    assert captured[1]["tools"][0]["input_schema"]["additionalProperties"] is False


class _FakeCompletions:
    def __init__(self, contents: list[str | None]) -> None:
        self._contents = contents
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        content = self._contents.pop(0)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


def _fake_openai_client(contents: list[str | None]) -> Any:
    completions = _FakeCompletions(contents)
    return SimpleNamespace(
        chat=SimpleNamespace(completions=completions),
        completions_fixture=completions,
    )


@pytest.mark.asyncio
async def test_openai_compatible_adapter_supports_plain_and_structured_calls() -> None:
    client = _fake_openai_client(["plain answer", json.dumps(_semantic_payload())])
    provider = OpenAICompatibleModelProvider(
        client,
        "local-fixture",
        options={"reasoning_effort": "none"},
    )
    request = GenerationRequest(
        system="Return an answer.",
        input="fixture",
        max_output_tokens=321,
        temperature=0.25,
    )

    plain = await provider.generate(request)
    structured = await provider.generate_structured(
        request, BaseGraphifyAdapter().schema(_context())
    )

    assert plain.text == "plain answer"
    assert structured.data == _semantic_payload()
    first, second = client.completions_fixture.calls
    assert first["model"] == "local-fixture"
    assert first["max_tokens"] == 321
    assert first["temperature"] == 0.25
    assert first["reasoning_effort"] == "none"
    assert "response_format" not in first
    assert second["reasoning_effort"] == "none"
    assert second["response_format"]["type"] == "json_schema"
    assert second["response_format"]["json_schema"]["strict"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("reasoning_effort", ["", "off", 0, True])
async def test_openai_compatible_adapter_rejects_invalid_reasoning_effort(
    reasoning_effort: object,
) -> None:
    client = _fake_openai_client(["unused"])
    provider = OpenAICompatibleModelProvider(
        client,
        "local-fixture",
        options={"reasoning_effort": reasoning_effort},
    )

    with pytest.raises(InvalidModelProviderConfigError, match="reasoning_effort"):
        await provider.generate(GenerationRequest(system="system", input="input"))

    assert client.completions_fixture.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content, message",
    [
        (None, "no text"),
        ("not-json", "valid structured JSON"),
        ("[]", "must be an object"),
    ],
)
async def test_openai_compatible_adapter_rejects_invalid_structured_output(
    content: str | None, message: str
) -> None:
    client = _fake_openai_client([content])
    provider = OpenAICompatibleModelProvider(client, "local-fixture")

    with pytest.raises(ModelProviderResponseError, match=message):
        await provider.generate_structured(
            GenerationRequest(system="system", input="input"),
            BaseGraphifyAdapter().schema(_context()),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "generation_request",
    [
        GenerationRequest(system="", input="input"),
        GenerationRequest(system="system", input=""),
        GenerationRequest(system="system", input="input", max_output_tokens=0),
        GenerationRequest(system="system", input="input", max_output_tokens=65_537),
        GenerationRequest(system="system", input="input", temperature=-0.1),
        GenerationRequest(system="system", input="input", temperature=2.1),
    ],
)
async def test_generation_request_validation_happens_before_sdk_call(
    generation_request: GenerationRequest,
) -> None:
    client = _fake_openai_client(["unused"])
    provider = OpenAICompatibleModelProvider(client, "local-fixture")

    with pytest.raises(InvalidGenerationRequestError):
        await provider.generate(generation_request)

    assert client.completions_fixture.calls == []


@pytest.mark.asyncio
async def test_concrete_construction_resolves_only_credential_references(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolved: list[str] = []
    anthropic_args: list[dict[str, Any]] = []
    openai_args: list[dict[str, Any]] = []

    async def resolve(reference: str) -> str:
        resolved.append(reference)
        return "resolved-secret-value"

    monkeypatch.setattr(
        "sayre_workers.model_provider.anthropic_adapter.get_secret", resolve
    )
    monkeypatch.setattr(
        "sayre_workers.model_provider.openai_compatible_adapter.get_secret", resolve
    )
    monkeypatch.setattr(
        "sayre_workers.model_provider.anthropic_adapter.AsyncAnthropic",
        lambda **kwargs: anthropic_args.append(kwargs) or SimpleNamespace(),
    )
    monkeypatch.setattr(
        "sayre_workers.model_provider.openai_compatible_adapter.AsyncOpenAI",
        lambda **kwargs: openai_args.append(kwargs) or SimpleNamespace(),
    )

    await AnthropicModelProvider.from_config(
        GenerationConfig(
            provider="anthropic",
            model="claude-fixture",
            credential_ref="env://ANTHROPIC_API_KEY",
        )
    )
    await OpenAICompatibleModelProvider.from_config(
        GenerationConfig(
            provider="openai",
            model="gpt-fixture",
            credential_ref="env://OPENAI_API_KEY",
        )
    )

    assert resolved == ["env://ANTHROPIC_API_KEY", "env://OPENAI_API_KEY"]
    assert anthropic_args == [{"api_key": "resolved-secret-value"}]
    assert openai_args == [{"api_key": "resolved-secret-value"}]


@pytest.mark.asyncio
async def test_self_hosted_construction_uses_exact_endpoint_without_secret_or_redirect_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def unexpected_secret(_reference: str) -> str:
        raise AssertionError("credential loader must not run without a reference")

    monkeypatch.setattr(
        "sayre_workers.model_provider.openai_compatible_adapter.get_secret",
        unexpected_secret,
    )
    monkeypatch.setattr(
        "sayre_workers.model_provider.openai_compatible_adapter.DefaultAsyncHttpxClient",
        lambda **kwargs: ("http-client", kwargs),
    )
    monkeypatch.setattr(
        "sayre_workers.model_provider.openai_compatible_adapter.AsyncOpenAI",
        lambda **kwargs: calls.append(kwargs) or SimpleNamespace(),
    )

    await OpenAICompatibleModelProvider.from_config(
        GenerationConfig(
            provider="openai_compatible",
            model="local-fixture",
            endpoint_url="http://127.0.0.1:11434/v1",
        )
    )

    assert calls == [
        {
            "api_key": "local-endpoint-no-key",
            "base_url": "http://127.0.0.1:11434/v1",
            "http_client": (
                "http-client",
                {
                    "trust_env": False,
                    "follow_redirects": False,
                },
            ),
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config, message",
    [
        (
            GenerationConfig(provider="anthropic", model="claude"),
            "credential reference",
        ),
        (
            GenerationConfig(
                provider="anthropic",
                model="claude",
                credential_ref="env://ANTHROPIC_API_KEY",
                endpoint_url="https://proxy.invalid",
            ),
            "custom endpoint",
        ),
        (
            GenerationConfig(provider="openai", model="gpt"),
            "credential reference",
        ),
        (
            GenerationConfig(
                provider="openai_compatible",
                model="local",
                endpoint_url=None,
            ),
            "explicit endpoint",
        ),
        (
            GenerationConfig(
                provider="openai_compatible",
                model="local",
                endpoint_url="file:///tmp/model",
            ),
            "absolute HTTP",
        ),
        (
            GenerationConfig(
                provider="openai_compatible",
                model="local",
                endpoint_url="http://user:password@localhost:8000/v1",
            ),
            "without credentials",
        ),
    ],
)
async def test_provider_config_rejects_unsafe_or_incomplete_shapes(
    config: GenerationConfig, message: str
) -> None:
    with pytest.raises(InvalidModelProviderConfigError, match=message):
        await ModelProviderFactory().create(config, ProviderCallScope("org-real"))


class _MemoryGraphStore:
    def __init__(self, context: EnrichmentContext) -> None:
        self._context = context
        self.applied: list[EnrichmentWrite] = []

    async def is_current(self, scope: GraphScope) -> bool:
        return scope == self._context.scope

    async def load_context(
        self,
        scope: GraphScope,
        changed_paths: tuple[str, ...],
        full_rebuild: bool,
    ) -> EnrichmentContext:
        del changed_paths, full_rebuild
        assert scope == self._context.scope
        return self._context

    async def apply(self, write: EnrichmentWrite) -> None:
        self.applied.append(write)

    async def apply_feature_projection(self, write: EnrichmentWrite) -> bool:
        self.applied.append(write)
        return True


class _MemoryConfigStore:
    def __init__(self, config: GenerationConfig) -> None:
        self._config = config
        self.org_ids: list[str] = []

    async def load_generation_config(self, org_id: str) -> GenerationConfig:
        self.org_ids.append(org_id)
        return self._config


class _MemoryStateStore:
    def __init__(self) -> None:
        self.states: list[ProviderJobState] = []

    async def set_state(self, state: ProviderJobState) -> None:
        self.states.append(state)


def _graph_updated_envelope(context: EnrichmentContext):
    from messaging.envelope import MessageEnvelope

    scope = context.scope
    return MessageEnvelope(
        org_id=scope.org_id,
        type="graph.updated",
        source="ingestion-worker",
        idempotency_key="w3-07-isolation-fixture",
        graph_scope_key="w3-07-scope",
        graph_version=1,
        payload={
            "repository_id": scope.repository_id,
            "ref_name": scope.ref_name,
            "revision_sha": scope.revision_sha,
            "full_rebuild": True,
            "changed_paths": [],
        },
    )


@pytest.mark.asyncio
async def test_self_hosted_enrichment_completes_with_non_loopback_network_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Release-blocking structural data-sovereignty verification for W3-07."""
    requests: list[dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            length = int(self.headers.get("Content-Length", "0"))
            requests.append(json.loads(self.rfile.read(length)))
            body = json.dumps(
                {
                    "id": "chatcmpl-local",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "local-fixture",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(_semantic_payload()),
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 10,
                        "total_tokens": 20,
                    },
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *args: object) -> None:
            del args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    blocked: list[str] = []
    connected: list[str] = []
    resolved: list[str] = []
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_getaddrinfo = socket.getaddrinfo

    def checked_host(raw_host: object) -> str:
        host = raw_host.decode() if isinstance(raw_host, bytes) else str(raw_host)
        if host.lower() == "localhost":
            return host
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            blocked.append(host)
            raise OSError("network-isolated test blocked DNS hostname")
        if not address.is_loopback:
            blocked.append(host)
            raise OSError("network-isolated test blocked non-loopback address")
        return host

    def guarded_connect(sock: socket.socket, address: Any) -> Any:
        host = checked_host(address[0])
        connected.append(host)
        return real_connect(sock, address)

    def guarded_connect_ex(sock: socket.socket, address: Any) -> Any:
        host = checked_host(address[0])
        connected.append(host)
        return real_connect_ex(sock, address)

    def guarded_getaddrinfo(host: object, *args: Any, **kwargs: Any) -> Any:
        checked = checked_host(host)
        resolved.append(checked.lower())
        return real_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    monkeypatch.setenv("SAYRE_ENV", "production")

    context = _context()
    graph_store = _MemoryGraphStore(context)
    config_store = _MemoryConfigStore(
        GenerationConfig(
            provider="openai_compatible",
            model="local-fixture",
            endpoint_url=f"http://localhost:{server.server_port}/v1",
        )
    )
    service = EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=GraphifyAdapterFactory(),
        config_store=config_store,
        state_store=_MemoryStateStore(),
    )

    try:
        result = await service.handle(_graph_updated_envelope(context))
    finally:
        await service.aclose()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert result.status == "written"
    assert result.node_count == 1
    assert result.edge_count == 1
    assert config_store.org_ids == ["org-real"]
    assert len(graph_store.applied) == 1
    assert requests[0]["model"] == "local-fixture"
    assert requests[0]["response_format"]["type"] == "json_schema"
    # The actual captured HTTP request proves a connection completed.  Requiring a
    # localhost resolution ensures any accidental SDK fallback to a vendor hostname
    # would hit the guard above and fail before it could connect.
    assert "localhost" in resolved
    assert blocked == []


@pytest.mark.asyncio
async def test_unresponsive_loopback_provider_degrades_within_application_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()

    class SlowHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            started.set()
            release.wait(timeout=1)

        def log_message(self, _format: str, *args: object) -> None:
            del args

    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("SAYRE_ENV", "production")
    context = _context()
    graph_store = _MemoryGraphStore(context)
    state_store = _MemoryStateStore()
    service = EnrichmentService(
        graph_store=graph_store,
        model_provider_factory=ModelProviderFactory(),
        graphify_factory=GraphifyAdapterFactory(),
        config_store=_MemoryConfigStore(
            GenerationConfig(
                provider="openai_compatible",
                model="local-fixture",
                endpoint_url=f"http://127.0.0.1:{server.server_port}/v1",
                options={
                    "resilience": {
                        "timeout_seconds": 0.05,
                        "failure_threshold": 1,
                        "fallback_mode": "degrade",
                    }
                },
            )
        ),
        state_store=state_store,
    )

    began = time.monotonic()
    try:
        result = await service.handle(_graph_updated_envelope(context))
        elapsed = time.monotonic() - began
    finally:
        await service.aclose()
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert started.is_set(), "the real loopback endpoint must receive the SDK request"
    assert elapsed < 0.5, "application timeout must beat the unresponsive endpoint"
    assert result.status == "degraded"
    assert graph_store.applied == []
    assert [(state.status, state.reason_code) for state in state_store.states] == [
        ("generating", None),
        ("degraded", "timeout"),
    ]

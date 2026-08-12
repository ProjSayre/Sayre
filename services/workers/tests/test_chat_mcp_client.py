"""CH-04 red suite — MCP protocol conformance for the hand-written streamable-HTTP
client, measured against an in-process HTTP server that replays Core's exact
`POST /mcp` wire protocol (stateless, `enableJsonResponse: true`) with real
bearer auth.

Authored by `red` from .pipeline/spec.md BEFORE any implementation exists.

`FakeMcpGateway` below is deliberately exported: tests/test_chat_turn_consumer.py
reuses it so AC-1's end-to-end case runs against a real HTTP round trip rather
than a mocked client (the same cross-test-module reuse
tests/test_graph_migrations_audit.py already does).
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
import pytest

from sayre_workers.chat.mcp_client import (
    MCP_CLIENT_INFO,
    MCP_PROTOCOL_VERSION,
    McpToolDescriptor,
    McpToolResult,
    McpTransportError,
    McpUnauthorizedError,
    StreamableHttpMcpClient,
)

TOKEN = "mcp_eph_abcd1234.ZZZ-one-time-secret-value-never-logged"

# The ten tools `createMcpGatewayRouter` already advertises. CH-04 adds none.
MCP_TOOL_CATALOGUE: tuple[dict[str, Any], ...] = (
    {
        "name": "find_relevant_nodes",
        "description": "Find authorized Folder/File nodes relevant to a query.",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "traverse_from",
        "description": "Traverse an authorized bounded neighborhood.",
        "inputSchema": {
            "type": "object",
            "properties": {"node_id": {"type": "string"}, "intent": {"type": "string"}},
            "required": ["node_id", "intent"],
        },
    },
    *(
        {
            "name": name,
            "description": f"Authorized {name} lookup.",
            "inputSchema": {
                "type": "object",
                "properties": {"node_id": {"type": "string"}},
                "required": ["node_id"],
            },
        }
        for name in (
            "get_node_context",
            "get_agent_skill_md",
            "get_style_rules",
            "get_covering_tests",
            "get_feature_cluster",
            "get_recent_changes",
            "check_liveness",
        )
    ),
    {
        "name": "get_ready_tickets",
        "description": "List authorized ready tickets. Takes no arguments.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
)


@dataclass
class RecordedRequest:
    path: str
    headers: dict[str, str]
    body: Any = None

    @property
    def method(self) -> str | None:
        return self.body.get("method") if isinstance(self.body, dict) else None


class _McpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        """Keep pytest output clean."""

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            body = None
        gateway: FakeMcpGateway = self.server.gateway  # type: ignore[attr-defined]
        gateway.requests.append(
            RecordedRequest(
                path=self.path,
                headers={key.lower(): value for key, value in self.headers.items()},
                body=body,
            )
        )
        status, content_type, payload = gateway.respond(
            self.headers.get("Authorization"), body
        )
        encoded = payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


class FakeMcpGateway:
    """A real HTTP server that answers exactly like Core's MCP gateway."""

    def __init__(
        self,
        *,
        token: str = TOKEN,
        tools: tuple[dict[str, Any], ...] = MCP_TOOL_CATALOGUE,
    ) -> None:
        self.token = token
        self.tools = [dict(tool) for tool in tools]
        self.requests: list[RecordedRequest] = []
        self.tool_data: dict[str, Any] = {}
        self.tool_errors: set[str] = set()
        self.content_type = "application/json"
        self.force_status: int | None = None
        self.force_body: str = ""
        self.force_jsonrpc_error = False
        self.unauthorized_after_tool_calls: int | None = None
        self._tool_call_count = 0
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _McpHandler)
        self._server.daemon_threads = True
        self._server.gateway = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    # -- lifecycle ---------------------------------------------------------
    def __enter__(self) -> "FakeMcpGateway":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/mcp"

    # -- inspection --------------------------------------------------------
    def methods(self) -> list[str | None]:
        return [request.method for request in self.requests]

    def tool_calls(self) -> list[tuple[str, dict[str, Any]]]:
        calls: list[tuple[str, dict[str, Any]]] = []
        for request in self.requests:
            if request.method != "tools/call":
                continue
            params = request.body.get("params", {})
            calls.append((params.get("name"), params.get("arguments", {})))
        return calls

    def authorizations(self) -> list[str | None]:
        return [request.headers.get("authorization") for request in self.requests]

    # -- responses ---------------------------------------------------------
    def _frame(self, body: Any, result: Any) -> str:
        message = {
            "jsonrpc": "2.0",
            "id": body.get("id") if isinstance(body, dict) else None,
            "result": result,
        }
        encoded = json.dumps(message)
        if self.content_type.startswith("text/event-stream"):
            return f"event: message\ndata: {encoded}\n\n"
        return encoded

    def respond(self, authorization: str | None, body: Any) -> tuple[int, str, str]:
        if self.force_status is not None:
            return self.force_status, "application/json", self.force_body
        if authorization != f"Bearer {self.token}":
            return 401, "application/json", json.dumps({"error": "unauthorized"})

        method = body.get("method") if isinstance(body, dict) else None
        if method == "initialize":
            return (
                200,
                self.content_type,
                self._frame(
                    body,
                    {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "sayre-graph-context", "version": "1.0.0"},
                    },
                ),
            )
        if method == "notifications/initialized":
            return 202, "application/json", ""
        if method == "tools/list":
            return 200, self.content_type, self._frame(body, {"tools": self.tools})
        if method == "tools/call":
            self._tool_call_count += 1
            if (
                self.unauthorized_after_tool_calls is not None
                and self._tool_call_count > self.unauthorized_after_tool_calls
            ):
                return 401, "application/json", json.dumps({"error": "expired"})
            if self.force_jsonrpc_error:
                return (
                    200,
                    "application/json",
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": body.get("id"),
                            "error": {"code": -32000, "message": "boom"},
                        }
                    ),
                )
            name = body.get("params", {}).get("name")
            if name in self.tool_errors:
                return (
                    200,
                    self.content_type,
                    self._frame(
                        body,
                        {
                            "content": [{"type": "text", "text": "MCP tool execution failed."}],
                            "isError": True,
                        },
                    ),
                )
            data = self.tool_data.get(name)
            return (
                200,
                self.content_type,
                self._frame(
                    body,
                    {
                        "content": [
                            {"type": "text", "text": json.dumps({"data": data})}
                        ]
                    },
                ),
            )
        return (
            200,
            "application/json",
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": body.get("id") if isinstance(body, dict) else None,
                    "error": {"code": -32601, "message": "Method not found"},
                }
            ),
        )


@pytest.fixture()
def gateway() -> Any:
    with FakeMcpGateway() as running:
        running.tool_data["find_relevant_nodes"] = [
            {
                "id": "file-42",
                "label": "File",
                "name": "login.ts",
                "path": "src/auth/login.ts",
                "repositoryId": "repo-1",
                "refName": "refs/heads/main",
                "revisionSha": "a" * 40,
                "distance": 0,
            }
        ]
        yield running


# ---------------------------------------------------------------------------
# AC-8 — a real MCP client, not an HTTP-shaped imitation
# ---------------------------------------------------------------------------


# @spec AC-8
async def test_it_performs_the_real_handshake_then_discovers_then_invokes(
    gateway: FakeMcpGateway,
) -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        tools = await client.list_tools()
        result = await client.call_tool("find_relevant_nodes", {"query": "login"})
        await client.aclose()

    assert gateway.methods() == [
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
    ]
    assert all(request.path.endswith("/mcp") for request in gateway.requests)
    assert isinstance(tools, tuple)
    assert [tool.name for tool in tools] == [tool["name"] for tool in MCP_TOOL_CATALOGUE]
    assert isinstance(tools[0], McpToolDescriptor)
    assert tools[0].input_schema["required"] == ["query"]
    assert isinstance(result, McpToolResult)
    assert result.tool == "find_relevant_nodes"
    assert result.is_error is False
    assert result.data == gateway.tool_data["find_relevant_nodes"]


# @spec AC-8
async def test_every_post_is_json_rpc_2_0_with_the_pinned_headers_and_no_origin(
    gateway: FakeMcpGateway,
) -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        await client.list_tools()
        await client.call_tool("find_relevant_nodes", {"query": "login"})

    assert gateway.authorizations() == [f"Bearer {TOKEN}"] * 4
    for request in gateway.requests:
        assert request.headers["content-type"].startswith("application/json")
        assert request.headers["accept"] == "application/json, text/event-stream"
        # `originAllowed` permits an ABSENT Origin and rejects anything outside
        # MCP_ALLOWED_ORIGINS — a worker is not a browser and must send none.
        assert "origin" not in request.headers
        assert request.body["jsonrpc"] == "2.0"

    # `initialize` names the protocol version and this client; every request
    # AFTER the handshake pins MCP-Protocol-Version.
    initialize = gateway.requests[0]
    assert initialize.body["params"]["protocolVersion"] == MCP_PROTOCOL_VERSION
    assert initialize.body["params"]["clientInfo"] == MCP_CLIENT_INFO
    assert MCP_PROTOCOL_VERSION == "2025-06-18"
    assert MCP_CLIENT_INFO == {"name": "sayre-chat-worker", "version": "1.0.0"}
    for request in gateway.requests[1:]:
        assert request.headers.get("mcp-protocol-version") == MCP_PROTOCOL_VERSION

    # A JSON-RPC *notification* carries no id; every request does.
    notification = gateway.requests[1]
    assert notification.body["method"] == "notifications/initialized"
    assert "id" not in notification.body
    assert gateway.requests[0].body.get("id") is not None
    assert gateway.requests[2].body.get("id") is not None
    assert gateway.requests[3].body.get("id") is not None


# @spec AC-8
async def test_tools_call_sends_the_name_and_arguments_the_gateway_expects(
    gateway: FakeMcpGateway,
) -> None:
    gateway.tool_data["get_node_context"] = {"node": {"id": "file-42"}}
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        await client.call_tool("get_node_context", {"node_id": "file-42"})

    assert gateway.tool_calls() == [("get_node_context", {"node_id": "file-42"})]
    assert gateway.requests[-1].body["method"] == "tools/call"


# @spec AC-8 EC-9
async def test_an_is_error_tool_result_is_surfaced_without_data_and_without_raising(
    gateway: FakeMcpGateway,
) -> None:
    gateway.tool_errors.add("get_node_context")
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        result = await client.call_tool("get_node_context", {"node_id": "file-42"})

    assert result.is_error is True
    assert result.data is None
    assert result.tool == "get_node_context"


# @spec AC-8
async def test_a_server_sent_event_response_is_tolerated(gateway: FakeMcpGateway) -> None:
    gateway.content_type = "text/event-stream"
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        result = await client.call_tool("find_relevant_nodes", {"query": "login"})

    assert result.is_error is False
    assert result.data == gateway.tool_data["find_relevant_nodes"]


# ---------------------------------------------------------------------------
# AC-8 / AC-5 — failure taxonomy, and never echoing the bearer
# ---------------------------------------------------------------------------


# @spec AC-8 AC-5
async def test_a_401_raises_the_unauthorized_error_and_never_echoes_the_token(
    gateway: FakeMcpGateway,
) -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token="expired-credential-value", client=http
        )
        with pytest.raises(McpUnauthorizedError) as raised:
            await client.initialize()

    assert isinstance(raised.value, McpTransportError)
    rendered = f"{raised.value!r} {raised.value}"
    assert "expired-credential-value" not in rendered
    assert "Bearer" not in rendered


# @spec AC-8
@pytest.mark.parametrize(
    ("status", "body"),
    [
        (500, json.dumps({"error": "internal"})),
        (503, ""),
        (403, json.dumps({"error": "forbidden"})),
        (200, "not json at all"),
        (200, json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"unexpected": True}})),
    ],
    ids=["500", "503", "403", "unparseable-body", "missing-tool-result"],
)
async def test_any_other_transport_or_protocol_failure_raises_a_transport_error(
    gateway: FakeMcpGateway, status: int, body: str
) -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        gateway.force_status = status
        gateway.force_body = body
        with pytest.raises(McpTransportError) as raised:
            await client.call_tool("find_relevant_nodes", {"query": "login"})

    assert not isinstance(raised.value, McpUnauthorizedError)
    assert TOKEN not in f"{raised.value!r} {raised.value}"


# @spec AC-8
async def test_a_json_rpc_error_object_is_a_transport_error(gateway: FakeMcpGateway) -> None:
    gateway.force_jsonrpc_error = True
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        await client.initialize()
        with pytest.raises(McpTransportError):
            await client.call_tool("find_relevant_nodes", {"query": "login"})


# @spec AC-8
async def test_an_unreachable_endpoint_is_a_transport_error_not_a_raw_httpx_error() -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url="http://127.0.0.1:1/mcp",
            bearer_token=TOKEN,
            client=http,
            timeout_seconds=1.0,
        )
        with pytest.raises(McpTransportError) as raised:
            await client.initialize()

    assert TOKEN not in f"{raised.value!r} {raised.value}"


# @spec AC-16 AC-5
async def test_the_client_repr_never_contains_the_bearer_token(
    gateway: FakeMcpGateway,
) -> None:
    async with httpx.AsyncClient() as http:
        client = StreamableHttpMcpClient(
            endpoint_url=gateway.url, bearer_token=TOKEN, client=http
        )
        rendered = f"{client!r} {client}"

    assert TOKEN not in rendered
    assert "one-time-secret-value-never-logged" not in rendered

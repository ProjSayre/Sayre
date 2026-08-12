"""A real, hand-written MCP client over the already-pinned `httpx` (spec.md
D2): performs the genuine `initialize` / `notifications/initialized`
handshake, discovers tools via `tools/list`, and invokes via `tools/call`,
over the real streamable-HTTP transport against Core's real `POST /mcp`.

Does NOT use the official `mcp` Python SDK: `services/workers` pins
`pydantic==2.9.*` and current `mcp` releases require `pydantic>=2.11`; see
spec.md D2 for the full rationale. `tests/test_chat_boundaries.py` asserts no
`mcp` package import ever appears anywhere under `sayre_workers/chat/`.
"""

from __future__ import annotations

import json
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Callable, Mapping

import httpx

from .models import ChatTurnJob

MCP_PROTOCOL_VERSION = "2025-06-18"
MCP_CLIENT_INFO = {"name": "sayre-chat-worker", "version": "1.0.0"}


class McpTransportError(RuntimeError):
    """Any non-2xx status (other than 401), a transport-level failure, a
    JSON-RPC `error` object, or an unparseable response body. Never contains
    the bearer token, the endpoint URL's credentials, or the raw response
    body."""


class McpUnauthorizedError(McpTransportError):
    """HTTP 401 -- the credential is expired/invalid. Never contains the
    bearer token."""


@dataclass(frozen=True)
class McpToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class McpToolResult:
    tool: str
    is_error: bool
    data: Any  # parsed from result.content[0].text -> {"data": ...}["data"], else None


def _parse_body(content_type: str, text: str) -> Any:
    """A `text/event-stream` response is tolerated by reading the first
    `data:` frame, even though `enableJsonResponse: true` means the gateway
    normally returns `application/json`."""
    normalized = content_type.split(";")[0].strip().lower()
    if normalized == "text/event-stream":
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            candidate = line[len("data:") :].strip()
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                raise McpTransportError(
                    "mcp response contained an unparseable SSE data frame"
                ) from None
        raise McpTransportError("mcp SSE response contained no data frame")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise McpTransportError("mcp response body was not valid JSON") from None


class StreamableHttpMcpClient:
    """A real MCP client speaking JSON-RPC 2.0 over one streamable-HTTP
    endpoint, stateless (the gateway is configured `sessionIdGenerator:
    undefined`, `enableJsonResponse: true`), so each call is one
    self-contained POST."""

    def __init__(
        self,
        *,
        endpoint_url: str,
        bearer_token: str,
        client: httpx.AsyncClient,
        timeout_seconds: float = 15.0,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._bearer_token = bearer_token
        self._client = client
        self._timeout_seconds = timeout_seconds
        self._next_request_id = 1
        self._initialized = False

    def __repr__(self) -> str:  # NEVER contains the bearer token
        return f"StreamableHttpMcpClient(endpoint_url={self._endpoint_url!r})"

    def _id(self) -> int:
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    def _headers(self, *, include_protocol_version: bool) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._bearer_token}",
            # `originAllowed` permits an ABSENT Origin and rejects anything
            # outside MCP_ALLOWED_ORIGINS -- a worker is not a browser and
            # must send none. httpx never adds one unless told to.
            "Accept": "application/json, text/event-stream",
        }
        if include_protocol_version:
            headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION
        return headers

    async def _send(
        self, payload: dict[str, Any], *, include_protocol_version: bool
    ) -> httpx.Response:
        try:
            return await self._client.post(
                self._endpoint_url,
                json=payload,
                headers=self._headers(include_protocol_version=include_protocol_version),
                timeout=self._timeout_seconds,
            )
        except httpx.HTTPError:
            raise McpTransportError("mcp transport request failed") from None

    async def _post(
        self, payload: dict[str, Any], *, include_protocol_version: bool
    ) -> dict[str, Any]:
        """Send a JSON-RPC request expecting a JSON-RPC response body."""
        response = await self._send(payload, include_protocol_version=include_protocol_version)
        if response.status_code == 401:
            raise McpUnauthorizedError("mcp gateway rejected the credential")
        if not (200 <= response.status_code < 300):
            raise McpTransportError(
                f"mcp transport returned an unsuccessful status ({response.status_code})"
            )

        content_type = response.headers.get("content-type", "")
        message = _parse_body(content_type, response.text)
        if not isinstance(message, dict):
            raise McpTransportError("mcp response was not a JSON object")
        if "error" in message:
            raise McpTransportError("mcp gateway returned a JSON-RPC error")
        return message

    async def _post_notification(self, payload: dict[str, Any]) -> None:
        """A JSON-RPC *notification* carries no id and expects no body."""
        response = await self._send(payload, include_protocol_version=True)
        if response.status_code == 401:
            raise McpUnauthorizedError("mcp gateway rejected the credential")
        if not (200 <= response.status_code < 300):
            raise McpTransportError(
                f"mcp transport returned an unsuccessful status ({response.status_code})"
            )

    async def initialize(self) -> None:
        payload = {
            "jsonrpc": "2.0",
            "id": self._id(),
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": dict(MCP_CLIENT_INFO),
            },
        }
        message = await self._post(payload, include_protocol_version=False)
        if not isinstance(message.get("result"), dict):
            raise McpTransportError("mcp initialize returned an unexpected result shape")
        self._initialized = True

        await self._post_notification(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )

    async def list_tools(self) -> tuple[McpToolDescriptor, ...]:
        payload = {"jsonrpc": "2.0", "id": self._id(), "method": "tools/list", "params": {}}
        message = await self._post(payload, include_protocol_version=True)
        result = message.get("result")
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise McpTransportError("mcp tools/list returned an unexpected result shape")

        descriptors: list[McpToolDescriptor] = []
        for tool in tools:
            if not isinstance(tool, dict):
                raise McpTransportError("mcp tools/list returned a malformed tool entry")
            name = tool.get("name")
            description = tool.get("description")
            input_schema = tool.get("inputSchema")
            if (
                not isinstance(name, str)
                or not isinstance(description, str)
                or not isinstance(input_schema, dict)
            ):
                raise McpTransportError("mcp tools/list returned a malformed tool entry")
            descriptors.append(
                McpToolDescriptor(name=name, description=description, input_schema=input_schema)
            )
        return tuple(descriptors)

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> McpToolResult:
        payload = {
            "jsonrpc": "2.0",
            "id": self._id(),
            "method": "tools/call",
            "params": {"name": name, "arguments": dict(arguments)},
        }
        message = await self._post(payload, include_protocol_version=True)
        result = message.get("result")
        if not isinstance(result, dict) or "content" not in result:
            raise McpTransportError("mcp tools/call returned an unexpected result shape")

        if result.get("isError") is True:
            return McpToolResult(tool=name, is_error=True, data=None)

        content = result.get("content")
        if not isinstance(content, list) or not content or not isinstance(content[0], dict):
            raise McpTransportError("mcp tools/call returned no content")
        text = content[0].get("text")
        if not isinstance(text, str):
            raise McpTransportError("mcp tools/call content was not text")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            raise McpTransportError("mcp tools/call content was not valid JSON") from None
        data = parsed.get("data") if isinstance(parsed, dict) else None
        return McpToolResult(tool=name, is_error=False, data=data)

    async def aclose(self) -> None:
        """The caller owns `client`'s lifecycle (it is injected); this is a
        no-op placeholder so every chat MCP client type shares the same
        `aclose()` shape as `ChatEventPublisher`/`ModelProvider`."""
        return None


McpClientFactory = Callable[[ChatTurnJob], AbstractAsyncContextManager[StreamableHttpMcpClient]]


__all__ = [
    "MCP_CLIENT_INFO",
    "MCP_PROTOCOL_VERSION",
    "McpClientFactory",
    "McpToolDescriptor",
    "McpToolResult",
    "McpTransportError",
    "McpUnauthorizedError",
    "StreamableHttpMcpClient",
]

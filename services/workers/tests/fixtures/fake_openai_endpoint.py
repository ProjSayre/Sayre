"""Fake OpenAI-compatible chat-completions endpoint for the W3-07 network-isolation
check (scripts/ci/run-network-isolated.sh + assert-no-egress.sh).

Stdlib-only (http.server) — no extra dependency to install just to stand up a
local double. Responds to POST /v1/chat/completions with a minimally valid
OpenAI-shaped response so sayre_workers.model_provider.openai_compatible_adapter's
real AsyncOpenAI client (which validates the response against the SDK's own
Pydantic models) accepts it without special-casing test mode in adapter code.

Run directly: python fake_openai_endpoint.py [port]  (default 9999)
"""

from __future__ import annotations

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_RESPONSE_TEXT = "fake self-hosted response"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler's naming)
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)  # drain the request body; content isn't asserted here

        body = {
            "id": "fake-chatcmpl-1",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "fake-self-hosted-model",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": _RESPONSE_TEXT},
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        payload = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # keep CI logs quiet; this fixture's traffic isn't the thing under test


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()

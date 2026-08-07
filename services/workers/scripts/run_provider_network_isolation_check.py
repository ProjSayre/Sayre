"""CLI entrypoint driving the real self-hosted (openai_compatible) model-provider
adapter against a configured endpoint, for the W3-07 network-isolation check.

scripts/ci/run-network-isolated.sh wraps this command with egress locked down
to loopback; scripts/ci/assert-no-egress.sh then asserts nothing reached a
real provider host during the run. This script exits non-zero on any
failure, including whatever the adapter itself raises — a blocked real-egress
attempt (if the adapter ever fell back to a hosted default) would show up
here as a connection error, not a silent success.

Mirrors scripts/run_graph_migrations.py's structure: `sys.path.insert(0, ".")`
so this runs as `poetry run python scripts/run_provider_network_isolation_check.py`
from services/workers/.

Usage:
    poetry run python scripts/run_provider_network_isolation_check.py <endpoint-url>

<endpoint-url> defaults to $MODEL_ENDPOINT if omitted, matching the CI job's
env. It must be the OpenAI-SDK-style API root (e.g. http://localhost:9999/v1)
-- the SDK itself appends /chat/completions, so a full completions URL here
would double up the path and 404 against the fixture.
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, ".")  # allow running as `python scripts/run_provider_network_isolation_check.py`

from sayre_workers.model_provider.openai_compatible_adapter import (  # noqa: E402
    OpenAICompatibleModelProvider,
)
from sayre_workers.model_provider.protocol import (  # noqa: E402
    GenerationConfig,
    GenerationRequest,
)


async def _run(endpoint: str) -> None:
    config = GenerationConfig(
        provider="openai_compatible",
        model="fake-self-hosted-model",
        endpoint_url=endpoint,
        # No credential_ref: the adapter's own "local-endpoint-no-key" path
        # (openai_compatible_adapter.py) -- a real self-hosted org may have
        # no API key at all, and this script must not require provisioning
        # one just to prove network isolation.
        credential_ref=None,
    )
    provider = await OpenAICompatibleModelProvider.from_config(config)
    try:
        response = await provider.generate(
            GenerationRequest(
                system="You are a network-isolation smoke test.",
                input="ping",
                max_output_tokens=16,
            )
        )
        if not response.text:
            raise RuntimeError("self-hosted adapter returned an empty response")
        print(f"self-hosted adapter round-trip OK: {response.text!r}")
    finally:
        await provider.aclose()


def main() -> None:
    endpoint = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MODEL_ENDPOINT")
    if not endpoint:
        print(
            "usage: run_provider_network_isolation_check.py <endpoint-url> "
            "(or set MODEL_ENDPOINT)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    asyncio.run(_run(endpoint))


if __name__ == "__main__":
    main()

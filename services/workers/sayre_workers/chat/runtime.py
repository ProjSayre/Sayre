"""Production construction for the chat-turn worker (never exercised by a unit
test beyond an import and a signature check -- the runtime half needs live
Postgres/Redis/Core, which is OQ-2's manually-run integration check, not this
package's unit suite).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx

from sayre_workers.config import get_config, get_secret
from sayre_workers.db import assert_runtime_role_rls_safe
from sayre_workers.enrichment import PostgresGenerationConfigStore
from sayre_workers.model_provider import ModelProviderFactory
from sayre_workers.retrieval import OpenTelemetryTokenUsageRecorder, PostgresRetrievalStore

from .agent import ChatAgentLoop
from .mcp_client import StreamableHttpMcpClient
from .models import ChatTurnJob
from .redis_publisher import RedisChatEventPublisher
from .service import ChatTurnService
from .store import PostgresChatTurnStore


@asynccontextmanager
async def _mcp_client_factory(job: ChatTurnJob) -> AsyncIterator[StreamableHttpMcpClient]:
    endpoint_url = get_config("CORE_MCP_URL")
    async with httpx.AsyncClient() as http_client:
        client = StreamableHttpMcpClient(
            endpoint_url=endpoint_url,
            bearer_token=job.mcp_credential,
            client=http_client,
        )
        try:
            yield client
        finally:
            await client.aclose()


async def build_chat_turn_service() -> ChatTurnService:
    dsn = await get_secret("env://DATABASE_RUNTIME_URL")
    await assert_runtime_role_rls_safe(dsn)

    agent = ChatAgentLoop(
        mcp_client_factory=_mcp_client_factory,
        config_store=await PostgresGenerationConfigStore.from_config(),
        provider_factory=ModelProviderFactory(),
        baseline_store=await PostgresRetrievalStore.from_config(),
        token_usage=OpenTelemetryTokenUsageRecorder(),
    )
    return ChatTurnService(
        store=PostgresChatTurnStore(dsn),
        agent=agent,
        publisher=await RedisChatEventPublisher.from_config(),
    )


__all__ = ["build_chat_turn_service"]

"""Redis pub/sub publisher for the three pinned `chat.turn.*` events.

The ONLY module under `sayre_workers/chat/` that imports `redis`
(`tests/test_chat_boundaries.py`
`test_redis_is_confined_to_the_single_publisher_module`) -- D3: `redis` 5.2.x
has no mandatory transitive dependencies on Python 3.12, so this is confined
to exactly this one module behind the `ChatEventPublisher` Protocol, so every
other test uses an in-process fake.
"""

from __future__ import annotations

import logging

import redis.asyncio as redis_asyncio

from messaging.envelope import MessageEnvelope
from sayre_workers.config import SecretNotFoundError, get_bool_config, get_config, get_secret

logger = logging.getLogger(__name__)


class RedisChatEventPublisher:
    def __init__(self, client: "redis_asyncio.Redis") -> None:
        self._client = client

    @classmethod
    async def from_config(cls) -> "RedisChatEventPublisher":
        try:
            password = await get_secret("env://REDIS_PASSWORD")
        except SecretNotFoundError:
            password = None
        client = redis_asyncio.Redis(
            host=get_config("REDIS_HOST"),
            port=int(get_config("REDIS_PORT")),
            ssl=get_bool_config("REDIS_TLS"),
            password=password,
            decode_responses=True,
        )
        return cls(client)

    async def publish(self, channel: str, envelope: MessageEnvelope) -> None:
        # The standard snake_case wire body, not a bespoke re-serialization --
        # the gateway's Redis reader runs assertValidEnvelope on whatever
        # arrives on this channel.
        await self._client.publish(channel, envelope.to_body())

    async def aclose(self) -> None:
        await self._client.aclose()


__all__ = ["RedisChatEventPublisher"]

"""CH-04: the "Ask Sayre" chat-turn agent loop. Consumes `chat-turns.fifo`,
reaches the code graph exclusively through Core's MCP gateway as a real MCP
client, synthesizes a markdown answer with citations and the 70x token-KPI
metrics through the existing `ModelProvider` boundary, publishes
`chat.turn.progress` / `chat.turn.completed` / `chat.turn.error` events onto
Redis pub/sub for CH-05's gateway fan-out, and persists the terminal
assistant turn in Postgres.
"""

from .agent import (
    ChatAgentLoop,
    ChatAgentState,
    ProgressSink,
    act_node,
    build_chat_agent_graph,
    decide_node,
    synthesize_node,
)
from .consumers import run_chat_turn_consumer
from .events import (
    ChatEventPublisher,
    build_completed_event,
    build_error_event,
    build_progress_event,
    chat_event_channel,
    parse_chat_turn_envelope,
)
from .mcp_client import (
    MCP_CLIENT_INFO,
    MCP_PROTOCOL_VERSION,
    McpClientFactory,
    McpToolDescriptor,
    McpToolResult,
    McpTransportError,
    McpUnauthorizedError,
    StreamableHttpMcpClient,
)
from .models import (
    CHAT_ANSWER_MAX_CHARACTERS,
    CHAT_EVENT_CHANNEL_PREFIX,
    CHAT_MAX_CITATIONS,
    CHAT_MAX_DETAIL_CHARACTERS,
    CHAT_MAX_MALFORMED_DECISIONS,
    CHAT_MAX_TOOL_CALLS,
    CHAT_TURN_DEADLINE_SECONDS,
    CHAT_TURN_STALE_SECONDS,
    USER_SAFE_MESSAGES,
    ChatAnswer,
    ChatCitation,
    ChatErrorCode,
    ChatHistoryEntry,
    ChatTurnFailure,
    ChatTurnJob,
    ChatTurnMetrics,
    InvalidChatTurnEventError,
)
from .prompt import (
    CHAT_MAX_OUTPUT_TOKENS,
    CHAT_SYSTEM_PROMPT,
    ContextDocument,
    bound_documents,
    build_decision_prompt,
    estimate_tokens,
    fit_answer_prompt,
)
from .redis_publisher import RedisChatEventPublisher
from .runtime import build_chat_turn_service
from .service import ChatTurnService
from .store import ChatTurnStore, PostgresChatTurnStore

__all__ = [
    "CHAT_ANSWER_MAX_CHARACTERS",
    "CHAT_EVENT_CHANNEL_PREFIX",
    "CHAT_MAX_CITATIONS",
    "CHAT_MAX_DETAIL_CHARACTERS",
    "CHAT_MAX_MALFORMED_DECISIONS",
    "CHAT_MAX_OUTPUT_TOKENS",
    "CHAT_MAX_TOOL_CALLS",
    "CHAT_SYSTEM_PROMPT",
    "CHAT_TURN_DEADLINE_SECONDS",
    "CHAT_TURN_STALE_SECONDS",
    "MCP_CLIENT_INFO",
    "MCP_PROTOCOL_VERSION",
    "USER_SAFE_MESSAGES",
    "ChatAgentLoop",
    "ChatAgentState",
    "ChatAnswer",
    "ChatCitation",
    "ChatErrorCode",
    "ChatEventPublisher",
    "ChatHistoryEntry",
    "ChatTurnFailure",
    "ChatTurnJob",
    "ChatTurnMetrics",
    "ChatTurnService",
    "ChatTurnStore",
    "ContextDocument",
    "InvalidChatTurnEventError",
    "McpClientFactory",
    "McpToolDescriptor",
    "McpToolResult",
    "McpTransportError",
    "McpUnauthorizedError",
    "PostgresChatTurnStore",
    "ProgressSink",
    "RedisChatEventPublisher",
    "StreamableHttpMcpClient",
    "act_node",
    "bound_documents",
    "build_chat_agent_graph",
    "build_chat_turn_service",
    "build_completed_event",
    "build_decision_prompt",
    "build_error_event",
    "build_progress_event",
    "chat_event_channel",
    "decide_node",
    "estimate_tokens",
    "fit_answer_prompt",
    "parse_chat_turn_envelope",
    "run_chat_turn_consumer",
    "synthesize_node",
]

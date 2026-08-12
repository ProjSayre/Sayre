"""The bounded LangGraph agent loop: a compiled `StateGraph` over `decide` /
`act` / `synthesize` nodes that reaches the code graph exclusively through a
real MCP client and synthesizes a markdown answer with citations and the 70x
token-KPI metrics through the existing `ModelProvider` boundary.

Every generation call goes through `ModelProvider.generate` /
`generate_structured` -- never a direct vendor SDK call
(`.claude/rules/security-multitenancy.md`'s sibling architecture rule in
CLAUDE.md: "ALL LLM calls go through the ModelProvider adapter").
"""

from __future__ import annotations

import json
from typing import (
    Any,
    Awaitable,
    Callable,
    Literal,
    Mapping,
    Sequence,
    TypedDict,
)

from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph

from sayre_workers.enrichment import GenerationConfig, GenerationConfigStore
from sayre_workers.model_provider import GenerationRequest, ProviderCallScope
from sayre_workers.retrieval import GenerationProviderFactory, RetrievalScope, RetrievalStore
from sayre_workers.retrieval.metrics import TokenUsageRecorder

from .mcp_client import McpClientFactory, McpToolDescriptor, McpToolResult
from .models import (
    CHAT_ANSWER_MAX_CHARACTERS,
    CHAT_MAX_CITATIONS,
    CHAT_MAX_DETAIL_CHARACTERS,
    CHAT_MAX_MALFORMED_DECISIONS,
    CHAT_MAX_TOOL_CALLS,
    ChatAnswer,
    ChatCitation,
    ChatTurnFailure,
    ChatTurnJob,
    ChatTurnMetrics,
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

ProgressSink = Callable[[Literal["status", "tool_call"], str | None, str | None], Awaitable[None]]

DECISION_SCHEMA: Mapping[str, Any] = {
    "type": "object",
    "required": ["action"],
    "properties": {
        "action": {"enum": ["call_tool", "answer"]},
        "tool": {"type": ["string", "null"]},
        "arguments": {"type": "object"},
    },
}

# Tools whose result carries one node's data directly at `data["node"]` (or,
# failing that, `data` itself already looks like a node) -- one ContextDocument
# for that subject node.
_SUBJECT_NODE_TOOLS = frozenset(
    {
        "get_node_context",
        "get_agent_skill_md",
        "get_style_rules",
        "get_covering_tests",
        "get_recent_changes",
        "check_liveness",
    }
)
_LIST_NODE_TOOLS = frozenset({"find_relevant_nodes", "traverse_from"})


class ChatAgentState(TypedDict, total=False):
    job: ChatTurnJob
    progress: ProgressSink
    mcp_client: Any
    provider: Any
    baseline_store: Any
    token_usage: Any
    tools: tuple[McpToolDescriptor, ...]
    documents: list[ContextDocument]
    calls_made: int
    malformed_count: int
    cache: dict[str, tuple[ContextDocument, ...]]
    observations: list[tuple[str, str]]
    feature_resolutions: dict[str, str]
    scope: RetrievalScope | None
    first_move_done: bool
    pending_action: dict[str, Any] | None
    termination: str | None
    next: str
    answer: ChatAnswer | None


def _node_kind(node: Mapping[str, Any]) -> str:
    return "folder" if node.get("label") == "Folder" else "file"


def _list_nodes(tool: str, data: Any) -> list[dict[str, Any]]:
    if tool not in _LIST_NODE_TOOLS:
        return []
    nodes: list[dict[str, Any]] = []
    if isinstance(data, list):
        nodes.extend(item for item in data if isinstance(item, dict))
    elif isinstance(data, dict):
        anchor = data.get("anchor")
        if isinstance(anchor, dict):
            nodes.append(anchor)
        extra = data.get("nodes")
        if isinstance(extra, list):
            nodes.extend(item for item in extra if isinstance(item, dict))
    return nodes


def _first_scope(tool: str, data: Any, org_id: str) -> RetrievalScope | None:
    for node in _list_nodes(tool, data):
        repository_id = node.get("repositoryId")
        ref_name = node.get("refName")
        revision_sha = node.get("revisionSha")
        if (
            isinstance(repository_id, str)
            and repository_id
            and isinstance(ref_name, str)
            and ref_name
            and isinstance(revision_sha, str)
            and revision_sha
        ):
            return RetrievalScope(
                org_id=org_id,
                repository_id=repository_id,
                ref_name=ref_name,
                revision_sha=revision_sha,
            )
    return None


def _document_from_node(node: Mapping[str, Any]) -> ContextDocument | None:
    node_id = node.get("id")
    if not isinstance(node_id, str) or not node_id:
        return None
    path = node.get("path")
    path = path if isinstance(path, str) and path else node_id
    body = json.dumps(
        {
            "name": node.get("name"),
            "path": node.get("path"),
            "label": node.get("label"),
            "distance": node.get("distance"),
        },
        ensure_ascii=True,
    )
    return ContextDocument(
        node_id=node_id,
        label=path,
        path=path,
        kind=_node_kind(node),  # type: ignore[arg-type]
        resolved_node_id=node_id,
        body=body,
        token_count=estimate_tokens(body),
    )


def _project(tool: str, data: Any) -> tuple[ContextDocument, ...]:
    """Project one MCP tool's result into zero or more `ContextDocument`s per
    spec.md's per-tool projection rules (agent.py's "Loop contract" #6)."""
    if data is None:
        return ()

    if tool in _LIST_NODE_TOOLS:
        documents: list[ContextDocument] = []
        seen: set[str] = set()
        for node in _list_nodes(tool, data):
            document = _document_from_node(node)
            if document is None or document.node_id in seen:
                continue
            seen.add(document.node_id)
            documents.append(document)
        return tuple(documents)

    if tool == "get_feature_cluster":
        if not isinstance(data, dict):
            return ()
        subject = data.get("node")
        subject_id = subject.get("id") if isinstance(subject, dict) else None
        clusters = data.get("featureClusters")
        documents = []
        if isinstance(clusters, list):
            for cluster in clusters:
                if not isinstance(cluster, dict):
                    continue
                cluster_id = cluster.get("id")
                if not isinstance(cluster_id, str) or not cluster_id:
                    continue
                label = cluster.get("name")
                label = label if isinstance(label, str) and label.strip() else cluster_id
                body = json.dumps(cluster, ensure_ascii=True, default=str)
                documents.append(
                    ContextDocument(
                        node_id=cluster_id,
                        label=label,
                        path=cluster_id,
                        kind="feature",
                        resolved_node_id=subject_id if isinstance(subject_id, str) else None,
                        body=body,
                        token_count=estimate_tokens(body),
                    )
                )
        return tuple(documents)

    if tool == "get_ready_tickets":
        if not isinstance(data, dict):
            return ()
        groups = data.get("groups")
        documents = []
        if isinstance(groups, list):
            for group in groups:
                if not isinstance(group, dict):
                    continue
                tickets = group.get("tickets")
                if not isinstance(tickets, list):
                    continue
                for ticket in tickets:
                    if not isinstance(ticket, dict):
                        continue
                    ticket_id = ticket.get("id")
                    if not isinstance(ticket_id, str) or not ticket_id:
                        continue
                    label = ticket.get("title")
                    label = label if isinstance(label, str) and label.strip() else ticket_id
                    body = json.dumps(ticket, ensure_ascii=True, default=str)
                    documents.append(
                        ContextDocument(
                            node_id=ticket_id,
                            label=label,
                            path=ticket_id,
                            kind="ticket",
                            # resolved_node_id is filled in by act_node, which
                            # alone tracks feature_resolutions across calls.
                            resolved_node_id=None,
                            body=body,
                            token_count=estimate_tokens(body),
                        )
                    )
        return tuple(documents)

    if tool in _SUBJECT_NODE_TOOLS:
        subject: Any = None
        if isinstance(data, dict):
            subject = data.get("node")
            if subject is None and isinstance(data.get("id"), str):
                subject = data
        if not isinstance(subject, dict):
            return ()
        node_id = subject.get("id")
        if not isinstance(node_id, str) or not node_id:
            return ()
        path = subject.get("path")
        path = path if isinstance(path, str) and path else node_id
        body = json.dumps(subject, ensure_ascii=True, default=str)
        return (
            ContextDocument(
                node_id=node_id,
                label=path,
                path=path,
                kind=_node_kind(subject),  # type: ignore[arg-type]
                resolved_node_id=node_id,
                body=body,
                token_count=estimate_tokens(body),
            ),
        )

    return ()


def _ticket_feature_ids(data: Any) -> list[tuple[str, str | None]]:
    """(ticket_id, feature_id) pairs from a get_ready_tickets result, in
    encounter order -- used only to resolve ticket -> feature after the fact."""
    pairs: list[tuple[str, str | None]] = []
    if not isinstance(data, dict):
        return pairs
    groups = data.get("groups")
    if not isinstance(groups, list):
        return pairs
    for group in groups:
        if not isinstance(group, dict):
            continue
        tickets = group.get("tickets")
        if not isinstance(tickets, list):
            continue
        for ticket in tickets:
            if not isinstance(ticket, dict):
                continue
            ticket_id = ticket.get("id")
            if not isinstance(ticket_id, str) or not ticket_id:
                continue
            feature = ticket.get("feature")
            feature_id = feature.get("id") if isinstance(feature, dict) else None
            pairs.append((ticket_id, feature_id if isinstance(feature_id, str) else None))
    return pairs


def _cache_key(tool: str, arguments: Mapping[str, Any]) -> str:
    return f"{tool}:{json.dumps(dict(arguments), sort_keys=True, ensure_ascii=True)}"


def _detail_for(arguments: Mapping[str, Any]) -> str | None:
    node_id = arguments.get("node_id")
    if not isinstance(node_id, str):
        return None
    return f"node {node_id}"[:CHAT_MAX_DETAIL_CHARACTERS]


def _valid_decision(
    tool_name: object, arguments: Mapping[str, Any], tools: Sequence[McpToolDescriptor]
) -> bool:
    if not isinstance(tool_name, str):
        return False
    descriptor = next((tool for tool in tools if tool.name == tool_name), None)
    if descriptor is None:
        return False
    required = descriptor.input_schema.get("required")
    if not isinstance(required, list):
        return True
    return all(key in arguments for key in required)


async def decide_node(state: ChatAgentState) -> ChatAgentState:
    job = state["job"]

    if not state.get("first_move_done"):
        state["first_move_done"] = True
        if job.anchor_node_id:
            decision: Mapping[str, Any] = {
                "action": "call_tool",
                "tool": "get_node_context",
                "arguments": {"node_id": job.anchor_node_id},
            }
        else:
            decision = {
                "action": "call_tool",
                "tool": "find_relevant_nodes",
                "arguments": {"query": job.question},
            }
    else:
        prompt = build_decision_prompt(
            job.question, job.history, state["tools"], tuple(state["observations"])
        )
        response = await state["provider"].generate_structured(
            GenerationRequest(
                system="Decide the next tool call or answer for the Ask Sayre agent loop.",
                input=prompt,
                max_output_tokens=512,
            ),
            DECISION_SCHEMA,
        )
        decision = response.data if isinstance(response.data, dict) else {}

    action = decision.get("action")
    if action == "answer":
        state["termination"] = "answer"
        state["pending_action"] = None
        state["next"] = "synthesize"
        return state

    if action == "call_tool":
        tool_name = decision.get("tool")
        arguments = decision.get("arguments")
        arguments = arguments if isinstance(arguments, dict) else {}
        if _valid_decision(tool_name, arguments, state["tools"]):
            state["pending_action"] = {"tool": tool_name, "arguments": arguments}
            state["next"] = "act"
            return state

    # Malformed: an unknown tool name, or a known tool missing a required
    # argument -- never sent to the gateway, and the budget is not decremented.
    state["malformed_count"] = state.get("malformed_count", 0) + 1
    state["pending_action"] = None
    if state["malformed_count"] >= CHAT_MAX_MALFORMED_DECISIONS:
        state["termination"] = "malformed_exhausted"
        state["next"] = "synthesize"
    else:
        state["next"] = "decide"
    return state


async def act_node(state: ChatAgentState) -> ChatAgentState:
    action = state["pending_action"]
    assert action is not None
    tool = action["tool"]
    arguments: dict[str, Any] = dict(action.get("arguments") or {})
    cache = state["cache"]
    key = _cache_key(tool, arguments)

    if key in cache:
        # EC-14: identical (tool, arguments) pair -- no second HTTP call, no
        # second budget decrement, no second progress event.
        state["pending_action"] = None
        state["next"] = "decide"
        return state

    await state["progress"]("tool_call", tool, _detail_for(arguments))
    result: McpToolResult = await state["mcp_client"].call_tool(tool, arguments)
    state["calls_made"] = state.get("calls_made", 0) + 1

    documents: tuple[ContextDocument, ...] = ()
    if not result.is_error:
        documents = _project(tool, result.data)

        if tool == "get_feature_cluster" and isinstance(result.data, dict):
            subject = result.data.get("node")
            subject_id = subject.get("id") if isinstance(subject, dict) else None
            clusters = result.data.get("featureClusters")
            if isinstance(subject_id, str) and isinstance(clusters, list):
                for cluster in clusters:
                    if isinstance(cluster, dict) and isinstance(cluster.get("id"), str):
                        state["feature_resolutions"][cluster["id"]] = subject_id

        if tool == "get_ready_tickets":
            resolved: list[ContextDocument] = []
            pairs = dict(_ticket_feature_ids(result.data))
            for document in documents:
                feature_id = pairs.get(document.node_id)
                resolved_node_id = (
                    state["feature_resolutions"].get(feature_id)
                    if isinstance(feature_id, str)
                    else None
                )
                resolved.append(
                    ContextDocument(
                        node_id=document.node_id,
                        label=document.label,
                        path=document.path,
                        kind=document.kind,
                        resolved_node_id=resolved_node_id,
                        body=document.body,
                        token_count=document.token_count,
                    )
                )
            documents = tuple(resolved)

        if state.get("scope") is None:
            scope = _first_scope(tool, result.data, state["job"].org_id)
            if scope is not None:
                state["scope"] = scope

        existing_ids = {document.node_id for document in state["documents"]}
        for document in documents:
            if document.node_id not in existing_ids:
                state["documents"].append(document)
                existing_ids.add(document.node_id)

        state["observations"].append((tool, json.dumps({"count": len(documents)})))
    else:
        state["observations"].append((tool, json.dumps({"error": True})))

    cache[key] = documents
    state["pending_action"] = None

    if state["calls_made"] >= CHAT_MAX_TOOL_CALLS:
        state["termination"] = "budget_exhausted"
        state["next"] = "synthesize"
    else:
        state["next"] = "decide"
    return state


async def synthesize_node(state: ChatAgentState) -> ChatAgentState:
    job = state["job"]
    bounded = bound_documents(tuple(state["documents"]))
    if not bounded:
        code = (
            "chat.tool_budget_exhausted"
            if state.get("termination") == "budget_exhausted"
            else "chat.context_unavailable"
        )
        raise ChatTurnFailure(code)  # type: ignore[arg-type]

    accepted, prompt, tokens_used = fit_answer_prompt(job.question, job.history, bounded)
    if not accepted:
        code = (
            "chat.tool_budget_exhausted"
            if state.get("termination") == "budget_exhausted"
            else "chat.context_unavailable"
        )
        raise ChatTurnFailure(code)  # type: ignore[arg-type]

    await state["progress"]("status", None, "Synthesizing the answer")
    response = await state["provider"].generate(
        GenerationRequest(
            system=CHAT_SYSTEM_PROMPT, input=prompt, max_output_tokens=CHAT_MAX_OUTPUT_TOKENS
        )
    )
    if not response.text.strip():
        raise ChatTurnFailure("chat.provider_unavailable")
    answer_text = response.text[:CHAT_ANSWER_MAX_CHARACTERS]

    context_tokens = sum(document.token_count for document in accepted)
    scope = state.get("scope")
    if scope is not None:
        full_repo_tokens = await state["baseline_store"].load_full_repo_token_count(scope)
        baseline_tokens = full_repo_tokens + (tokens_used - context_tokens)
    else:
        full_repo_tokens = context_tokens
        baseline_tokens = tokens_used
    raw_ratio = baseline_tokens / max(1, tokens_used)
    bounded_ratio = max(1.0, raw_ratio)

    state["token_usage"].record(
        org_id=job.org_id,
        context_tokens=context_tokens,
        prompt_tokens=tokens_used,
        full_repo_tokens=full_repo_tokens,
        reduction_ratio=bounded_ratio,
    )

    citations = tuple(
        ChatCitation(
            node_id=document.node_id,
            label=(document.label.strip() or document.node_id)[:200],
            kind=document.kind,
            resolved_node_id=document.resolved_node_id,
        )
        for document in accepted[:CHAT_MAX_CITATIONS]
    )

    state["answer"] = ChatAnswer(
        answer=answer_text,
        citations=citations,
        metrics=ChatTurnMetrics(
            context_nodes=len({document.node_id for document in accepted}),
            tokens_used=tokens_used,
            baseline_tokens=baseline_tokens,
            ratio=round(bounded_ratio, 2),
        ),
    )
    return state


def _route(state: ChatAgentState) -> str:
    return state["next"]


def build_chat_agent_graph() -> CompiledStateGraph:
    graph: StateGraph = StateGraph(ChatAgentState)
    graph.add_node("decide", decide_node)
    graph.add_node("act", act_node)
    graph.add_node("synthesize", synthesize_node)
    graph.set_entry_point("decide")
    graph.add_conditional_edges(
        "decide", _route, {"decide": "decide", "act": "act", "synthesize": "synthesize"}
    )
    graph.add_conditional_edges("act", _route, {"decide": "decide", "synthesize": "synthesize"})
    graph.add_edge("synthesize", END)
    return graph.compile()


class ChatAgentLoop:
    def __init__(
        self,
        *,
        mcp_client_factory: McpClientFactory,
        config_store: GenerationConfigStore,
        provider_factory: GenerationProviderFactory,
        baseline_store: RetrievalStore,
        token_usage: TokenUsageRecorder,
    ) -> None:
        self._mcp_client_factory = mcp_client_factory
        self._config_store = config_store
        self._provider_factory = provider_factory
        self._baseline_store = baseline_store
        self._token_usage = token_usage
        self._graph = build_chat_agent_graph()

    async def run(self, job: ChatTurnJob, progress: ProgressSink) -> ChatAnswer:
        config: GenerationConfig | None = await self._config_store.load_generation_config(
            job.org_id
        )
        if config is None:
            raise ChatTurnFailure("chat.provider_unavailable")
        provider = await self._provider_factory.create(
            config, ProviderCallScope(org_id=job.org_id, purpose="chat")
        )

        async with self._mcp_client_factory(job) as mcp_client:
            await mcp_client.initialize()
            tools = await mcp_client.list_tools()

            state: ChatAgentState = {
                "job": job,
                "progress": progress,
                "mcp_client": mcp_client,
                "provider": provider,
                "baseline_store": self._baseline_store,
                "token_usage": self._token_usage,
                "tools": tools,
                "documents": [],
                "calls_made": 0,
                "malformed_count": 0,
                "cache": {},
                "observations": [],
                "feature_resolutions": {},
                "scope": None,
                "first_move_done": False,
                "pending_action": None,
                "termination": None,
                "next": "decide",
                "answer": None,
            }
            final_state = await self._graph.ainvoke(state, config={"recursion_limit": 200})

        answer = final_state["answer"]
        assert answer is not None
        return answer


__all__ = [
    "ChatAgentLoop",
    "ChatAgentState",
    "DECISION_SCHEMA",
    "ProgressSink",
    "act_node",
    "build_chat_agent_graph",
    "decide_node",
    "synthesize_node",
]

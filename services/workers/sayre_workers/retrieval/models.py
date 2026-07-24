"""Immutable contracts for tenant-scoped Graph-Guided RAG."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


class InvalidRetrievalInputError(ValueError):
    """A query or server-derived auth field is malformed."""


class RetrievalContextUnavailableError(LookupError):
    """No authorized, indexed context is available.

    Missing and denied graph data deliberately share this error so callers cannot
    use retrieval as an authorization oracle.
    """


class RetrievalScopeError(RuntimeError):
    """An allegedly authorized graph result disagrees with the auth/scope."""


class InvalidRetrievedChunkError(RuntimeError):
    """Persisted retrieval data violates the bounded chunk contract."""


@dataclass(frozen=True)
class RetrievalAuthContext:
    """Server-derived identity passed by the authenticated caller.

    ``org_id`` is never part of ``RetrievalQuery`` and must never be copied from a
    user request body.
    """

    org_id: str
    subject_id: str
    roles: tuple[str, ...]


@dataclass(frozen=True)
class RetrievalQuery:
    query: str
    anchor_node_id: str | None = None


@dataclass(frozen=True)
class RetrievalScope:
    org_id: str
    repository_id: str
    ref_name: str
    revision_sha: str


@dataclass(frozen=True)
class AuthorizedGraphNode:
    node_id: str
    label: Literal["Folder", "File"]
    name: str
    path: str
    scope: RetrievalScope
    distance: int


@dataclass(frozen=True)
class AuthorizedTraversal:
    anchor: AuthorizedGraphNode
    nodes: tuple[AuthorizedGraphNode, ...]


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    graph_node_id: str
    content: str
    token_count: int


@dataclass(frozen=True)
class RetrievalAnswer:
    answer: str
    anchor_node_id: str
    context_node_ids: tuple[str, ...]
    context_chunk_count: int
    context_tokens_used: int
    prompt_tokens_used: int

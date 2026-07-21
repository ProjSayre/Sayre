"""Shared tree-sitter plumbing for every `LanguageAdapter`: the ABC each
language implements, the internal `FileExtract` aggregate, and node/text
utilities that are identical across languages (span extraction,
whitespace-collapsed signature text, scope-chain qualified-name construction,
`.scm` query loading).

Parsing-only boundary (see package `__init__.py` docstring): nothing here
reaches for a filesystem, a graph, or a queue — only `tree_sitter`
Node/Tree/Language objects and plain Python.

Query execution note (tree-sitter 0.23.2, confirmed empirically against the
installed `tree-sitter`/`tree-sitter-language-pack` versions rather than
assumed): `Language.query(scm_text)` returns a `Query`; `Query.captures(node)`
returns `dict[str, list[Node]]`. There is no `QueryCursor` in this version —
adapters call `.captures()` directly. The whole-tree walk that finds captured
nodes happens inside tree-sitter's C query engine, not Python recursion, so
`.scm`-driven discovery inherently satisfies the "walk iteratively, no deep
Python recursion" requirement. The remaining per-node work in each adapter
(field extraction, ancestor-chain walks bounded by tree depth) is likewise
iterative — see `ancestor_scope_chain()` below.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import resources
from typing import ClassVar, Literal

import tree_sitter

from sayre_workers.parsing.models import (
    Language,
    ParsedCall,
    ParsedClass,
    ParsedFunction,
    ParsedImport,
    ParsedInheritance,
)

_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class FileExtract:
    """One file's raw records, before `parser.py` aggregates + canonically
    sorts across the whole `parse_full`/`parse_diff` call. Internal to this
    package — never returned to a W1-01 caller directly (that's
    `ParseResult`'s job)."""

    functions: list[ParsedFunction] = field(default_factory=list)
    classes: list[ParsedClass] = field(default_factory=list)
    imports: list[ParsedImport] = field(default_factory=list)
    calls: list[ParsedCall] = field(default_factory=list)
    inherits: list[ParsedInheritance] = field(default_factory=list)


class LanguageAdapter(ABC):
    """One grammar's `Tree -> FileExtract` extraction.

    A pure function of (file_path, source bytes, parsed Tree) -> records; it
    never re-selects a grammar or touches a `Parser` itself (that is
    `parser.py`'s job), so adapters are unit-testable against a hand-parsed
    `Tree` without going through the registry.
    """

    language: ClassVar[Language]

    def grammar_name(self, path: str) -> str:
        """tree-sitter-language-pack grammar name for this adapter given the
        file path. Default: the language name itself. `TypeScriptAdapter`
        overrides this to distinguish the `"tsx"` grammar (for `.tsx` files)
        from `"typescript"` (for `.ts` files) — confirmed both grammar names
        exist in the installed `tree-sitter-language-pack` (0.9.1)."""
        return self.language

    @abstractmethod
    def extract(
        self, *, file_path: str, source: bytes, tree: tree_sitter.Tree
    ) -> FileExtract:
        """Pure `Tree -> FileExtract`. Must not raise for well-formed OR
        tree-sitter-error-tolerant malformed trees (tree-sitter yields
        ERROR/MISSING nodes for broken syntax; it never raises on `.parse()`)
        — best-effort extraction only. Only a genuinely unexpected
        adapter-internal bug should propagate; `parser.py` maps any exception
        raised here to `SkippedFile(reason="parse_error")`."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Span / text helpers
# ---------------------------------------------------------------------------


def node_span(node: tree_sitter.Node) -> tuple[int, int]:
    """1-based `(start_line, end_line)` for a node. tree-sitter rows are
    0-based internally."""
    start_line = node.start_point[0] + 1
    end_line = node.end_point[0] + 1
    return start_line, end_line


def node_bytes(node: tree_sitter.Node) -> bytes:
    """A node's already-sliced source bytes. `Node.text` is typed
    `bytes | None` in tree-sitter's stubs (`None` only for a node with no
    associated source, which does not occur for any node an adapter
    processes here) — this narrows it to `bytes` for callers."""
    return node.text or b""


def node_text(node: tree_sitter.Node) -> str:
    """Decode a node's already-sliced source bytes as UTF-8.

    Safe to call unconditionally: `parser.py` validates that the whole file
    decodes as UTF-8 (skipping to `SkippedFile(reason="decode_error")`
    otherwise) before any adapter ever sees the file, so every node's bytes
    here are a sub-slice of an already-valid-UTF-8 document.
    """
    return node_bytes(node).decode("utf-8")


def normalize_signature(text: str) -> str:
    """Collapse all whitespace runs (including newlines) to a single space
    and strip leading/trailing space, so a multi-line declaration header
    becomes one deterministic line."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def strip_string_quotes(text: str) -> str:
    """Strip a single layer of matching quote characters (', ", `) from a
    string-literal node's raw text, e.g. '"./util"' -> './util'. Returns the
    text unchanged if it isn't quoted that way (defensive; should not happen
    for an actual string node)."""
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'`":
        return text[1:-1]
    return text


# ---------------------------------------------------------------------------
# Scope chain — qualified_name / enclosing_class / caller_qualified_name
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScopeFrame:
    """One named enclosing function or class scope."""

    kind: Literal["function", "class"]
    name: str


ScopeClassifier = Callable[[tree_sitter.Node], "ScopeFrame | None"]


def ancestor_scope_chain(node: tree_sitter.Node, classify: ScopeClassifier) -> list[ScopeFrame]:
    """Walk `node.parent` from `node` up to the tree root — iterative, no
    recursion, bounded by tree depth — collecting a `ScopeFrame` for every
    ancestor `classify()` recognizes as a named function/class scope, in
    OUTERMOST-first order.

    `node` itself is never classified — only its ancestors. Ancestors
    `classify()` returns `None` for (blocks, module/program roots, decorator
    wrappers, anonymous closures) are transparent: they are skipped, not
    treated as scope boundaries, so e.g. a function nested inside an `if`
    block still resolves its true enclosing function/class correctly.
    """
    frames: list[ScopeFrame] = []
    current = node.parent
    while current is not None:
        frame = classify(current)
        if frame is not None:
            frames.append(frame)
        current = current.parent
    frames.reverse()
    return frames


def build_qualified_name(chain: list[ScopeFrame], name: str) -> str:
    """`chain` is OUTERMOST-first (see `ancestor_scope_chain`); joins every
    frame's name with `name` via `.`, e.g. `["Outer", "inner"] + "leaf"` ->
    `"Outer.inner.leaf"`."""
    if not chain:
        return name
    return ".".join(frame.name for frame in chain) + "." + name


def enclosing_class_name(chain: list[ScopeFrame]) -> str | None:
    """Simple class name IFF the immediately-enclosing scope is a class
    (i.e. this is a genuine method) — a function nested inside another
    function that happens to itself be inside a class is NOT treated as a
    method (`enclosing_class` is `None`), matching
    `ParsedFunction.enclosing_class`'s docstring ("simple class name if this
    is a method, else None")."""
    if chain and chain[-1].kind == "class":
        return chain[-1].name
    return None


def enclosing_function_qualified_name(chain: list[ScopeFrame]) -> str | None:
    """`qualified_name` of the nearest enclosing FUNCTION frame (skipping
    over any class frames), or `None` if no function encloses this point
    (module-level or class-body-level, outside any method) — used for
    `ParsedCall.caller_qualified_name`."""
    for index in range(len(chain) - 1, -1, -1):
        if chain[index].kind == "function":
            return build_qualified_name(chain[:index], chain[index].name)
    return None


# ---------------------------------------------------------------------------
# .scm loader
# ---------------------------------------------------------------------------


def load_query_source(filename: str) -> str:
    """Read a package-relative `.scm` query file from
    `sayre_workers/parsing/queries/`, e.g. `load_query_source("python.scm")`."""
    package = "sayre_workers.parsing.queries"
    return resources.files(package).joinpath(filename).read_text(encoding="utf-8")

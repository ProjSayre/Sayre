"""Pydantic record models for W1-01's parse output — the `ParseResult` shape
that `parser.parse_full`/`parse_diff` return and that W1-05 later consumes to
resolve into Neo4j nodes/edges.

Every model here is deliberately tenant-free: no org_id/repo_id/ref_name/
revision_sha/uid anywhere (see package `__init__.py`'s scope boundary — W1-01
has no tenant context; W1-05 stamps identity on write). Frozen + extra
="forbid", matching `messaging/envelope.py`'s strictness — these records cross
a module boundary to W1-05 and are serialized to golden-JSON snapshots, so an
accidental extra/mutated field should fail loudly, not silently drift.

Chosen over dataclasses because ParseResult needs `model_dump()`/canonical
JSON for snapshotting and a module-boundary validation contract for free.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict

Language = Literal["python", "javascript", "typescript", "go"]

_MODEL_CONFIG = ConfigDict(frozen=True, extra="forbid")


class SourceFile(BaseModel):
    """One file handed to `parse_full`/`parse_diff`.

    `path` is a repo-relative canonical POSIX path (e.g. "src/app.py") —
    never absolute, never a scratch-clone path. W1-01 receives file content
    in memory; it never walks a filesystem or decides which files changed.
    """

    model_config = _MODEL_CONFIG

    path: str
    content: bytes


class ParsedFunction(BaseModel):
    """One function or method declaration. Line numbers are 1-based."""

    model_config = _MODEL_CONFIG

    file_path: str
    name: str
    qualified_name: str
    signature: str
    enclosing_class: str | None
    start_line: int
    end_line: int


class ParsedClass(BaseModel):
    """One class declaration (Go has no classes — GoAdapter never emits
    these; see `adapters/go.py`)."""

    model_config = _MODEL_CONFIG

    file_path: str
    name: str
    qualified_name: str
    base_names: list[str]
    start_line: int
    end_line: int


class ParsedImport(BaseModel):
    """One import statement / import spec.

    `module` and `symbols` are RAW, UNRESOLVED strings exactly as written in
    source — resolving `module` to a concrete `File` node is W1-05's job
    (whole-graph, revision-scoped work this module cannot do), not W1-01's.
    """

    model_config = _MODEL_CONFIG

    file_path: str
    module: str
    symbols: list[str]
    is_relative: bool
    start_line: int


class ParsedCall(BaseModel):
    """One call-expression site.

    `callee_name` is the RAW, UNRESOLVED callee text exactly as written
    (e.g. "foo", "obj.bar", "pkg.Fn") — never resolved to a concrete
    `Function` node.
    """

    model_config = _MODEL_CONFIG

    file_path: str
    caller_qualified_name: str | None
    callee_name: str
    start_line: int


class ParsedInheritance(BaseModel):
    """One subclass -> base edge candidate. ONE row per base (a class with N
    bases produces N rows). `base_name` is RAW/UNRESOLVED — never resolved to
    a concrete `Class` node."""

    model_config = _MODEL_CONFIG

    file_path: str
    subclass_qualified_name: str
    base_name: str


class SkippedFile(BaseModel):
    """A file `parse_full`/`parse_diff` did not produce records for."""

    model_config = _MODEL_CONFIG

    path: str
    reason: Literal["unsupported_extension", "decode_error", "parse_error"]


class ParseResult(BaseModel):
    """The full output of one `parse_full`/`parse_diff` call.

    See `parser.py` for the two public entry points and `adapters/base.py`
    for the per-language extraction that feeds this. `deleted_file_paths` is
    populated ONLY by `parse_diff`; always `[]` for `parse_full`.
    """

    model_config = _MODEL_CONFIG

    functions: list[ParsedFunction]
    classes: list[ParsedClass]
    imports: list[ParsedImport]
    calls: list[ParsedCall]
    inherits: list[ParsedInheritance]
    parsed_files: list[str]
    skipped_files: list[SkippedFile]
    deleted_file_paths: list[str]

    def canonical_json(self) -> str:
        """The one true snapshot/determinism serialization for this result.
        See module-level `to_canonical_json()` for the exact format and
        rationale."""
        return to_canonical_json(self)


def to_canonical_json(result: ParseResult) -> str:
    """Canonical JSON serialization used by both production determinism
    guarantees and golden-snapshot tests: `sort_keys=True`, `indent=2`,
    `ensure_ascii=False`, trailing newline.

    Note `sort_keys=True` only orders each JSON *object's* own keys — LIST
    order (which record comes before which) is a production guarantee
    established by `parser.py`'s canonical sort *before* this model is ever
    constructed, not by this function. Both matter for byte-identical output
    regardless of input file order.
    """
    data = result.model_dump(mode="json")
    return json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + "\n"

"""Stable v1 graph identity and same-scope COVERS enforcement."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

CoverageStatus = Literal["pass", "fail", "unknown"]
CoversStatus = Literal["inferred", "measured"]
COVERAGE_STATUSES: tuple[CoverageStatus, ...] = ("pass", "fail", "unknown")
COVERS_STATUSES: tuple[CoversStatus, ...] = ("inferred", "measured")

REF_SCOPED_NODE_KINDS = frozenset(
    {"Folder", "File", "Function", "Class", "Module", "Feature", "EnvStep", "Test"}
)
_PATH_ONLY_KINDS = frozenset({"Folder", "File"})
_REQUIRED_SYMBOL_KINDS = frozenset({"Function", "Class"})
_REVISION_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class GraphIdentityError(ValueError):
    """Raised for a malformed graph scope or stable-identity input."""


class CoversScopeMismatchError(ValueError):
    def __init__(self) -> None:
        super().__init__("COVERS endpoints must have identical graph scope.")


def _require_nonempty(name: str, value: str) -> None:
    if not isinstance(value, str) or not value:
        raise GraphIdentityError(f"{name} must be a nonempty string")
    if "\x00" in value:
        raise GraphIdentityError(f"{name} must not contain NUL")


@dataclass(frozen=True, slots=True)
class GraphScope:
    org_id: str
    repo_id: str
    ref_name: str
    revision_sha: str

    def __post_init__(self) -> None:
        _require_nonempty("org_id", self.org_id)
        _require_nonempty("repo_id", self.repo_id)
        _require_nonempty("ref_name", self.ref_name)
        if not _REVISION_RE.fullmatch(self.revision_sha):
            raise GraphIdentityError("revision_sha must be lowercase 40- or 64-hex")


def _canonical_path(value: str) -> str:
    _require_nonempty("canonical_path", value)
    normalized = unicodedata.normalize("NFC", value)
    if normalized.startswith("/") or "\\" in normalized:
        raise GraphIdentityError("canonical_path must be a relative POSIX path")
    segments = normalized.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise GraphIdentityError("canonical_path contains a forbidden path segment")
    return normalized


def stable_node_uid(
    *,
    repo_id: str,
    ref_name: str,
    node_kind: str,
    canonical_path: str,
    symbol: str | None = None,
) -> str:
    """Return `v1:<sha256>` over compact, sorted, UTF-8 canonical JSON."""
    _require_nonempty("repo_id", repo_id)
    _require_nonempty("ref_name", ref_name)
    if node_kind not in REF_SCOPED_NODE_KINDS:
        raise GraphIdentityError("node_kind is not a supported ref-scoped label")
    path = _canonical_path(canonical_path)

    normalized_symbol: str | None = None
    if symbol is not None:
        _require_nonempty("symbol", symbol)
        normalized_symbol = unicodedata.normalize("NFC", symbol)
    if node_kind in _PATH_ONLY_KINDS and normalized_symbol is not None:
        raise GraphIdentityError("Folder and File identities must not include symbol")
    if node_kind in _REQUIRED_SYMBOL_KINDS and normalized_symbol is None:
        raise GraphIdentityError("Function and Class identities require symbol")

    payload: dict[str, str] = {
        "canonical_path": path,
        "node_kind": node_kind,
        "ref_name": ref_name,
        "repo_id": repo_id,
    }
    if normalized_symbol is not None:
        payload["symbol"] = normalized_symbol
    canonical_json = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"v1:{hashlib.sha256(canonical_json).hexdigest()}"


def require_same_covers_scope(test_scope: GraphScope, covered_scope: GraphScope) -> None:
    if test_scope != covered_scope:
        raise CoversScopeMismatchError

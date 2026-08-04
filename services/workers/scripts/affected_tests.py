"""PL-03b: `get_affected_tests` — the v1 (local) test-impact resolver.

Given a set of changed repo-relative file paths, returns the ranked set of
EXISTING tests most likely affected by that change, plus honest disclosure of
this tool's own limits. This is the regression half of TDAD (see
`docs/sdd-tdad-design.md` Section 2) -- new behavior with no test yet is the
`red` stage's job (PL-03c), not this one.

Why this is NOT graph-backed yet (see the design doc for the full argument):
Sayre already ships `get_covering_tests`, an MCP tool over `Test`/`COVERS` in
Neo4j. Every `COVERS` edge for THIS repo would be `inferred` -- produced by
the pure, graph-free `sayre_workers.parsing.coverage` module -- never
`measured`, so routing through Neo4j returns the identical answer with a
distributed system in the middle. `COVERS` is also unweighted, so backward
traversal from a hub file returns much of the suite; ranking (depth +
coupling) is the entire point of this ticket. Build v1 local; `get_affected_tests`'s
signature is designed so v2 (graph-backed, trigger-gated on this repo having
real `measured` coverage) is a body swap behind the same signature.

Layering (non-negotiable -- see `sayre_workers/parsing/__init__.py`'s own
boundary docstring): the parsing package is pure/in-memory/graph-free -- no
git, no subprocess, no repo-walking. This script is the IMPURE SHELL around
it: it runs `git` (via subprocess) to find the repo root, enumerate files,
and compute a cache key; it reads file bytes itself; it hands
`SourceFile(path, content)` records to `parse_full` (the pure core does no
I/O of its own). Only `coverage.is_test_file` is reused from `coverage.py` --
per the ticket, the general (any-file-to-any-file, multi-hop) import-graph
resolution this script needs is a different job than `coverage.py`'s private,
test-specific one-hop resolver, so it is written fresh here rather than
reached into as an undocumented dependency. `sayre_workers/parsing/**` is
never modified.

No graph, MCP, or network call anywhere in this module: no `neo4j`, no
`boto3`, no queue client.

CLI usage (from `services/workers/` -- positional paths are resolved relative
to the current directory, like any other CLI tool, then converted to the
repo-root-relative form `get_affected_tests` itself always uses internally):
    poetry run python scripts/affected_tests.py src/foo.py src/bar.ts
    poetry run python scripts/affected_tests.py --diff-base main
    poetry run python scripts/affected_tests.py --staged --format text
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

sys.path.insert(0, ".")  # allow running as `python scripts/affected_tests.py`

from sayre_workers.parsing import ParsedCall, ParsedImport, SourceFile, parse_full  # noqa: E402
from sayre_workers.parsing.coverage import is_test_file  # noqa: E402
from sayre_workers.parsing.registry import language_for_path  # noqa: E402

DEFAULT_MAX_SHOWN = 15
MAX_DEPTH = 3

_JS_EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")
_PY_DYNAMIC_IMPORT_CALLEES = {"import_module", "__import__"}
_JS_DYNAMIC_IMPORT_CALLEES = {"require", "import"}
_REEXPORT_BARREL_RE = re.compile(r"""export\s*(?:\*|\{[^{}]*\})\s*from\s*['"]""")

UnanalyzableReason = Literal[
    "file_not_found",
    "no_import_graph_signal",
    "decode_error",
    "parse_error",
    "dynamic_import",
    "unresolvable_specifier",
    "re_export_barrel",
]


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AffectedTest:
    path: str
    depth: int
    coupling: int
    rank: int


@dataclass(frozen=True)
class UnanalyzableFile:
    path: str
    reason: str


@dataclass(frozen=True)
class Truncation:
    shown: int
    total: int
    reason: str | None


@dataclass(frozen=True)
class AffectedTestsResult:
    tests: list[AffectedTest]
    truncated: Truncation
    confidence: Literal["high", "partial"]
    unanalyzable: list[UnanalyzableFile]

    def to_dict(self) -> dict:
        return {
            "tests": [asdict(test) for test in self.tests],
            "truncated": asdict(self.truncated),
            "confidence": self.confidence,
            "unanalyzable": [asdict(entry) for entry in self.unanalyzable],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AffectedTestsResult":
        return cls(
            tests=[AffectedTest(**entry) for entry in data["tests"]],
            truncated=Truncation(**data["truncated"]),
            confidence=data["confidence"],
            unanalyzable=[UnanalyzableFile(**entry) for entry in data["unanalyzable"]],
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def get_affected_tests(
    changed_paths: Sequence[str],
    *,
    repo_root: Path | None = None,
    max_shown: int = DEFAULT_MAX_SHOWN,
    cache_dir: Path | None = None,
    use_cache: bool = True,
) -> AffectedTestsResult:
    """Given changed repo-relative paths, return the ranked set of existing
    tests most likely affected, with honest limits. See module docstring for
    the full design rationale; see `docs/sdd-tdad-design.md` Section 2 for
    the v1/v2 plan this signature is built to support unchanged."""
    resolved_root = repo_root if repo_root is not None else _discover_repo_root()
    normalized_changed = _normalize_changed_paths(changed_paths, resolved_root)

    resolved_cache_dir = (
        cache_dir if cache_dir is not None else resolved_root / ".pipeline" / "affected-tests-cache"
    )
    cache_key = None
    if use_cache:
        state_hash = _repo_state_hash(resolved_root, resolved_cache_dir)
        cache_key = _compute_cache_key(state_hash, normalized_changed, max_shown)
        cached = _read_cache(resolved_cache_dir, cache_key)
        if cached is not None:
            return cached

    result = _compute(normalized_changed, resolved_root, max_shown)

    if use_cache and cache_key is not None:
        _write_cache(resolved_cache_dir, cache_key, result)
    return result


# ---------------------------------------------------------------------------
# Core computation
# ---------------------------------------------------------------------------


def _compute(changed_paths: list[str], repo_root: Path, max_shown: int) -> AffectedTestsResult:
    unanalyzable: list[UnanalyzableFile] = []

    all_repo_paths = _list_repository_files(repo_root)
    supported_repo_paths = {path for path in all_repo_paths if language_for_path(path) is not None}

    changed_supported: list[str] = []
    for path in changed_paths:
        full_path = repo_root / path
        if not full_path.is_file():
            unanalyzable.append(UnanalyzableFile(path, "file_not_found"))
            continue
        if language_for_path(path) is None:
            unanalyzable.append(UnanalyzableFile(path, "no_import_graph_signal"))
            continue
        changed_supported.append(path)

    paths_to_parse = sorted(supported_repo_paths | set(changed_supported))
    contents_by_path: dict[str, bytes] = {}
    source_files: list[SourceFile] = []
    for path in paths_to_parse:
        content = (repo_root / path).read_bytes()
        contents_by_path[path] = content
        source_files.append(SourceFile(path=path, content=content))

    parse_result = parse_full(source_files)
    parsed_set = set(parse_result.parsed_files)

    skipped_reason_by_path = {entry.path: entry.reason for entry in parse_result.skipped_files}
    for path in changed_supported:
        skip_reason = skipped_reason_by_path.get(path)
        if skip_reason == "decode_error":
            unanalyzable.append(UnanalyzableFile(path, "decode_error"))
        elif skip_reason == "parse_error":
            unanalyzable.append(UnanalyzableFile(path, "parse_error"))

    analyzable_changed = [path for path in changed_supported if path in parsed_set]

    calls_by_file: dict[str, list[ParsedCall]] = defaultdict(list)
    for call in parse_result.calls:
        calls_by_file[call.file_path].append(call)
    imports_by_file: dict[str, list[ParsedImport]] = defaultdict(list)
    for parsed_import in parse_result.imports:
        imports_by_file[parsed_import.file_path].append(parsed_import)

    for path in analyzable_changed:
        if _has_unresolvable_dynamic_import(path, calls_by_file.get(path, [])):
            unanalyzable.append(UnanalyzableFile(path, "dynamic_import"))
        if _has_unresolvable_relative_import(imports_by_file.get(path, []), parsed_set):
            unanalyzable.append(UnanalyzableFile(path, "unresolvable_specifier"))
        if _has_reexport_barrel_pattern(path, contents_by_path.get(path, b"")):
            unanalyzable.append(UnanalyzableFile(path, "re_export_barrel"))

    reverse_graph = _build_reverse_import_graph(parse_result.imports, parsed_set)

    # test_path -> {changed_path: depth}
    test_hits: dict[str, dict[str, int]] = defaultdict(dict)
    for changed_path in analyzable_changed:
        distances = _bfs_reverse(reverse_graph, changed_path, MAX_DEPTH)
        for node, depth in distances.items():
            if depth == 0:
                continue
            if is_test_file(node):
                test_hits[node][changed_path] = depth
        # A changed test file is trivially affected by its own change.
        if is_test_file(changed_path):
            test_hits[changed_path].setdefault(changed_path, 0)

    ranked_keys: list[tuple[int, int, int, str]] = []
    for test_path, per_changed_depth in test_hits.items():
        depth = min(per_changed_depth.values())
        coupling = len(per_changed_depth)
        nearest = [c for c, d in per_changed_depth.items() if d == depth]
        proximity = min(_path_proximity(test_path, c) for c in nearest)
        ranked_keys.append((depth, -coupling, proximity, test_path))
    ranked_keys.sort()

    total = len(ranked_keys)
    shown = min(total, max_shown)
    tests_out = [
        AffectedTest(path=test_path, depth=depth, coupling=-neg_coupling, rank=index)
        for index, (depth, neg_coupling, _proximity, test_path) in enumerate(
            ranked_keys[:shown], start=1
        )
    ]

    if shown < total:
        boundary_depth = ranked_keys[shown][0]
        reason: str | None = (
            f"showing {shown} of {total}; {total - shown} omitted at depth >= {boundary_depth}"
        )
    else:
        reason = None

    truncated = Truncation(shown=shown, total=total, reason=reason)
    confidence: Literal["high", "partial"] = "partial" if unanalyzable else "high"
    unanalyzable.sort(key=lambda entry: (entry.path, entry.reason))

    return AffectedTestsResult(
        tests=tests_out,
        truncated=truncated,
        confidence=confidence,
        unanalyzable=unanalyzable,
    )


# ---------------------------------------------------------------------------
# Import graph construction (own resolution logic -- see module docstring on
# why this does not reach into `coverage.py`'s private resolver)
# ---------------------------------------------------------------------------


def _build_reverse_import_graph(
    imports: Sequence[ParsedImport], parsed_paths: set[str]
) -> dict[str, set[str]]:
    """`target_path -> {source paths that import it}`, resolved only where a
    single unambiguous target file exists among `parsed_paths` -- never a
    guess among multiple candidates."""
    reverse: dict[str, set[str]] = defaultdict(set)
    for parsed_import in imports:
        for target in _resolve_import_targets(parsed_import, parsed_paths):
            if target != parsed_import.file_path:
                reverse[target].add(parsed_import.file_path)
    return reverse


def _resolve_import_targets(parsed_import: ParsedImport, candidates: set[str]) -> list[str]:
    suffix = PurePosixPath(parsed_import.file_path).suffix.lower()
    if suffix == ".py":
        return _resolve_python_import(parsed_import, candidates)
    if suffix in _JS_EXTENSIONS:
        return _resolve_js_import(parsed_import, candidates)
    if suffix == ".go":
        return _resolve_go_import(parsed_import.module, candidates)
    return []


def _resolve_python_import(parsed_import: ParsedImport, candidates: set[str]) -> list[str]:
    module = parsed_import.module
    bases: list[str] = []
    if module.startswith("."):
        level = len(module) - len(module.lstrip("."))
        parent_parts = list(PurePosixPath(parsed_import.file_path).parent.parts)
        keep = max(0, len(parent_parts) - (level - 1))
        package_parts = parent_parts[:keep]
        tail = module[level:]
        if tail:
            package_parts.extend(tail.split("."))
        bases.append("/".join(package_parts))
    else:
        bases.append("/".join(module.split(".")))

    resolved: list[str] = []
    for base in bases:
        base = base.strip("/")
        if not base:
            continue
        candidate_files = (f"{base}.py", f"{base}/__init__.py")
        resolved.extend(_exact_or_unique_suffix(candidate_files, candidates))
    return sorted(set(resolved))


def _resolve_js_import(parsed_import: ParsedImport, candidates: set[str]) -> list[str]:
    module = parsed_import.module
    if not parsed_import.is_relative and not module.startswith("."):
        return []  # bare/absolute specifier -- assumed external, never a guess
    base = _posix_normpath(_posix_join(_posix_dirname(parsed_import.file_path), module))

    has_extension = base.lower().endswith(_JS_EXTENSIONS)
    candidate_files = (
        [base]
        if has_extension
        else [
            *(f"{base}{extension}" for extension in _JS_EXTENSIONS),
            *(f"{base}/index{extension}" for extension in _JS_EXTENSIONS),
        ]
    )
    return _exact_or_unique_suffix(candidate_files, candidates)


def _resolve_go_import(module: str, candidates: set[str]) -> list[str]:
    module = module.strip("/")
    matches = sorted(
        path
        for path in candidates
        if path.lower().endswith(".go")
        and not is_test_file(path)
        and (_posix_dirname(path) == module or _posix_dirname(path).endswith(f"/{module}"))
    )
    return matches


def _exact_or_unique_suffix(candidate_files: Sequence[str], candidates: set[str]) -> list[str]:
    exact = sorted({candidate for candidate in candidate_files if candidate in candidates})
    if exact:
        return exact
    suffix_matches = sorted(
        {path for candidate in candidate_files for path in candidates if path.endswith(f"/{candidate}")}
    )
    return suffix_matches if len(suffix_matches) == 1 else []


def _posix_dirname(path: str) -> str:
    return PurePosixPath(path).parent.as_posix()


def _posix_join(base: str, other: str) -> str:
    if base in ("", "."):
        return other
    return f"{base}/{other}"


def _posix_normpath(path: str) -> str:
    parts: list[str] = []
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts and parts[-1] != "..":
                parts.pop()
            else:
                parts.append(segment)
        else:
            parts.append(segment)
    return "/".join(parts)


# ---------------------------------------------------------------------------
# BFS ranking
# ---------------------------------------------------------------------------


def _bfs_reverse(reverse_graph: dict[str, set[str]], start: str, max_depth: int) -> dict[str, int]:
    distances: dict[str, int] = {start: 0}
    frontier = [start]
    depth = 0
    while frontier and depth < max_depth:
        depth += 1
        next_frontier: list[str] = []
        for node in frontier:
            for predecessor in reverse_graph.get(node, ()):
                if predecessor not in distances:
                    distances[predecessor] = depth
                    next_frontier.append(predecessor)
        frontier = next_frontier
    return distances


def _path_proximity(test_path: str, changed_path: str) -> int:
    """Lower is more proximate: total non-shared leading directory segments
    between the two paths' parent directories."""
    test_parts = PurePosixPath(test_path).parent.parts
    changed_parts = PurePosixPath(changed_path).parent.parts
    shared = 0
    for a, b in zip(test_parts, changed_parts):
        if a != b:
            break
        shared += 1
    return (len(test_parts) - shared) + (len(changed_parts) - shared)


# ---------------------------------------------------------------------------
# Honest-limits detectors (own heuristics -- do not touch sayre_workers/parsing)
# ---------------------------------------------------------------------------


def _has_unresolvable_dynamic_import(path: str, calls: Sequence[ParsedCall]) -> bool:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix == ".py":
        return any(
            call.callee_name in _PY_DYNAMIC_IMPORT_CALLEES
            or call.callee_name.endswith(".import_module")
            for call in calls
        )
    if suffix in _JS_EXTENSIONS:
        # `sayre_workers.parsing`'s JS/TS adapter only leaves a require()/
        # dynamic import() call in `calls` (rather than promoting it to
        # `ParsedImport`) when it could NOT resolve a single literal string
        # argument -- so every such call here is, by construction, one our
        # static resolver already tried and failed to trace.
        return any(call.callee_name in _JS_DYNAMIC_IMPORT_CALLEES for call in calls)
    return False


def _has_unresolvable_relative_import(
    imports: Sequence[ParsedImport], parsed_paths: set[str]
) -> bool:
    for parsed_import in imports:
        module = parsed_import.module
        is_relative_like = parsed_import.is_relative or module.startswith(".")
        if not is_relative_like:
            continue
        if not _resolve_import_targets(parsed_import, parsed_paths):
            return True
    return False


def _has_reexport_barrel_pattern(path: str, content: bytes) -> bool:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix not in _JS_EXTENSIONS:
        return False
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return bool(_REEXPORT_BARREL_RE.search(text))


# ---------------------------------------------------------------------------
# Impure shell: repo discovery, file listing, changed-path normalization
# ---------------------------------------------------------------------------


def _discover_repo_root(start: Path | None = None) -> Path:
    start = start if start is not None else Path.cwd()
    output = _try_run_git(start, ["rev-parse", "--show-toplevel"])
    if output is None:
        raise RuntimeError(
            "affected_tests.py could not find a git repository root; pass repo_root= explicitly "
            "or run from inside a git checkout."
        )
    return Path(output.strip())


def _normalize_changed_paths(changed_paths: Sequence[str], repo_root: Path) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    resolved_root = repo_root.resolve()
    for raw in changed_paths:
        candidate = Path(raw)
        if candidate.is_absolute():
            try:
                candidate = candidate.resolve().relative_to(resolved_root)
            except ValueError:
                pass  # leave outside-root paths as-is; they'll surface as file_not_found
        posix_path = candidate.as_posix()
        if posix_path not in seen:
            seen.add(posix_path)
            normalized.append(posix_path)
    return normalized


_FALLBACK_IGNORED_DIR_NAMES = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        ".next",
        "target",
        ".pipeline",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
    }
)


def _list_repository_files(repo_root: Path) -> list[str]:
    tracked = _try_run_git(repo_root, ["ls-files", "-z"])
    if tracked is not None:
        untracked = _try_run_git(repo_root, ["ls-files", "-z", "--others", "--exclude-standard"])
        paths: set[str] = set()
        for chunk in (tracked, untracked or ""):
            for entry in chunk.split("\0"):
                if entry:
                    paths.add(entry)
        return sorted(paths)
    return _walk_repository_files(repo_root)


def _walk_repository_files(repo_root: Path) -> list[str]:
    """Fallback used when `repo_root` isn't a git checkout (e.g. an isolated
    test fixture directory) -- a plain recursive walk excluding the usual
    heavy/generated directories."""
    paths: list[str] = []
    for candidate in repo_root.rglob("*"):
        if not candidate.is_file():
            continue
        relative = candidate.relative_to(repo_root)
        if any(part in _FALLBACK_IGNORED_DIR_NAMES for part in relative.parts[:-1]):
            continue
        paths.append(relative.as_posix())
    return sorted(paths)


# ---------------------------------------------------------------------------
# Caching -- keyed by git tree hash so staleness is structurally impossible
# ---------------------------------------------------------------------------


def _repo_state_hash(repo_root: Path, cache_dir: Path) -> str:
    """Composite fingerprint of the repo's current content. `cache_dir` is
    excluded from the fingerprint itself -- otherwise writing a cache entry
    would change the very state the next call's key is derived from, making
    every call a guaranteed miss (self-referential invalidation)."""
    base_tree = _try_run_git(repo_root, ["rev-parse", "HEAD^{tree}"])
    if base_tree is None:
        return _fallback_content_hash(repo_root, cache_dir)

    fingerprint_parts = [base_tree.strip()]
    status_output = _try_run_git(
        repo_root, ["status", "--porcelain=v1", "--untracked-files=all"]
    )
    for line in (status_output or "").splitlines():
        if not line:
            continue
        rest = line[3:] if len(line) > 3 else line
        if " -> " in rest:
            _, _, rest = rest.partition(" -> ")
        path = rest.strip()
        if not path:
            continue
        full_path = repo_root / path
        if _is_under(full_path, cache_dir):
            continue
        if full_path.is_file():
            blob_hash = _try_run_git(repo_root, ["hash-object", str(full_path)])
            fingerprint_parts.append(f"{path}:{(blob_hash or 'unreadable').strip()}")
        else:
            fingerprint_parts.append(f"{path}:deleted")

    digest_input = "\n".join(sorted(fingerprint_parts[1:]))
    digest_input = fingerprint_parts[0] + "\n" + digest_input
    return hashlib.sha256(digest_input.encode("utf-8")).hexdigest()


def _is_under(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def _fallback_content_hash(repo_root: Path, cache_dir: Path) -> str:
    """No-git fallback: hash every listed file's content directly. Only used
    outside a git checkout; deliberately simple since it need not scale to a
    real monorepo (the real repo always has git available)."""
    hasher = hashlib.sha256()
    for path in _list_repository_files(repo_root):
        full_path = repo_root / path
        if _is_under(full_path, cache_dir):
            continue
        hasher.update(path.encode("utf-8"))
        try:
            hasher.update(full_path.read_bytes())
        except OSError:
            hasher.update(b"unreadable")
    return hasher.hexdigest()


def _compute_cache_key(state_hash: str, changed_paths: list[str], max_shown: int) -> str:
    payload = f"{state_hash}\n{max_shown}\n" + "\n".join(sorted(changed_paths))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _read_cache(cache_dir: Path, key: str) -> AffectedTestsResult | None:
    # Not a control input in SEC-10's sense (security round 6's "audit every remaining JSON.parse /
    # json.loads call site" pass): this is a same-tool, same-machine performance cache this script
    # wrote to itself on a prior run, not a persisted artifact a distinct, less-trusted process
    # produces for a later trust decision. json.loads's own last-key-wins behavior on a duplicate key
    # has no analog to exploit here -- there is no security verdict or attribution decision riding on
    # this value, only which tests get selected to run. A corrupt or unexpected shape already falls
    # back to a full recompute below (never a crash, never a silently wrong "trusted" answer), so no
    # stricter parser is used or needed.
    cache_file = cache_dir / f"{key}.json"
    if not cache_file.is_file():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return AffectedTestsResult.from_dict(data)
    except (OSError, ValueError, KeyError, TypeError):
        return None  # corrupt/stale-shape cache entry -- recompute rather than crash


def _write_cache(cache_dir: Path, key: str, result: AffectedTestsResult) -> None:
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file = cache_dir / f"{key}.json"
        cache_file.write_text(json.dumps(result.to_dict(), indent=2), encoding="utf-8")
    except OSError:
        pass  # caching is an optimization; a write failure must not fail the call


def _try_run_git(repo_root: Path, args: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, FileNotFoundError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_path_relative_to_repo_root(raw: str, repo_root: Path) -> str:
    """Human-typed CLI path arguments are naturally CWD-relative (standard
    CLI convention -- `git diff --name-only` output, by contrast, is already
    repo-root-relative, so this is applied only to explicit positional
    arguments, never to git-derived paths)."""
    candidate = Path(raw)
    absolute = candidate if candidate.is_absolute() else Path.cwd() / candidate
    try:
        return absolute.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return candidate.as_posix()  # leave as-is; surfaces as file_not_found downstream


def _git_diff_paths(repo_root: Path, *, diff_base: str | None, staged: bool) -> list[str]:
    if staged:
        output = _try_run_git(repo_root, ["diff", "--name-only", "--cached"])
    elif diff_base:
        output = _try_run_git(repo_root, ["diff", "--name-only", f"{diff_base}...HEAD"])
        if output is None:
            output = _try_run_git(repo_root, ["diff", "--name-only", diff_base])
    else:
        output = _try_run_git(repo_root, ["diff", "--name-only", "HEAD"])
    return [line for line in (output or "").splitlines() if line]


def _render_text(result: AffectedTestsResult) -> str:
    lines = [f"confidence: {result.confidence}"]
    if result.tests:
        lines.append(f"affected tests ({result.truncated.shown} of {result.truncated.total} shown):")
        for test in result.tests:
            lines.append(f"  #{test.rank} {test.path}  depth={test.depth} coupling={test.coupling}")
    else:
        lines.append("affected tests: none found via the import graph.")
    if result.truncated.reason:
        lines.append(f"truncated: {result.truncated.reason}")
    if result.unanalyzable:
        lines.append("unanalyzable (no reliable import-graph signal):")
        for entry in result.unanalyzable:
            lines.append(f"  - {entry.path}: {entry.reason}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="v1 local test-impact resolver: given changed files, print the ranked set of "
        "existing tests likely affected, with honest limits (see docs/sdd-tdad-design.md Section 2)."
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="Changed file paths, relative to the current directory (like any other CLI tool). "
        "If omitted, derived via git (already repo-root-relative in that case).",
    )
    parser.add_argument(
        "--diff-base",
        default=None,
        help="Derive changed paths from `git diff --name-only <base>...HEAD` when no paths given.",
    )
    parser.add_argument(
        "--staged",
        action="store_true",
        help="Derive changed paths from staged changes (`git diff --name-only --cached`).",
    )
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument("--max-shown", type=int, default=DEFAULT_MAX_SHOWN)
    parser.add_argument("--format", choices=["json", "text"], default="json")
    parser.add_argument("--no-cache", action="store_true")
    args = parser.parse_args(argv)

    repo_root = args.repo_root if args.repo_root is not None else _discover_repo_root()
    if args.paths:
        changed_paths = [_cli_path_relative_to_repo_root(path, repo_root) for path in args.paths]
    else:
        # Already repo-root-relative (git always runs with cwd=repo_root here).
        changed_paths = _git_diff_paths(repo_root, diff_base=args.diff_base, staged=args.staged)

    result = get_affected_tests(
        changed_paths,
        repo_root=repo_root,
        max_shown=args.max_shown,
        use_cache=not args.no_cache,
    )

    if args.format == "json":
        print(json.dumps(result.to_dict(), indent=2, sort_keys=True))
    else:
        print(_render_text(result))
    return 0


def console_main() -> int:
    """Installed ``sayre-affected-tests`` entrypoint."""
    return main()


if __name__ == "__main__":
    raise SystemExit(console_main())

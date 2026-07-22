"""Pure test-file classification and import-based coverage inference.

This module deliberately resolves only repository-local imports with a
single deterministic answer (or an explicit package directory for Go). It
does not query the graph, inspect a checkout, or invent an edge for an
ambiguous import.
"""

from __future__ import annotations

import posixpath
from collections import defaultdict
from collections.abc import Iterable
from pathlib import PurePosixPath

from sayre_workers.parsing.models import ParsedCoverage, ParsedImport, ParsedTest

_PYTHON_EXTENSIONS = (".py",)
_JAVASCRIPT_EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")
_GO_EXTENSIONS = (".go",)
_SOURCE_EXTENSIONS = _PYTHON_EXTENSIONS + _JAVASCRIPT_EXTENSIONS + _GO_EXTENSIONS


def is_test_file(path: str) -> bool:
    """Return whether a canonical repo-relative path follows a test convention."""
    normalized = path.lower()
    parts = PurePosixPath(normalized).parts
    name = parts[-1] if parts else normalized

    if name.endswith("_test.go"):
        return True
    if name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py")):
        return True
    if name.endswith(_JAVASCRIPT_EXTENSIONS):
        stem = name.rsplit(".", 1)[0]
        if stem.endswith((".test", ".spec")):
            return True
    return any(part in {"test", "tests", "__tests__"} for part in parts[:-1])


def infer_test_coverage(
    parsed_file_paths: Iterable[str],
    imports: Iterable[ParsedImport],
    repository_paths: Iterable[str],
) -> tuple[list[ParsedTest], list[ParsedCoverage]]:
    """Classify parsed test files and infer local COVERS targets from imports.

    ``repository_paths`` may include unchanged files during a delta parse, so
    a changed test can still resolve an import to its unchanged source file.
    """
    parsed_tests = sorted({path for path in parsed_file_paths if is_test_file(path)})
    tests = [ParsedTest(path=path, name=PurePosixPath(path).name) for path in parsed_tests]
    if not tests:
        return [], []

    candidate_paths = {
        path for path in repository_paths if path.lower().endswith(_SOURCE_EXTENSIONS)
    }
    imports_by_file: dict[str, list[ParsedImport]] = defaultdict(list)
    for parsed_import in imports:
        imports_by_file[parsed_import.file_path].append(parsed_import)

    edge_keys: set[tuple[str, str]] = set()
    for test_path in parsed_tests:
        for parsed_import in imports_by_file.get(test_path, []):
            for target in _resolve_import(parsed_import, candidate_paths):
                if target != test_path and not is_test_file(target):
                    edge_keys.add((test_path, target))

    covers = [
        ParsedCoverage(test_path=test_path, file_path=file_path)
        for test_path, file_path in sorted(edge_keys)
    ]
    return tests, covers


def _resolve_import(parsed_import: ParsedImport, paths: set[str]) -> list[str]:
    suffix = PurePosixPath(parsed_import.file_path).suffix.lower()
    if suffix == ".py":
        return _resolve_python(parsed_import, paths)
    if suffix in _JAVASCRIPT_EXTENSIONS:
        return _resolve_javascript(parsed_import, paths)
    if suffix == ".go":
        return _resolve_go(parsed_import.module, paths)
    return []


def _resolve_python(parsed_import: ParsedImport, paths: set[str]) -> list[str]:
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
        if parsed_import.symbols:
            bases.extend("/".join((*package_parts, symbol)) for symbol in parsed_import.symbols)
    else:
        package_parts = module.split(".")
        bases.append("/".join(package_parts))
        if parsed_import.symbols:
            bases.extend("/".join((*package_parts, symbol)) for symbol in parsed_import.symbols)

    candidates: list[str] = []
    for base in bases:
        base = base.strip("/")
        if not base:
            continue
        candidates.extend((f"{base}.py", f"{base}/__init__.py"))
    return _exact_or_unique_suffix(candidates, paths)


def _resolve_javascript(parsed_import: ParsedImport, paths: set[str]) -> list[str]:
    module = parsed_import.module
    if module.startswith("."):
        base = posixpath.normpath(
            posixpath.join(posixpath.dirname(parsed_import.file_path), module)
        )
    else:
        base = module.strip("/")

    has_source_extension = base.lower().endswith(_JAVASCRIPT_EXTENSIONS)
    candidates = (
        [base]
        if has_source_extension
        else [
            *(f"{base}{extension}" for extension in _JAVASCRIPT_EXTENSIONS),
            *(f"{base}/index{extension}" for extension in _JAVASCRIPT_EXTENSIONS),
        ]
    )
    return _exact_or_unique_suffix(candidates, paths)


def _resolve_go(module: str, paths: set[str]) -> list[str]:
    module = module.strip("/")
    matches = sorted(
        path
        for path in paths
        if path.lower().endswith(".go")
        and not is_test_file(path)
        and (posixpath.dirname(path) == module or posixpath.dirname(path).endswith(f"/{module}"))
    )
    return matches


def _exact_or_unique_suffix(candidates: Iterable[str], paths: set[str]) -> list[str]:
    exact = sorted({candidate for candidate in candidates if candidate in paths})
    if exact:
        return exact

    suffix_matches = sorted(
        {path for candidate in candidates for path in paths if path.endswith(f"/{candidate}")}
    )
    return suffix_matches if len(suffix_matches) == 1 else []

"""Pure conversion from Tree-sitter output into scoped graph primitives."""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import PurePosixPath

from sayre_workers.parsing import ParseResult, language_for_path

from .models import GraphEdge, GraphNode, GraphProjection, GraphScope, SymbolRef


def stable_uid(scope: GraphScope, label: str, identity: str) -> str:
    value = "\0".join((scope.repository_id, scope.ref_name, label, identity))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _folder_paths(file_paths: tuple[str, ...]) -> tuple[str, ...]:
    folders = {""}
    for file_path in file_paths:
        parent = PurePosixPath(file_path).parent
        while parent.as_posix() not in {".", ""}:
            folders.add(parent.as_posix())
            parent = parent.parent
    return tuple(sorted(folders, key=lambda item: (item.count("/"), item)))


def _resolve_import(source_path: str, module: str, is_relative: bool, files: set[str]) -> str | None:
    raw_module = module.strip().strip("'\"")
    if not raw_module:
        return None
    if raw_module.startswith("./") or raw_module.startswith("../"):
        parts = list(PurePosixPath(source_path).parent.parts)
        for part in PurePosixPath(raw_module).parts:
            if part in {"", "."}:
                continue
            if part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)
        module_path = PurePosixPath(*parts).as_posix()
    elif is_relative or raw_module.startswith("."):
        dot_count = len(raw_module) - len(raw_module.lstrip("."))
        base = PurePosixPath(source_path).parent
        for _ in range(max(0, dot_count - 1)):
            base = base.parent
        relative = raw_module[dot_count:].replace(".", "/")
        module_path = (base / relative).as_posix() if relative else base.as_posix()
    else:
        module_path = raw_module.replace(".", "/")
    candidates = [module_path]
    for extension in (".py", ".ts", ".tsx", ".js", ".jsx", ".go"):
        candidates.append(f"{module_path}{extension}")
    for index_name in ("__init__.py", "index.ts", "index.tsx", "index.js", "index.jsx"):
        candidates.append(f"{module_path}/{index_name}")
    matches = [candidate for candidate in candidates if candidate in files]
    if len(matches) == 1:
        return matches[0]
    suffix_matches = [path for path in files if path.endswith(f"/{module_path}.go")]
    return suffix_matches[0] if len(suffix_matches) == 1 else None


def _symbol_target(raw_name: str, symbols: tuple[SymbolRef, ...], label: str) -> str | None:
    cleaned = raw_name.removeprefix("self.").removeprefix("this.")
    short_name = cleaned.rsplit(".", 1)[-1].rsplit("::", 1)[-1]
    exact = [symbol for symbol in symbols if symbol.label == label and symbol.qualified_name == cleaned]
    if len(exact) == 1:
        return exact[0].uid
    by_name = [symbol for symbol in symbols if symbol.label == label and symbol.name == short_name]
    return by_name[0].uid if len(by_name) == 1 else None


def build_projection(
    *,
    scope: GraphScope,
    parsed: ParseResult,
    tracked_paths: tuple[str, ...],
    existing_symbols: tuple[SymbolRef, ...] = (),
    affected_paths: tuple[str, ...],
    full_rebuild: bool,
    changed_at: datetime | None = None,
) -> GraphProjection:
    file_paths = tuple(sorted(set(tracked_paths)))
    file_set = set(file_paths)
    affected_set = set(affected_paths)
    folder_paths = _folder_paths(file_paths)
    base_properties = {
        "org_id": scope.org_id,
        "repo_id": scope.repository_id,
        "ref_name": scope.ref_name,
        "revision_sha": scope.revision_sha,
    }
    nodes: list[GraphNode] = []
    for path in folder_paths:
        nodes.append(
            GraphNode(
                label="Folder",
                uid=stable_uid(scope, "Folder", path),
                properties={**base_properties, "path": path, "name": PurePosixPath(path).name or "/"},
            )
        )
    for path in file_paths:
        nodes.append(
            GraphNode(
                label="File",
                uid=stable_uid(scope, "File", path),
                properties={
                    **base_properties,
                    "path": path,
                    "name": PurePosixPath(path).name,
                    "language": language_for_path(path) or "unknown",
                    **(
                        {"last_structural_change_at": changed_at.isoformat()}
                        if changed_at is not None and path in affected_set
                        else {}
                    ),
                },
            )
        )

    for test in parsed.tests:
        nodes.append(
            GraphNode(
                label="Test",
                uid=stable_uid(scope, "Test", test.path),
                properties={
                    **base_properties,
                    "path": test.path,
                    "name": test.name,
                    "coverage_status": test.coverage_status,
                },
            )
        )

    new_symbols: list[SymbolRef] = []
    for function in parsed.functions:
        uid = stable_uid(scope, "Function", f"{function.file_path}\0{function.qualified_name}")
        nodes.append(
            GraphNode(
                label="Function",
                uid=uid,
                properties={
                    **base_properties,
                    "file_path": function.file_path,
                    "name": function.name,
                    "qualified_name": function.qualified_name,
                    "signature": function.signature,
                    "start_line": function.start_line,
                    "end_line": function.end_line,
                },
            )
        )
        new_symbols.append(
            SymbolRef("Function", uid, function.file_path, function.name, function.qualified_name)
        )
    for parsed_class in parsed.classes:
        uid = stable_uid(scope, "Class", f"{parsed_class.file_path}\0{parsed_class.qualified_name}")
        nodes.append(
            GraphNode(
                label="Class",
                uid=uid,
                properties={
                    **base_properties,
                    "file_path": parsed_class.file_path,
                    "name": parsed_class.name,
                    "qualified_name": parsed_class.qualified_name,
                    "start_line": parsed_class.start_line,
                    "end_line": parsed_class.end_line,
                },
            )
        )
        new_symbols.append(
            SymbolRef("Class", uid, parsed_class.file_path, parsed_class.name, parsed_class.qualified_name)
        )

    symbols = tuple(
        sorted(
            [symbol for symbol in existing_symbols if symbol.file_path not in affected_set]
            + new_symbols,
            key=lambda symbol: (symbol.label, symbol.file_path, symbol.qualified_name),
        )
    )
    symbol_by_identity = {
        (symbol.label, symbol.file_path, symbol.qualified_name): symbol for symbol in symbols
    }
    edges: dict[tuple[str, str, str], dict[str, object]] = {}
    for folder_path in folder_paths:
        if not folder_path:
            continue
        parent = PurePosixPath(folder_path).parent.as_posix()
        key = (
            "CONTAINS",
            stable_uid(scope, "Folder", "" if parent == "." else parent),
            stable_uid(scope, "Folder", folder_path),
        )
        edges[key] = {}
    for file_path in file_paths:
        parent = PurePosixPath(file_path).parent.as_posix()
        key = (
            "CONTAINS",
            stable_uid(scope, "Folder", "" if parent == "." else parent),
            stable_uid(scope, "File", file_path),
        )
        edges[key] = {}
    for parsed_import in parsed.imports:
        target_path = _resolve_import(
            parsed_import.file_path, parsed_import.module, parsed_import.is_relative, file_set
        )
        if target_path is not None and target_path != parsed_import.file_path:
            key = (
                "IMPORTS",
                stable_uid(scope, "File", parsed_import.file_path),
                stable_uid(scope, "File", target_path),
            )
            edges[key] = {}
    for call in parsed.calls:
        if call.caller_qualified_name is None:
            continue
        caller = symbol_by_identity.get(
            ("Function", call.file_path, call.caller_qualified_name)
        )
        target_uid = _symbol_target(call.callee_name, symbols, "Function")
        if caller is not None and target_uid is not None:
            edges[("CALLS", caller.uid, target_uid)] = {}
    for inheritance in parsed.inherits:
        subclass = symbol_by_identity.get(
            ("Class", inheritance.file_path, inheritance.subclass_qualified_name)
        )
        target_uid = _symbol_target(inheritance.base_name, symbols, "Class")
        if subclass is not None and target_uid is not None and subclass.uid != target_uid:
            edges[("INHERITS", subclass.uid, target_uid)] = {}

    for coverage in parsed.covers:
        if coverage.test_path not in file_set or coverage.file_path not in file_set:
            continue
        key = (
            "COVERS",
            stable_uid(scope, "Test", coverage.test_path),
            stable_uid(scope, "File", coverage.file_path),
        )
        edges[key] = {
            "status": coverage.status,
            "last_run": coverage.last_run.isoformat() if coverage.last_run is not None else None,
        }

    graph_edges = tuple(
        GraphEdge(relationship, source_uid, target_uid, edges[key])  # type: ignore[arg-type]
        for key in sorted(edges)
        for relationship, source_uid, target_uid in (key,)
    )
    return GraphProjection(
        scope=scope,
        nodes=tuple(nodes),
        edges=graph_edges,
        current_file_paths=file_paths,
        current_folder_paths=folder_paths,
        affected_file_paths=tuple(sorted(affected_set)),
        full_rebuild=full_rebuild,
    )

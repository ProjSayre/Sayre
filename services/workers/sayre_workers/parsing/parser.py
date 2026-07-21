"""`parse_full` / `parse_diff` — the two public parsing entry points.

Selects the language adapter for each `SourceFile` via
`registry.adapter_for_path`, runs the tree-sitter parse
(`get_parser(grammar_name).parse(bytes)`), hands the resulting `Tree` to the
adapter's pure `extract()`, aggregates every file's `FileExtract`,
canonically sorts every output list (see `_parse()`'s Determinism block —
this is a PRODUCTION guarantee, not just a test convenience), and returns one
`ParseResult`.

Stateless: no tree-sitter old-tree/`tree.edit()` incremental reparse (Open
Question 1, confirmed) — `parse_diff` re-parses each changed file fresh,
exactly like `parse_full`, over a caller-supplied subset. No git, no graph
I/O, no queue — see package `__init__.py` for the enforced boundary.
"""

from __future__ import annotations

from collections.abc import Iterable

from tree_sitter_language_pack import get_parser

from sayre_workers.parsing.models import (
    ParsedCall,
    ParsedClass,
    ParsedFunction,
    ParsedImport,
    ParsedInheritance,
    ParseResult,
    SkippedFile,
    SourceFile,
)
from sayre_workers.parsing.registry import adapter_for_path


def parse_full(files: Iterable[SourceFile]) -> ParseResult:
    """Cold-start parse: caller supplies EVERY file. Unsupported extensions
    -> `skipped_files`. `deleted_file_paths` is always `[]`. Output lists are
    canonically sorted (deterministic) regardless of `files`' input order."""
    return _parse(files, deleted_file_paths=[])


def parse_diff(
    changed_files: Iterable[SourceFile],
    deleted_paths: Iterable[str] = (),
) -> ParseResult:
    """Delta parse: caller supplies ONLY changed/added files (re-parsed in
    full, per file — see module docstring) plus the paths of removed files.
    Same `ParseResult` shape as `parse_full`; `deleted_file_paths` carries the
    removed paths through (deduplicated + sorted) so W1-05 can drop their
    subgraph. A path present in BOTH `changed_files` and `deleted_paths` is
    dropped from parsing — deleted wins. Performs no graph or filesystem
    access; W1-01 holds NO state between calls."""
    deleted = sorted({path for path in deleted_paths})
    deleted_set = set(deleted)
    changed = [source_file for source_file in changed_files if source_file.path not in deleted_set]
    return _parse(changed, deleted_file_paths=deleted)


def _parse(files: Iterable[SourceFile], *, deleted_file_paths: list[str]) -> ParseResult:
    functions: list[ParsedFunction] = []
    classes: list[ParsedClass] = []
    imports: list[ParsedImport] = []
    calls: list[ParsedCall] = []
    inherits: list[ParsedInheritance] = []
    parsed_files: list[str] = []
    skipped_files: list[SkippedFile] = []

    for source_file in files:
        adapter = adapter_for_path(source_file.path)
        if adapter is None:
            skipped_files.append(
                SkippedFile(path=source_file.path, reason="unsupported_extension")
            )
            continue

        try:
            source_file.content.decode("utf-8")
        except UnicodeDecodeError:
            skipped_files.append(SkippedFile(path=source_file.path, reason="decode_error"))
            continue

        # tree-sitter is error-tolerant (ERROR/MISSING nodes, never raises)
        # for malformed source — this try/except exists for a genuinely
        # unexpected adapter-internal bug, not for broken source syntax.
        try:
            # LanguageAdapter.grammar_name() returns `str` (spec-mandated
            # interface — see adapters/base.py), but tree-sitter-language-pack's
            # get_parser() stub narrows its argument to a large closed
            # Literal of every grammar it bundles. Our registry only ever
            # constructs the four grammar names get_parser() actually
            # supports ("python"/"javascript"/"typescript"/"tsx"/"go"), so
            # this is a real (harmless) contract mismatch between our
            # adapter interface and an upstream stub, not a type bug here.
            parser = get_parser(adapter.grammar_name(source_file.path))  # type: ignore[arg-type]
            tree = parser.parse(source_file.content)
            extract = adapter.extract(
                file_path=source_file.path, source=source_file.content, tree=tree
            )
        except Exception:
            skipped_files.append(SkippedFile(path=source_file.path, reason="parse_error"))
            continue

        functions.extend(extract.functions)
        classes.extend(extract.classes)
        imports.extend(extract.imports)
        calls.extend(extract.calls)
        inherits.extend(extract.inherits)
        parsed_files.append(source_file.path)

    # Determinism: output must be identical regardless of input file order or
    # dict/walk iteration order (spec "Determinism").
    functions.sort(key=lambda f: (f.file_path, f.start_line, f.qualified_name))
    classes.sort(key=lambda c: (c.file_path, c.start_line, c.qualified_name))
    imports.sort(key=lambda i: (i.file_path, i.start_line, i.module))
    calls.sort(
        key=lambda c: (
            c.file_path,
            c.start_line,
            c.callee_name,
            c.caller_qualified_name or "",
        )
    )
    inherits.sort(key=lambda i: (i.file_path, i.subclass_qualified_name, i.base_name))
    parsed_files.sort()
    skipped_files.sort(key=lambda s: s.path)

    return ParseResult(
        functions=functions,
        classes=classes,
        imports=imports,
        calls=calls,
        inherits=inherits,
        parsed_files=parsed_files,
        skipped_files=skipped_files,
        deleted_file_paths=deleted_file_paths,
    )

"""Dev-authored tests for `sayre_workers.parsing` (W1-01): models, registry,
adapters, `parse_full`/`parse_diff` semantics, determinism, and the
per-language golden-snapshot comparison against
`tests/fixtures/parsing/<lang>/expected_parse.json`.

Snapshot mechanism (Open Question 7, confirmed): hand-rolled golden-JSON
comparison, no new dev dependency. Set `UPDATE_PARSE_SNAPSHOTS=1` to rewrite
the goldens instead of asserting, for intentional regeneration:

    UPDATE_PARSE_SNAPSHOTS=1 poetry run pytest tests/test_parsing.py

This is the **dev-authored** half of the W1-01 test split (see
`.pipeline/spec.md` "Affected files" -- tests & fixtures). Tester adds
adversarial/edge coverage in a separate `tests/test_parsing_tester.py`, which
this module deliberately does not write.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sayre_workers.parsing import (
    ParsedClass,
    ParsedFunction,
    ParseResult,
    SkippedFile,
    SourceFile,
    adapter_for_path,
    get_adapter,
    language_for_path,
    parse_diff,
    parse_full,
    to_canonical_json,
)
from sayre_workers.parsing.adapters.go import GoAdapter
from sayre_workers.parsing.adapters.javascript import JavaScriptAdapter
from sayre_workers.parsing.adapters.python import PythonAdapter
from sayre_workers.parsing.adapters.typescript import TypeScriptAdapter

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "parsing"


# ---------------------------------------------------------------------------
# Fixture-loading helper (test-only per spec: "keep parse_full/parse_diff
# strictly content-in" -- filesystem walking belongs here, not in production).
# ---------------------------------------------------------------------------


def _load_fixture_repo(root: Path) -> list[SourceFile]:
    """Read every regular file under `root` into a `SourceFile` with a
    repo-relative POSIX path, sorted for a stable base input order (the
    parser must produce identical output regardless of this order anyway --
    see the determinism tests below)."""
    files: list[SourceFile] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        files.append(SourceFile(path=relative, content=path.read_bytes()))
    return files


def _assert_matches_golden(result: ParseResult, golden_path: Path) -> None:
    actual = to_canonical_json(result)
    if os.environ.get("UPDATE_PARSE_SNAPSHOTS") == "1":
        golden_path.write_text(actual, encoding="utf-8")
        return
    expected = golden_path.read_text(encoding="utf-8")
    assert actual == expected, (
        f"{golden_path} is stale. Re-run with UPDATE_PARSE_SNAPSHOTS=1 to "
        f"regenerate it (only after confirming the new output is correct)."
    )


# ---------------------------------------------------------------------------
# models.py
# ---------------------------------------------------------------------------


def test_source_file_is_frozen_and_rejects_extra_fields():
    source_file = SourceFile(path="a.py", content=b"x = 1")
    with pytest.raises(Exception):
        source_file.path = "b.py"  # type: ignore[misc]
    with pytest.raises(Exception):
        SourceFile(path="a.py", content=b"x", org_id="tenant-1")  # type: ignore[call-arg]


def test_parse_result_carries_no_tenant_or_uid_fields():
    """Acceptance #6 (grep-verifiable; also a security-stage check): no
    org_id/repo_id/ref_name/revision_sha/uid anywhere on ParseResult."""
    field_names = set(ParseResult.model_fields.keys())
    forbidden = {"org_id", "repo_id", "ref_name", "revision_sha", "uid"}
    assert field_names.isdisjoint(forbidden)
    for model in (ParsedFunction, ParsedClass):
        assert set(model.model_fields.keys()).isdisjoint(forbidden)


def test_canonical_json_is_sorted_indented_and_newline_terminated():
    result = ParseResult(
        functions=[],
        classes=[],
        imports=[],
        calls=[],
        inherits=[],
        parsed_files=["a.py"],
        skipped_files=[],
        deleted_file_paths=[],
    )
    text = to_canonical_json(result)
    assert text.endswith("\n")
    assert text == result.canonical_json()
    # sort_keys=True: "calls" (alphabetically first top-level key) precedes
    # "classes", both of which precede "parsed_files".
    assert text.index('"calls"') < text.index('"classes"') < text.index('"parsed_files"')


# ---------------------------------------------------------------------------
# registry.py
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/app.py", "python"),
        ("src/app.PY", "python"),  # case-insensitive extension
        ("src/app.js", "javascript"),
        ("src/app.jsx", "javascript"),
        ("src/app.mjs", "javascript"),
        ("src/app.cjs", "javascript"),
        ("src/app.ts", "typescript"),
        ("src/app.tsx", "typescript"),
        ("src/app.go", "go"),
        ("src/app.Go", "go"),  # case-insensitive extension
        ("README.md", None),
        ("Dockerfile", None),
        (".gitignore", None),
    ],
)
def test_language_for_path(path, expected):
    assert language_for_path(path) == expected


def test_get_adapter_returns_singleton_per_language():
    assert get_adapter("python") is get_adapter("python")
    assert get_adapter("python") is not get_adapter("javascript")


def test_adapter_for_path_matches_language_and_none_for_unsupported():
    assert isinstance(adapter_for_path("a.py"), PythonAdapter)
    assert isinstance(adapter_for_path("a.js"), JavaScriptAdapter)
    assert isinstance(adapter_for_path("a.ts"), TypeScriptAdapter)
    assert isinstance(adapter_for_path("a.go"), GoAdapter)
    assert adapter_for_path("a.md") is None


def test_typescript_adapter_selects_tsx_grammar_for_tsx_files():
    adapter = get_adapter("typescript")
    assert adapter.grammar_name("a.ts") == "typescript"
    assert adapter.grammar_name("a.tsx") == "tsx"
    assert adapter.grammar_name("A.TSX") == "tsx"


# ---------------------------------------------------------------------------
# parse_full / parse_diff semantics + determinism (Acceptance #2, #3, #4, #5)
# ---------------------------------------------------------------------------


def test_unsupported_extension_is_skipped_with_zero_records():
    result = parse_full([SourceFile(path="notes.md", content=b"# hi")])
    assert result.skipped_files == [SkippedFile(path="notes.md", reason="unsupported_extension")]
    assert result.parsed_files == []
    assert result.functions == []


def test_empty_and_comment_only_files_are_parsed_with_zero_records():
    files = [
        SourceFile(path="empty.py", content=b""),
        SourceFile(path="comment.py", content=b"# just a comment\n"),
    ]
    result = parse_full(files)
    assert result.parsed_files == ["comment.py", "empty.py"]
    assert result.skipped_files == []
    assert result.functions == []
    assert result.classes == []


def test_non_utf8_bytes_are_skipped_as_decode_error_without_crashing():
    files = [
        SourceFile(path="bad.py", content=b"\xff\xfe garbage"),
        SourceFile(path="good.py", content=b"def ok():\n    pass\n"),
    ]
    result = parse_full(files)
    assert result.skipped_files == [SkippedFile(path="bad.py", reason="decode_error")]
    assert result.parsed_files == ["good.py"]
    assert [f.name for f in result.functions] == ["ok"]


def test_syntactically_broken_source_does_not_crash_and_recovers_declarations():
    files = [
        SourceFile(
            path="broken.py",
            content=b"def good_one():\n    pass\n\ndef broken(:\n    pass\n",
        )
    ]
    result = parse_full(files)  # must not raise
    assert "broken.py" in result.parsed_files
    names = {f.name for f in result.functions}
    assert "good_one" in names  # the well-formed sibling declaration survives


def test_every_function_and_class_record_has_valid_span_and_names():
    """Acceptance #2."""
    files = _load_fixture_repo(FIXTURES_ROOT / "python")
    result = parse_full(files)
    assert result.functions, "fixture must produce at least one function"
    assert result.classes, "fixture must produce at least one class"
    for record in (*result.functions, *result.classes):
        assert record.file_path
        assert record.name
        assert record.qualified_name
        assert record.start_line >= 1
        assert record.start_line <= record.end_line


def test_parse_full_and_parse_diff_are_order_independent_and_byte_identical():
    """Acceptance #3."""
    files = _load_fixture_repo(FIXTURES_ROOT / "python")
    forward = parse_full(files)
    backward = parse_full(list(reversed(files)))
    assert to_canonical_json(forward) == to_canonical_json(backward)

    diff_forward = parse_diff(files)
    diff_backward = parse_diff(list(reversed(files)))
    assert to_canonical_json(diff_forward) == to_canonical_json(diff_backward)


def test_parse_diff_only_parses_changed_files_and_passes_deleted_through():
    """Acceptance #4."""
    changed = [SourceFile(path="a.py", content=b"def a():\n    pass\n")]
    result = parse_diff(changed, deleted_paths=["gone.py"])
    assert [f.name for f in result.functions] == ["a"]
    assert result.deleted_file_paths == ["gone.py"]


def test_parse_diff_deleted_path_wins_over_changed_with_same_path():
    changed = [SourceFile(path="a.py", content=b"def a():\n    pass\n")]
    result = parse_diff(changed, deleted_paths=["a.py"])
    assert result.functions == []
    assert result.parsed_files == []
    assert result.deleted_file_paths == ["a.py"]


def test_parse_diff_deduplicates_deleted_paths():
    result = parse_diff([], deleted_paths=["a.py", "b.py", "a.py"])
    assert result.deleted_file_paths == ["a.py", "b.py"]


def test_parse_diff_empty_input_is_empty_result_no_crash():
    result = parse_diff([], [])
    assert result == ParseResult(
        functions=[],
        classes=[],
        imports=[],
        calls=[],
        inherits=[],
        parsed_files=[],
        skipped_files=[],
        deleted_file_paths=[],
    )


def test_parse_full_never_sets_deleted_file_paths():
    result = parse_full([SourceFile(path="a.py", content=b"x = 1\n")])
    assert result.deleted_file_paths == []


def test_two_files_sharing_a_basename_stay_distinct_by_file_path():
    files = [
        SourceFile(path="pkg_a/util.py", content=b"def helper():\n    pass\n"),
        SourceFile(path="pkg_b/util.py", content=b"def helper():\n    pass\n"),
    ]
    result = parse_full(files)
    paths = {f.file_path for f in result.functions}
    assert paths == {"pkg_a/util.py", "pkg_b/util.py"}


# ---------------------------------------------------------------------------
# No forbidden imports/fields anywhere in the module (Acceptance #6)
# ---------------------------------------------------------------------------


def test_parsing_package_imports_no_graph_queue_or_git_modules():
    import ast

    package_root = Path(__file__).parent.parent / "sayre_workers" / "parsing"
    forbidden_modules = {"neo4j", "boto3", "git", "subprocess"}
    for path in package_root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = {node.module.split(".")[0]}
                assert not node.module.startswith("sayre_workers.messaging")
                assert not node.module.startswith("sayre_workers.graph_migrations")
            else:
                continue
            assert names.isdisjoint(forbidden_modules), f"{path} imports {names}"


# ---------------------------------------------------------------------------
# Per-language golden snapshots (Acceptance #1 — the ticket's snapshot
# criterion, for all four languages)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("language", ["python", "javascript", "typescript", "go"])
def test_parse_full_matches_golden_snapshot(language):
    root = FIXTURES_ROOT / language
    files = _load_fixture_repo(root)
    files = [f for f in files if f.path != "expected_parse.json"]
    result = parse_full(files)
    _assert_matches_golden(result, root / "expected_parse.json")


def test_go_fixture_produces_no_classes_or_inherits():
    """Open Question 4 (resolved): Go has no classes/inheritance."""
    files = _load_fixture_repo(FIXTURES_ROOT / "go")
    result = parse_full(files)
    assert result.classes == []
    assert result.inherits == []
    assert result.functions  # still produces functions/imports/calls


def test_typescript_fixture_excludes_interface_and_implements():
    files = _load_fixture_repo(FIXTURES_ROOT / "typescript")
    result = parse_full(files)
    class_names = {c.name for c in result.classes}
    assert "Describable" not in class_names  # interface, not a class
    circle = next(c for c in result.classes if c.name == "Circle")
    assert circle.base_names == ["Shape"]  # extends only; implements excluded
    shape = next(c for c in result.classes if c.name == "Shape")
    assert shape.base_names == []  # implements Describable -> not inherits


# ---------------------------------------------------------------------------
# Cross-language aggregation (mixed fixture repo)
# ---------------------------------------------------------------------------


def test_parse_full_over_mixed_language_repo():
    files = _load_fixture_repo(FIXTURES_ROOT / "mixed")
    result = parse_full(files)

    skipped_paths = {s.path for s in result.skipped_files}
    assert skipped_paths == {"README.md"}
    assert next(s for s in result.skipped_files if s.path == "README.md").reason == (
        "unsupported_extension"
    )

    parsed_langs = {Path(p).suffix for p in result.parsed_files}
    assert parsed_langs == {".py", ".js", ".go"}

    function_names = {f.name for f in result.functions}
    assert {"greet", "Greet"}.issubset(function_names)

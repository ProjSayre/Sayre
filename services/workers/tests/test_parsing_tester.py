"""Supplementary Tester-stage coverage for `sayre_workers.parsing` (W1-01).

Complements `test_parsing.py` (the dev-authored suite, 39 tests) by closing
spec gaps that suite does not assert, mirroring the dev/tester split
established by `tests/test_graph_metrics_tester.py` for W0-08:

  * JS/TS Open Question 6 -- the NEGATIVE half is untested by the dev suite:
    anonymous inline callbacks (`arr.forEach(function () {...})`,
    `arr.map((x) => x)`) and IIFEs are structurally excluded from
    `functions`, not just "arrow/function-expression consts are captured".
    Also closes the `const x = function(){}` POSITIVE case (only the arrow
    form is exercised by the committed JS/TS fixtures).
  * Full-parse vs. diff-parse equivalence -- `parse_full(files)` and
    `parse_diff(files, [])` must agree on `ParseResult` content (order-
    independent) for the same file set; the dev suite only asserts each
    entry point is internally order-independent, never that the two entry
    points agree with each other on a file both touch.
  * `parse_diff`'s entry-point signature is confirmed to take
    `SourceFile`/path content, never a previous `tree_sitter.Tree` or edit
    list -- i.e. genuinely stateless (Open Question 1).
  * Python edge cases from spec.md's Edge Cases list not exercised by any
    fixture or dev test: `from pkg import *` (wildcard -> `symbols=["*"]`)
    and a double-dot relative import (`from ..pkg import y`).
  * Very deep nesting does not crash (iterative walk, no Python recursion-
    limit blowup) -- spec Edge Cases "Very deep nesting / very large file".

Uses the same inline-`SourceFile` unit-test style as `test_parsing.py`
(fixture directories are reserved for the golden-snapshot tests).
"""

from __future__ import annotations

import inspect
from pathlib import Path

from sayre_workers.parsing import SourceFile, parse_diff, parse_full, to_canonical_json

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "parsing"


def _load_fixture_repo(root: Path) -> list[SourceFile]:
    files: list[SourceFile] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == "expected_parse.json":
            continue
        relative = path.relative_to(root).as_posix()
        files.append(SourceFile(path=relative, content=path.read_bytes()))
    return files


# ---------------------------------------------------------------------------
# JS/TS Open Question 6 -- named consts captured, anonymous callbacks/IIFEs
# excluded (the dev suite only exercises the named-arrow-const positive case
# via fixtures; the anonymous/IIFE negative case and the `function(){}`
# positive form are untested anywhere).
# ---------------------------------------------------------------------------


def test_js_named_arrow_and_function_expression_consts_are_captured():
    source = b"""
const namedArrow = (x) => {
  return x + 1;
};

const namedFnExpr = function (x) {
  return x + 2;
};
"""
    result = parse_full([SourceFile(path="a.js", content=source)])
    names = {f.name for f in result.functions}
    assert names == {"namedArrow", "namedFnExpr"}


def test_js_anonymous_and_iife_callbacks_are_not_captured_as_functions():
    """Structural exclusion (see `queries/javascript.scm`): only a function
    value bound directly to a `variable_declarator` counts. An anonymous
    callback passed as a call argument, or an IIFE, has no such parent and
    must not appear in `functions`."""
    source = b"""
function namedTopLevel() {
  return 1;
}

items.forEach(function () {
  doSomething();
});

items.map((x) => x * 2);

(function () {
  runImmediately();
})();

(() => {
  runImmediatelyArrow();
})();
"""
    result = parse_full([SourceFile(path="a.js", content=source)])
    names = {f.name for f in result.functions}
    assert names == {"namedTopLevel"}, (
        f"anonymous/IIFE callbacks leaked into functions: {names - {'namedTopLevel'}}"
    )


def test_ts_class_implements_only_no_extends_produces_no_inherits_row():
    """Standalone minimal case for TS Open Question 5, in addition to the
    combined interface+extends+implements fixture already covered by
    `expected_parse.json` (`Shape implements Describable` / `Circle extends
    Shape` in the same file) -- isolates the "implements with NO extends at
    all" shape so a future regression in the extends-vs-implements branch
    logic can't hide behind the fixture's combined case."""
    source = b"""
interface Greetable {
  greet(): string;
}

class Greeter implements Greetable {
  greet(): string {
    return "hi";
  }
}
"""
    result = parse_full([SourceFile(path="a.ts", content=source)])
    class_names = {c.name for c in result.classes}
    assert "Greetable" not in class_names
    greeter = next(c for c in result.classes if c.name == "Greeter")
    assert greeter.base_names == []
    assert result.inherits == []


# ---------------------------------------------------------------------------
# Full-parse vs. diff-parse equivalence (implicit correctness property: two
# entry points that both claim "same ParseResult shape" must actually agree
# on content for the same file set, not just each be internally
# order-independent).
# ---------------------------------------------------------------------------


def test_parse_full_and_parse_diff_agree_on_same_fileset():
    files = _load_fixture_repo(FIXTURES_ROOT / "python")
    full_result = parse_full(files)
    diff_result = parse_diff(files, deleted_paths=[])
    # deleted_file_paths is the only field allowed to differ in general
    # (always [] for parse_full, carries `deleted_paths` through for
    # parse_diff) -- here deleted_paths=[] for both, so they must be
    # byte-identical.
    assert to_canonical_json(full_result) == to_canonical_json(diff_result)


def test_parse_full_and_parse_diff_agree_on_mixed_language_fileset():
    files = _load_fixture_repo(FIXTURES_ROOT / "mixed")
    full_result = parse_full(files)
    diff_result = parse_diff(files, deleted_paths=[])
    assert to_canonical_json(full_result) == to_canonical_json(diff_result)


def test_parse_diff_signature_takes_source_files_not_a_prior_tree():
    """Confirms the diff-parse entry point matches spec Open Question 1's
    resolution: a stateless re-parse of an explicit changed-file set, taking
    `SourceFile` path/content, never a previous `tree_sitter.Tree`/edit list
    carried between calls."""
    signature = inspect.signature(parse_diff)
    params = list(signature.parameters.values())
    assert [p.name for p in params] == ["changed_files", "deleted_paths"]
    changed_files_annotation = str(params[0].annotation)
    deleted_paths_annotation = str(params[1].annotation)
    assert "SourceFile" in changed_files_annotation
    assert "Tree" not in changed_files_annotation
    assert "Tree" not in deleted_paths_annotation
    # deleted_paths defaults to empty, not a required old-state argument.
    assert params[1].default == ()


# ---------------------------------------------------------------------------
# Python edge cases present in spec.md's Edge Cases list but not exercised by
# any committed fixture or the dev suite: wildcard import and a >1-level
# relative import.
# ---------------------------------------------------------------------------


def test_python_wildcard_import_symbols_is_star():
    source = b"from pkg import *\n"
    result = parse_full([SourceFile(path="a.py", content=source)])
    assert len(result.imports) == 1
    imp = result.imports[0]
    assert imp.module == "pkg"
    assert imp.symbols == ["*"]
    assert imp.is_relative is False


def test_python_double_dot_relative_import():
    source = b"from ..pkg import thing\n"
    result = parse_full([SourceFile(path="a/b/c.py", content=source)])
    assert len(result.imports) == 1
    imp = result.imports[0]
    assert imp.is_relative is True
    assert imp.module == "..pkg"
    assert imp.symbols == ["thing"]


# ---------------------------------------------------------------------------
# Very deep nesting / very large file -> no recursion-limit crash (spec Edge
# Cases). Not exercised anywhere in the dev suite.
# ---------------------------------------------------------------------------


def test_very_deep_nesting_does_not_crash():
    depth = 400
    lines = []
    for i in range(depth):
        lines.append("    " * i + f"def f{i}():")
    lines.append("    " * depth + "return 1")
    source = "\n".join(lines).encode("utf-8")

    result = parse_full([SourceFile(path="deep.py", content=source)])

    assert "deep.py" in result.parsed_files
    assert len(result.functions) == depth
    innermost = next(f for f in result.functions if f.name == f"f{depth - 1}")
    assert innermost.qualified_name == ".".join(f"f{i}" for i in range(depth))

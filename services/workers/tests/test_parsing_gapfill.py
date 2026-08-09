"""Red-stage (gap-mode) suite for W1-01 GAPFILL — GAP-5/6/7/8.

Authored by the `red` stage from `.pipeline/spec.md` alone, BEFORE `dev` runs,
so every assertion here describes the acceptance criteria rather than a diff.
Scope is exactly the four non-`OK` findings in `.pipeline/gaps.json`:

  * GAP-5 — `export … from "…"` re-exports become `ParsedImport` rows.
  * GAP-6 — generator functions become `ParsedFunction` rows and act as scopes.
  * GAP-7 — TS `import x = require("y")` and bound class expressions.
  * GAP-8 — fixtures/goldens that can actually catch a GAP-5/6/7 regression,
    plus a compile-time guard that the `.scm` sources are valid against every
    grammar they are executed with.

The five `OK` gaps (GAP-1/2/3/4/9) are deliberately NOT re-tested here; their
existing coverage lives in `tests/test_parsing.py` and
`tests/test_parsing_tester.py`.

Every test carries a `# @spec <ID>` marker naming the `AC-*`/`EC-*` item from
`.pipeline/spec.md` it exercises.

Note for `dev`: this stage did NOT author the eight fixture SOURCE files listed
under spec.md "Affected files → Created" (`javascript/barrel.js`,
`javascript/generators.js`, `javascript/expressions.js`, `typescript/barrel.ts`,
`typescript/generators.ts`, `typescript/legacy.ts`, `typescript/expressions.ts`,
`typescript/stream.tsx`). Adding them without regenerating the goldens would
have left the pre-existing, currently-green
`test_parse_full_matches_golden_snapshot[javascript|typescript]` failing for a
reason unrelated to any test in this file. The AC-9/AC-10 tests below therefore
assert those exact paths exist and carry the required constructs — dev authors
the files and regenerates the goldens.
"""

from __future__ import annotations

import hashlib
import importlib
import json
from collections import Counter
from pathlib import Path

import pytest
from tree_sitter_language_pack import get_language

import sayre_workers.parsing as parsing_pkg
from sayre_workers.parsing import (
    ParseResult,
    SourceFile,
    parse_diff,
    parse_full,
    to_canonical_json,
)
from sayre_workers.parsing.adapters import javascript as js_adapter
from sayre_workers.parsing.adapters import typescript as ts_adapter
from sayre_workers.parsing.adapters.base import load_query_source

TESTS_ROOT = Path(__file__).resolve().parent
WORKERS_ROOT = TESTS_ROOT.parent
REPO_ROOT = WORKERS_ROOT.parent.parent
FIXTURES_ROOT = TESTS_ROOT / "fixtures" / "parsing"
QUERIES_ROOT = WORKERS_ROOT / "sayre_workers" / "parsing" / "queries"

# The two already-committed test modules whose `_load_fixture_repo()` helper
# AC-11 moves the `expected_parse.json` exclusion into.
dev_suite = importlib.import_module("tests.test_parsing")
tester_suite = importlib.import_module("tests.test_parsing_tester")

RECORD_LISTS = ("functions", "classes", "imports", "calls", "inherits")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_one(path: str, source: bytes) -> ParseResult:
    return parse_full([SourceFile(path=path, content=source)])


def _load_dir(root: Path) -> list[SourceFile]:
    """Local fixture-dir loader that always drops `expected_parse.json`.

    Deliberately independent of either committed suite's own
    `_load_fixture_repo()` so these tests do not depend on AC-11's edit to
    those helpers (AC-11 has its own test below).
    """
    files: list[SourceFile] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == "expected_parse.json":
            continue
        files.append(
            SourceFile(path=path.relative_to(root).as_posix(), content=path.read_bytes())
        )
    return files


def _modules(result: ParseResult) -> list[str]:
    return [imported.module for imported in result.imports]


def _function_names(result: ParseResult) -> list[str]:
    return [function.name for function in result.functions]


def _class_names(result: ParseResult) -> list[str]:
    return [parsed_class.name for parsed_class in result.classes]


def _rows_for(golden: dict, file_path: str) -> dict[str, list[dict]]:
    return {
        key: [row for row in golden[key] if row["file_path"] == file_path]
        for key in RECORD_LISTS
    }


def _per_file_digest(golden: dict, file_path: str) -> str:
    blob = json.dumps(_rows_for(golden, file_path), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _normalize(text: str) -> str:
    return " ".join(text.split()).lower()


def _assert_mentions(text: str, label: str, requirements: list[tuple[str, tuple[str, ...]]]):
    normalized = _normalize(text)
    for description, accepted in requirements:
        assert any(candidate in normalized for candidate in accepted), (
            f"{label} does not document {description}; expected one of {accepted!r}"
        )


# ---------------------------------------------------------------------------
# GAP-5 — re-exports become ParsedImport rows
# ---------------------------------------------------------------------------

_BARREL_SOURCE = b'export * from "./a";\nexport { b } from "./b";\nexport * as ns from "./c";\n'


# @spec AC-1
@pytest.mark.parametrize("path", ["barrel.js", "barrel.jsx", "barrel.ts", "barrel.tsx"])
def test_reexports_become_one_parsed_import_each_in_every_js_ts_grammar(path):
    result = _parse_one(path, _BARREL_SOURCE)

    assert result.skipped_files == []
    assert result.parsed_files == [path]
    assert [(row.module, row.start_line) for row in result.imports] == [
        ("./a", 1),
        ("./b", 2),
        ("./c", 3),
    ], f"barrel file {path} did not produce three re-export imports: {result.imports}"
    assert all(row.file_path == path for row in result.imports)


# @spec AC-2
def test_reexport_symbols_and_is_relative_follow_the_documented_rules():
    source = (
        b'export * from "./star";\n'
        b'export { a, b as c } from "./named";\n'
        b'export * as ns from "./nsmod";\n'
        b'export type { T } from "./typed";\n'
        b'export { x } from "plain-pkg";\n'
    )
    result = _parse_one("barrel.ts", source)

    by_module = {row.module: row for row in result.imports}
    assert len(result.imports) == 5, f"expected five re-export rows, got {result.imports}"
    assert by_module["./star"].symbols == []
    assert by_module["./named"].symbols == ["a", "b"]  # ORIGINAL pre-alias names
    assert by_module["./nsmod"].symbols == ["ns"]
    assert by_module["./typed"].symbols == ["T"]
    assert by_module["plain-pkg"].symbols == ["x"]

    assert by_module["./star"].is_relative is True
    assert by_module["./named"].is_relative is True
    assert by_module["./nsmod"].is_relative is True
    assert by_module["./typed"].is_relative is True
    assert by_module["plain-pkg"].is_relative is False


# @spec EC-1
def test_local_export_with_no_from_clause_is_not_an_import():
    source = b'const a = 1;\nexport { a };\nexport { b } from "./m";\n'
    result = _parse_one("local.js", source)
    assert _modules(result) == ["./m"], (
        f"a local `export {{ a }};` was recorded as a module dependency: {result.imports}"
    )


# @spec EC-2
def test_declaration_exports_are_not_imports_and_are_still_extracted():
    source = (
        b"export function f() {}\n"
        b"export const x = 1;\n"
        b"export default class K {}\n"
        b"export class L {}\n"
        b'export { y } from "./real";\n'
    )
    result = _parse_one("decls.js", source)

    assert _modules(result) == ["./real"], (
        f"a declaration export leaked into imports: {result.imports}"
    )
    assert "f" in _function_names(result)
    assert set(_class_names(result)) == {"K", "L"}


# @spec EC-3
def test_bare_package_and_parent_relative_reexports_set_is_relative_correctly():
    source = b'export { x } from "lodash";\nexport * from "../shared";\n'
    result = _parse_one("rel.js", source)
    assert [(row.module, row.is_relative) for row in result.imports] == [
        ("lodash", False),
        ("../shared", True),
    ]


# @spec EC-4
def test_import_and_reexport_of_the_same_module_are_two_undeduplicated_rows():
    source = b'import { a } from "./m";\nexport { b } from "./m";\n'
    result = _parse_one("both.js", source)
    assert [(row.module, row.start_line, row.symbols) for row in result.imports] == [
        ("./m", 1, ["a"]),
        ("./m", 2, ["b"]),
    ]


# ---------------------------------------------------------------------------
# GAP-6 — generator functions
# ---------------------------------------------------------------------------


# @spec AC-3
@pytest.mark.parametrize("extension", [".js", ".ts", ".tsx"])
@pytest.mark.parametrize(
    "declaration",
    [
        b"function* g() { yield 1; }\n",
        b"export function* g() { yield 1; }\n",
        b"async function* g() { yield 1; }\n",
    ],
    ids=["plain", "exported", "async"],
)
def test_generator_declarations_are_parsed_functions(declaration, extension):
    path = f"gen{extension}"
    result = _parse_one(path, declaration)

    assert result.skipped_files == []
    assert result.parsed_files == [path]
    assert len(result.functions) == 1, (
        f"{declaration!r} in {path} produced {len(result.functions)} functions"
    )
    function = result.functions[0]
    assert function.name == "g"
    assert function.qualified_name == "g"
    assert function.enclosing_class is None


# @spec AC-3
@pytest.mark.parametrize("path", ["gen.js", "gen.ts"])
def test_generator_only_file_is_no_longer_a_silently_empty_function_graph(path):
    result = _parse_one(path, b"function* genFn() { yield 1; }\n")
    assert result.parsed_files == [path]
    assert result.skipped_files == []
    assert _function_names(result) == ["genFn"]


# @spec AC-4
@pytest.mark.parametrize("path", ["expr.js", "expr.ts"])
def test_generator_expression_bound_to_a_const_is_a_named_function(path):
    source = b"const g = function* () {\n  yield 1;\n};\n"
    result = _parse_one(path, source)

    assert len(result.functions) == 1, f"expected one function, got {result.functions}"
    function = result.functions[0]
    assert function.name == "g"
    assert function.qualified_name == "g"
    # Span is the generator-expression node, exactly like `const g = function(){}`.
    assert (function.start_line, function.end_line) == (1, 3)


# @spec AC-5
def test_generator_functions_and_generator_methods_act_as_scopes():
    source = (
        b"function* outer() {\n"
        b"  function inner() {}\n"
        b"  helper();\n"
        b"}\n"
        b"class S {\n"
        b"  *rows() { yield 1; }\n"
        b"}\n"
    )
    result = _parse_one("scope.js", source)

    by_qualified = {function.qualified_name: function for function in result.functions}
    assert "outer.inner" in by_qualified, (
        f"generator did not act as a scope for a nested declaration: {sorted(by_qualified)}"
    )
    helper_call = next(call for call in result.calls if call.callee_name == "helper")
    assert helper_call.caller_qualified_name == "outer"

    assert "S.rows" in by_qualified
    assert by_qualified["S.rows"].enclosing_class == "S"


# @spec EC-5
def test_anonymous_default_export_generator_is_not_a_function():
    source = b"export default function* () {}\nfunction* named() { yield 1; }\n"
    result = _parse_one("anon.js", source)
    assert _function_names(result) == ["named"], (
        "expected only the named generator; the anonymous default-export generator "
        f"must be excluded. Got: {result.functions}"
    )


# @spec EC-6
def test_anonymous_inline_generator_is_excluded_but_its_call_site_is_recorded():
    source = b"run(function* () { yield 1; });\nfunction* keeper() { yield 2; }\n"
    result = _parse_one("inline.js", source)

    assert _function_names(result) == ["keeper"], (
        "expected only the named generator; the inline anonymous generator must be "
        f"excluded. Got: {result.functions}"
    )
    assert any(call.callee_name == "run" and call.start_line == 1 for call in result.calls), (
        f"surrounding run(...) call was not recorded: {result.calls}"
    )


# @spec EC-7
def test_generator_methods_are_captured_exactly_once_alongside_a_generator_function():
    source = (
        b"class S {\n"
        b"  *rows() { yield 1; }\n"
        b"  async *arows() { yield 2; }\n"
        b"}\n"
        b"function* topGen() { yield 3; }\n"
    )
    result = _parse_one("methods.js", source)

    counts = Counter(function.qualified_name for function in result.functions)
    assert counts == Counter({"S.rows": 1, "S.arows": 1, "topGen": 1}), (
        f"generator methods double-emitted or top-level generator missing: {counts}"
    )


# ---------------------------------------------------------------------------
# GAP-7 — TS import-equals and class expressions
# ---------------------------------------------------------------------------


# @spec AC-6
@pytest.mark.parametrize("path", ["legacy.ts", "legacy.tsx"])
def test_ts_import_equals_require_becomes_a_parsed_import(path):
    source = b'import { A } from "./a";\nimport fs = require("fs");\nimport util = require("./util");\n'
    result = _parse_one(path, source)

    assert result.skipped_files == []
    assert [
        (row.module, row.symbols, row.is_relative, row.start_line) for row in result.imports
    ] == [
        ("./a", ["A"], True, 1),
        ("fs", ["fs"], False, 2),
        ("./util", ["util"], True, 3),
    ]


# @spec EC-8
def test_ts_namespace_alias_without_require_is_not_an_import():
    source = b"import A = B.C;\nimport fs = require(\"fs\");\n"
    result = _parse_one("alias.ts", source)
    assert [(row.module, row.symbols) for row in result.imports] == [("fs", ["fs"])], (
        f"a namespace alias with no module string was recorded: {result.imports}"
    )


# @spec EC-9
def test_import_equals_in_a_js_file_is_error_tolerant_and_never_a_blanket_skip():
    source = b'import fs = require("fs");\nfunction* g() { yield 1; }\n'
    result = _parse_one("legacy.js", source)

    assert result.skipped_files == [], (
        f"invalid-JS import-equals turned the file into a skip: {result.skipped_files}"
    )
    assert result.parsed_files == ["legacy.js"]
    assert "g" in _function_names(result), (
        "the well-formed sibling generator was lost to error recovery: "
        f"{result.functions}"
    )


# @spec AC-7
@pytest.mark.parametrize("path", ["cls.js", "cls.ts"])
def test_bound_class_expression_is_a_class_and_owns_its_methods(path):
    source = b"const C = class {\n  m() {}\n};\n"
    result = _parse_one(path, source)

    assert len(result.classes) == 1, f"expected one class, got {result.classes}"
    parsed_class = result.classes[0]
    assert parsed_class.name == "C"
    assert parsed_class.qualified_name == "C"

    assert len(result.functions) == 1, f"expected one method, got {result.functions}"
    method = result.functions[0]
    assert method.name == "m"
    assert method.qualified_name == "C.m"
    assert method.enclosing_class == "C"


# @spec AC-8
@pytest.mark.parametrize("path", ["heritage.js", "heritage.ts"])
def test_class_expression_with_extends_produces_one_inheritance_row(path):
    result = _parse_one(path, b"const D = class extends Legacy {};\n")

    assert len(result.classes) == 1, f"expected one class, got {result.classes}"
    assert result.classes[0].name == "D"
    assert result.classes[0].base_names == ["Legacy"]
    assert [
        (row.subclass_qualified_name, row.base_name) for row in result.inherits
    ] == [("D", "Legacy")]


# @spec EC-10
def test_unbound_and_anonymous_class_expressions_produce_no_class():
    source = (
        b"const Keep = class {};\n"
        b"foo(class { m() {} });\n"
        b"this.C = class {};\n"
        b"export default class {};\n"
        b"const [x] = [class {}];\n"
    )
    result = _parse_one("anonclass.js", source)
    assert _class_names(result) == ["Keep"], (
        "expected only the bound `const Keep = class {}`; every unbound/anonymous "
        f"class expression must be excluded. Got: {result.classes}"
    )


# @spec EC-11
def test_named_class_expression_prefers_the_binding_and_is_recorded_once():
    result = _parse_one("inner.js", b"const C = class Inner { m() {} };\n")

    assert _class_names(result) == ["C"], (
        f"`const C = class Inner {{}}` produced {result.classes}"
    )
    assert [function.qualified_name for function in result.functions] == ["C.m"]


# @spec EC-12
def test_class_expression_nested_in_a_function_chains_its_qualified_names():
    source = b"function f() {\n  const C = class {\n    m() {}\n  };\n}\n"
    result = _parse_one("nested.js", source)

    assert _class_names(result) == ["C"], f"expected one nested class C, got {result.classes}"
    assert result.classes[0].qualified_name == "f.C"

    # EC-12 specifies C's and m's qualified names, not that the enclosing
    # `f` itself vanishes from `functions` — `f` is a real, named, non-anonymous
    # top-level function_declaration, and extracting it is pre-existing GAP-2
    # (OK) behaviour this ticket does not touch. Select `m` by qualified_name
    # rather than assuming index/list-length, so this test asserts exactly what
    # EC-12 says and nothing more.
    assert "m" in _function_names(result), f"expected method m, got {result.functions}"
    method = next(fn for fn in result.functions if fn.qualified_name == "f.C.m")
    assert method.enclosing_class == "C"


# ---------------------------------------------------------------------------
# GAP-8 — fixtures, goldens, and the `.scm` compile guard
# ---------------------------------------------------------------------------

_NEW_JS_FIXTURES = ("barrel.js", "generators.js", "expressions.js")
_NEW_TS_FIXTURES = ("barrel.ts", "generators.ts", "legacy.ts", "expressions.ts", "stream.tsx")

_FIXTURE_CONSTRUCT_TOKENS: dict[str, tuple[str, ...]] = {
    "javascript/barrel.js": ("export * from", "} from", "export * as"),
    "javascript/generators.js": ("function*",),
    "javascript/expressions.js": ("= class",),
    "typescript/barrel.ts": ("export * from", "} from", "export * as", "export type {"),
    "typescript/generators.ts": ("function*",),
    "typescript/legacy.ts": ("= require(",),
    "typescript/expressions.ts": ("= class", "extends"),
    "typescript/stream.tsx": ("} from", "function*", "= class"),
}


# @spec AC-9
def test_gap8_fixture_sources_exist_and_exercise_every_new_construct():
    missing = [
        relative
        for relative in _FIXTURE_CONSTRUCT_TOKENS
        if not (FIXTURES_ROOT / relative).is_file()
    ]
    assert missing == [], f"GAP-8 fixture sources are missing: {missing}"

    for relative, tokens in _FIXTURE_CONSTRUCT_TOKENS.items():
        text = (FIXTURES_ROOT / relative).read_text(encoding="utf-8")
        for token in tokens:
            assert token in text, f"{relative} does not exercise {token!r}"

    javascript = parse_full(_load_dir(FIXTURES_ROOT / "javascript"))
    assert len([r for r in javascript.imports if r.file_path == "barrel.js"]) >= 3
    assert len([r for r in javascript.functions if r.file_path == "generators.js"]) >= 3
    assert len([r for r in javascript.classes if r.file_path == "expressions.js"]) >= 1
    assert javascript.skipped_files == []

    typescript = parse_full(_load_dir(FIXTURES_ROOT / "typescript"))
    assert len([r for r in typescript.imports if r.file_path == "barrel.ts"]) >= 4
    assert len([r for r in typescript.functions if r.file_path == "generators.ts"]) >= 3
    assert len([r for r in typescript.imports if r.file_path == "legacy.ts"]) >= 1
    assert len([r for r in typescript.classes if r.file_path == "expressions.ts"]) >= 2
    assert len([r for r in typescript.inherits if r.file_path == "expressions.ts"]) >= 1
    assert typescript.skipped_files == []

    # The `tsx` grammar runs the same typescript.scm — prove all three
    # constructs land there too, not just under `typescript`.
    assert len([r for r in typescript.imports if r.file_path == "stream.tsx"]) >= 1
    assert len([r for r in typescript.functions if r.file_path == "stream.tsx"]) >= 1
    assert len([r for r in typescript.classes if r.file_path == "stream.tsx"]) >= 1

    # ...and the golden snapshot still passes for all four languages against
    # the regenerated goldens (AC-9's second sentence).
    for language in ("python", "javascript", "typescript", "go"):
        root = FIXTURES_ROOT / language
        actual = to_canonical_json(parse_full(_load_dir(root)))
        expected = (root / "expected_parse.json").read_text(encoding="utf-8")
        assert actual == expected, f"{language}/expected_parse.json is stale"


# @spec AC-10
def test_regenerated_goldens_contain_a_row_for_every_new_construct():
    javascript = json.loads(
        (FIXTURES_ROOT / "javascript" / "expected_parse.json").read_text(encoding="utf-8")
    )
    typescript = json.loads(
        (FIXTURES_ROOT / "typescript" / "expected_parse.json").read_text(encoding="utf-8")
    )

    for fixture in _NEW_JS_FIXTURES:
        assert fixture in javascript["parsed_files"], (
            f"{fixture} is absent from the javascript golden"
        )
    for fixture in _NEW_TS_FIXTURES:
        assert fixture in typescript["parsed_files"], (
            f"{fixture} is absent from the typescript golden"
        )

    assert len(_rows_for(javascript, "barrel.js")["imports"]) >= 3
    assert len(_rows_for(javascript, "generators.js")["functions"]) >= 3
    assert len(_rows_for(javascript, "expressions.js")["classes"]) >= 1
    assert len(_rows_for(javascript, "expressions.js")["inherits"]) >= 1

    assert len(_rows_for(typescript, "barrel.ts")["imports"]) >= 4
    assert len(_rows_for(typescript, "generators.ts")["functions"]) >= 3
    assert len(_rows_for(typescript, "legacy.ts")["imports"]) >= 1
    assert len(_rows_for(typescript, "expressions.ts")["classes"]) >= 2
    assert len(_rows_for(typescript, "expressions.ts")["inherits"]) >= 1
    stream = _rows_for(typescript, "stream.tsx")
    assert stream["imports"] and stream["functions"] and stream["classes"]


# The five patterns spec.md's "Interfaces / signatures" section adds, keyed by
# a substring unique to the pattern's line in the `.scm` source.
_NEW_QUERY_PATTERNS: list[tuple[str, str, str]] = [
    ("javascript.scm", "javascript", "(generator_function_declaration)"),
    ("javascript.scm", "javascript", "value: (generator_function)"),
    ("javascript.scm", "javascript", "value: (class)"),
    ("javascript.scm", "javascript", "(export_statement source: (string))"),
    ("typescript.scm", "typescript", "(generator_function_declaration)"),
    ("typescript.scm", "typescript", "value: (generator_function)"),
    ("typescript.scm", "typescript", "value: (class)"),
    ("typescript.scm", "typescript", "(export_statement source: (string))"),
    ("typescript.scm", "typescript", "(import_require_clause)"),
]


def _strip_pattern(query_source: str, marker: str) -> str:
    kept = [
        line
        for line in query_source.splitlines()
        if line.lstrip().startswith(";") or marker not in line
    ]
    return "\n".join(kept) + "\n"


# @spec AC-10
@pytest.mark.parametrize(
    ("query_file", "language", "marker"),
    _NEW_QUERY_PATTERNS,
    ids=[f"{q}:{m}" for q, _, m in _NEW_QUERY_PATTERNS],
)
def test_reverting_any_new_query_pattern_breaks_the_golden_snapshot(
    query_file, language, marker, monkeypatch
):
    """The point of GAP-8: with the fixtures and goldens in place, dropping any
    one of the five new capture patterns must make the snapshot comparison
    fail. Before this ticket the fixtures contained none of these constructs,
    so the snapshot suite structurally could not notice."""
    original = load_query_source(query_file)
    assert marker in original, (
        f"{query_file} does not contain the {marker} pattern, so the snapshot "
        f"suite cannot catch its regression"
    )

    reduced = _strip_pattern(original, marker)
    assert reduced != original

    module = js_adapter if query_file == "javascript.scm" else ts_adapter
    monkeypatch.setattr(module, "_QUERY_SOURCE", reduced)

    root = FIXTURES_ROOT / language
    degraded = to_canonical_json(parse_full(_load_dir(root)))
    golden = (root / "expected_parse.json").read_text(encoding="utf-8")
    assert degraded != golden, (
        f"removing {marker} from {query_file} left {language}/expected_parse.json "
        f"unchanged — the golden cannot catch that regression"
    )


# @spec AC-11
def test_mixed_fixture_dir_has_a_golden_and_the_loaders_exclude_it():
    mixed_golden = FIXTURES_ROOT / "mixed" / "expected_parse.json"
    assert mixed_golden.is_file(), "mixed/expected_parse.json does not exist"

    files = _load_dir(FIXTURES_ROOT / "mixed")
    assert to_canonical_json(parse_full(files)) == mixed_golden.read_text(encoding="utf-8")

    # The exclusion must live in BOTH modules' `_load_fixture_repo()`, so
    # loading `mixed/` cannot turn the new golden into an unsupported-extension
    # skip.
    for module in (dev_suite, tester_suite):
        loaded = module._load_fixture_repo(FIXTURES_ROOT / "javascript")
        assert "expected_parse.json" not in {f.path for f in loaded}, (
            f"{module.__name__}._load_fixture_repo() does not exclude expected_parse.json"
        )

    result = parse_full(dev_suite._load_fixture_repo(FIXTURES_ROOT / "mixed"))
    assert {skipped.path for skipped in result.skipped_files} == {"README.md"}
    diff_result = parse_diff(
        tester_suite._load_fixture_repo(FIXTURES_ROOT / "mixed"), deleted_paths=[]
    )
    assert to_canonical_json(result) == to_canonical_json(diff_result)


# @spec AC-12
def test_documentation_describes_the_newly_captured_and_still_excluded_constructs():
    generator = ("generator", "function*")
    reexport = ("re-export", "reexport", "export … from", 'export ... from')
    class_expression = ("class expression",)
    divergence = ("no longer identical", "not identical", "diverge", "differ")

    _assert_mentions(
        (QUERIES_ROOT / "javascript.scm").read_text(encoding="utf-8"),
        "queries/javascript.scm header",
        [
            ("generator functions", generator),
            ("re-exports", reexport),
            ("class expressions", class_expression),
        ],
    )
    _assert_mentions(
        (QUERIES_ROOT / "typescript.scm").read_text(encoding="utf-8"),
        "queries/typescript.scm header",
        [
            ("generator functions", generator),
            ("re-exports", reexport),
            ("class expressions", class_expression),
            ("the TS-only import-equals pattern", ("import_require_clause",)),
            ("that it no longer matches javascript.scm exactly", divergence),
        ],
    )
    _assert_mentions(
        js_adapter.__doc__ or "",
        "adapters/javascript.py module docstring",
        [
            ("generator functions", generator),
            ("re-exports", reexport),
            ("class expressions", class_expression),
        ],
    )
    _assert_mentions(
        ts_adapter.__doc__ or "",
        "adapters/typescript.py module docstring",
        [
            ("the TS-only import-equals pattern", ("import_require_clause",)),
            ("that it no longer matches javascript.scm exactly", divergence),
        ],
    )
    _assert_mentions(
        parsing_pkg.__doc__ or "",
        "parsing/__init__.py boundary docstring",
        [
            ("generator functions", generator),
            ("re-exports", reexport),
            ("class expressions", class_expression),
            ("TS import-equals", ("import_require_clause", "import x = require", "import-equals")),
            ("the still-excluded anonymous forms", ("anonymous",)),
            ("the still-excluded TS namespace alias", ("import a = b.c", "namespace alias")),
            ("the still-excluded local export", ("local export", "export { a }")),
        ],
    )


_QUERY_GRAMMAR_PAIRS = [
    ("javascript.scm", "javascript"),
    ("typescript.scm", "typescript"),
    ("typescript.scm", "tsx"),
]

_REQUIRED_NODE_TYPES: dict[str, tuple[str, ...]] = {
    "javascript.scm": (
        "generator_function_declaration",
        "generator_function",
        "class",
        "export_statement",
    ),
    "typescript.scm": (
        "generator_function_declaration",
        "generator_function",
        "class",
        "export_statement",
        "import_require_clause",
    ),
}


# @spec AC-13
@pytest.mark.parametrize(
    ("query_file", "grammar"),
    _QUERY_GRAMMAR_PAIRS,
    ids=[f"{q}@{g}" for q, g in _QUERY_GRAMMAR_PAIRS],
)
def test_query_sources_compile_against_every_grammar_they_are_used_with(query_file, grammar):
    """`parser.py` converts ANY exception out of `extract()` into
    `SkippedFile(reason="parse_error")`, so a `.scm` naming a node type the
    grammar does not define silently turns every JS/TS file in a repo into a
    skip. This is the standing compile-time guard against that."""
    language = get_language(grammar)
    source = load_query_source(query_file)

    try:
        language.query(source)
    except Exception as error:  # noqa: BLE001 — the guard must fail loudly
        pytest.fail(f"{query_file} does not compile against the {grammar} grammar: {error}")

    # Negative control: the guard can actually fail.
    with pytest.raises(Exception):
        language.query("(sayre_not_a_real_node_type) @probe")

    for node_type in _REQUIRED_NODE_TYPES[query_file]:
        try:
            language.query(f"({node_type}) @probe")
        except Exception as error:  # noqa: BLE001
            pytest.fail(f"grammar {grammar} does not define {node_type}: {error}")
        assert node_type in source, (
            f"{query_file} never captures {node_type}, so the {grammar} grammar's "
            f"support for it is unused"
        )


# @spec EC-13
def test_committed_goldens_are_asserted_not_regenerated_in_ci():
    workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "UPDATE_PARSE_SNAPSHOTS" not in workflow, (
        "CI sets UPDATE_PARSE_SNAPSHOTS, so the snapshot suite would rewrite "
        "rather than assert the goldens"
    )
    config_text = (WORKERS_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    for env_file in sorted(WORKERS_ROOT.glob("*.env*")):
        config_text += env_file.read_text(encoding="utf-8")
    assert "UPDATE_PARSE_SNAPSHOTS" not in config_text

    for language in ("python", "javascript", "typescript", "go", "mixed"):
        root = FIXTURES_ROOT / language
        golden = root / "expected_parse.json"
        assert golden.is_file(), f"{language}/expected_parse.json is missing"
        assert to_canonical_json(parse_full(_load_dir(root))) == golden.read_text(
            encoding="utf-8"
        ), f"{language}/expected_parse.json does not match the committed fixtures"


_MALFORMED_CASES = [
    ("trailing_export_from", "m1.js", b'export { ok } from "./ok";\nexport * from\n', ["./ok"], [], []),
    ("trailing_comma_clause", "m2.js", b'export { a, } from "./m";\n', ["./m"], [], []),
    ("truncated_generator", "m3.js", b"function* good() { yield 1; }\nfunction* (\n", [], ["good"], []),
    ("truncated_extends", "m4.js", b"const Keep = class {};\nconst C = class extends\n", [], [], ["Keep"]),
]


# @spec EC-14
@pytest.mark.parametrize(
    ("path", "source", "modules", "functions", "classes"),
    [case[1:] for case in _MALFORMED_CASES],
    ids=[case[0] for case in _MALFORMED_CASES],
)
def test_malformed_sources_are_best_effort_and_never_fatal(
    path, source, modules, functions, classes
):
    result = _parse_one(path, source)  # must not raise

    assert result.skipped_files == [], (
        f"malformed source became a skip instead of best-effort output: {result.skipped_files}"
    )
    assert result.parsed_files == [path]
    assert set(modules) <= set(_modules(result))
    assert set(functions) <= set(_function_names(result))
    assert set(classes) <= set(_class_names(result))


# @spec EC-15
@pytest.mark.parametrize("language", ["javascript", "typescript"])
def test_determinism_is_preserved_for_the_new_records(language):
    files = _load_dir(FIXTURES_ROOT / language)
    loaded_paths = {source_file.path for source_file in files}
    new_fixtures = _NEW_JS_FIXTURES if language == "javascript" else _NEW_TS_FIXTURES
    assert set(new_fixtures) <= loaded_paths, (
        f"the {language} fixture dir does not carry the new constructs yet: "
        f"{sorted(set(new_fixtures) - loaded_paths)}"
    )

    forward = to_canonical_json(parse_full(files))
    backward = to_canonical_json(parse_full(list(reversed(files))))
    assert forward == backward

    assert forward == to_canonical_json(parse_diff(files, deleted_paths=[]))


# Digests of every record attributable to each pre-existing fixture source,
# computed from the CURRENTLY committed goldens before any GAP-5/6/7 change.
# EC-16: regenerating the goldens must not add or alter a single row for these
# files — only the newly added fixtures may contribute.
_PRE_CHANGE_FILE_DIGESTS: dict[str, tuple[str, str]] = {
    "javascript/index.js": (
        "javascript",
        "ea8ffb68b031a26238a528fb5e1029b50ab8291891e241b067fb141bd93434ad",
    ),
    "javascript/shapes.js": (
        "javascript",
        "809cb1566c1c8f1daea4f152bf6f8b20974d76a676a93e0866187e24b18000f9",
    ),
    "javascript/widget.jsx": (
        "javascript",
        "3f188d1501acb8181f4826e48b77ec42e4b062e3779ab9f3323d6934af81f5f8",
    ),
    "typescript/models.ts": (
        "typescript",
        "afb71ff254fda0bad43a4844ef364a2bf1ef7ba8767780632040e68d5cc9b6c9",
    ),
    "typescript/widget.tsx": (
        "typescript",
        "8ec9ef540e76a6943a08bb20869fcd6229eb55280917b3bbf6b2e6f86b2c6c7b",
    ),
}


# @spec EC-16
def test_existing_fixture_sources_contribute_no_added_or_altered_golden_rows():
    goldens = {
        language: json.loads(
            (FIXTURES_ROOT / language / "expected_parse.json").read_text(encoding="utf-8")
        )
        for language in ("javascript", "typescript")
    }

    for relative, (language, expected_digest) in _PRE_CHANGE_FILE_DIGESTS.items():
        file_name = relative.split("/", 1)[1]
        golden = goldens[language]
        actual_digest = _per_file_digest(golden, file_name)
        counts = {key: len(rows) for key, rows in _rows_for(golden, file_name).items()}
        assert actual_digest == expected_digest, (
            f"{relative} gained or lost golden rows (now {counts}); the new query "
            f"patterns must not change records for files that contain none of the "
            f"new constructs"
        )

    # The other half of EC-16: the diff is not empty either — the new fixtures
    # DO contribute rows, so the digests above are a real no-change assertion
    # rather than a vacuous one.
    assert any(
        row["file_path"] in _NEW_JS_FIXTURES for row in goldens["javascript"]["imports"]
    ), "the javascript golden gained no rows from the new fixtures"
    assert any(
        row["file_path"] in _NEW_TS_FIXTURES for row in goldens["typescript"]["imports"]
    ), "the typescript golden gained no rows from the new fixtures"


# @spec EC-17
def test_empty_input_and_source_free_dirs_survive_the_loader_change(tmp_path):
    empty = parse_full([])
    assert empty == ParseResult(
        functions=[],
        classes=[],
        imports=[],
        calls=[],
        inherits=[],
        parsed_files=[],
        skipped_files=[],
        deleted_file_paths=[],
    )

    (tmp_path / "README.md").write_text("# notes\n", encoding="utf-8")
    (tmp_path / "expected_parse.json").write_text("{}\n", encoding="utf-8")

    for module in (dev_suite, tester_suite):
        result = parse_full(module._load_fixture_repo(tmp_path))
        assert result.parsed_files == []
        assert [skipped.path for skipped in result.skipped_files] == ["README.md"], (
            f"{module.__name__}._load_fixture_repo() let expected_parse.json through: "
            f"{result.skipped_files}"
        )
        assert result.functions == []

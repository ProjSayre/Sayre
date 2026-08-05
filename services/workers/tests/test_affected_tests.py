"""PL-03b: tests for `scripts.affected_tests.get_affected_tests` -- the v1
local test-impact resolver (`docs/sdd-tdad-design.md` Section 2).

Every fixture-based test builds a throwaway file tree under `tmp_path` and
passes it as `repo_root=`, with `use_cache=False` unless the test is
specifically about caching -- these directories are not git repositories, so
`get_affected_tests` exercises its documented no-git fallback path (plain
directory walk + content-hash fingerprint) throughout this module. The
git-backed path (`git ls-files`/`git status`/`git hash-object`) is exercised
by the real-checkout test at the bottom of this file, which runs against this
repository itself.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from scripts.affected_tests import (
    AffectedTestsResult,
    UnanalyzableFile,
    console_main,
    get_affected_tests,
    main,
)


def _write(root: Path, relative: str, content: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# AC1: direct importers rank ahead of transitive ones
# ---------------------------------------------------------------------------


def test_direct_importer_ranks_ahead_of_transitive_importer(tmp_path: Path) -> None:
    _write(tmp_path, "src/util.py", "VALUE = 1\n")
    _write(tmp_path, "src/mid.py", "from src.util import VALUE\n")
    _write(tmp_path, "tests/test_direct.py", "from src.util import VALUE\n")
    _write(tmp_path, "tests/test_transitive.py", "from src.mid import VALUE\n")

    result = get_affected_tests(["src/util.py"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "high"
    assert result.unanalyzable == []
    by_path = {test.path: test for test in result.tests}
    assert by_path["tests/test_direct.py"].depth == 1
    assert by_path["tests/test_transitive.py"].depth == 2
    # Direct importer (depth 1) sorts strictly ahead of the transitive one.
    ranks = {test.path: test.rank for test in result.tests}
    assert ranks["tests/test_direct.py"] < ranks["tests/test_transitive.py"]


def test_depth_three_hop_is_reached_but_depth_four_is_not(tmp_path: Path) -> None:
    _write(tmp_path, "src/a.py", "VALUE = 1\n")
    _write(tmp_path, "src/b.py", "from src.a import VALUE\n")
    _write(tmp_path, "src/c.py", "from src.b import VALUE\n")
    _write(tmp_path, "tests/test_three_hops.py", "from src.c import VALUE\n")
    _write(tmp_path, "src/d.py", "from src.c import VALUE\n")
    _write(tmp_path, "tests/test_four_hops.py", "from src.d import VALUE\n")

    result = get_affected_tests(["src/a.py"], repo_root=tmp_path, use_cache=False)

    by_path = {test.path: test for test in result.tests}
    assert by_path["tests/test_three_hops.py"].depth == 3
    assert "tests/test_four_hops.py" not in by_path


def test_coupling_breaks_ties_at_equal_depth(tmp_path: Path) -> None:
    _write(tmp_path, "src/one.py", "A = 1\n")
    _write(tmp_path, "src/two.py", "B = 2\n")
    _write(tmp_path, "tests/test_both.py", "from src.one import A\nfrom src.two import B\n")
    _write(tmp_path, "tests/test_single.py", "from src.one import A\n")

    result = get_affected_tests(["src/one.py", "src/two.py"], repo_root=tmp_path, use_cache=False)

    by_path = {test.path: test for test in result.tests}
    assert by_path["tests/test_both.py"].depth == 1
    assert by_path["tests/test_both.py"].coupling == 2
    assert by_path["tests/test_single.py"].coupling == 1
    # Both at depth 1, but higher coupling ranks first.
    assert by_path["tests/test_both.py"].rank < by_path["tests/test_single.py"].rank


def test_changed_test_file_is_trivially_affected_at_depth_zero(tmp_path: Path) -> None:
    _write(tmp_path, "tests/test_edited.py", "def test_x():\n    assert True\n")

    result = get_affected_tests(["tests/test_edited.py"], repo_root=tmp_path, use_cache=False)

    assert [test.path for test in result.tests] == ["tests/test_edited.py"]
    assert result.tests[0].depth == 0


# ---------------------------------------------------------------------------
# AC2: hub file -> bounded, ranked, explicitly truncated
# ---------------------------------------------------------------------------


def test_hub_file_truncates_with_explicit_stated_reason(tmp_path: Path) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    for index in range(20):
        _write(tmp_path, f"tests/test_hub_{index}.py", "from src.hub import VALUE\n")

    result = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, max_shown=5, use_cache=False
    )

    assert result.truncated.shown == 5
    assert result.truncated.total == 20
    assert result.truncated.reason is not None
    assert "showing 5 of 20" in result.truncated.reason
    assert "15" in result.truncated.reason  # omitted count stated, not silent
    assert len(result.tests) == 5
    # Ranks are contiguous starting at 1, one per shown test.
    assert [test.rank for test in result.tests] == [1, 2, 3, 4, 5]


def test_non_truncated_result_has_no_reason(tmp_path: Path) -> None:
    _write(tmp_path, "src/small.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_small.py", "from src.small import VALUE\n")

    result = get_affected_tests(["src/small.py"], repo_root=tmp_path, use_cache=False)

    assert result.truncated.shown == result.truncated.total == 1
    assert result.truncated.reason is None


# ---------------------------------------------------------------------------
# AC3: "no import-graph signal" vs. a genuinely-analyzed empty result --
# these must NOT look the same.
# ---------------------------------------------------------------------------


def test_unsupported_extension_reports_no_import_graph_signal(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "services/workers/graph-migrations/004_test_covers_contract.cypher",
        "CREATE (:File {path: 'x'});\n",
    )

    result = get_affected_tests(
        ["services/workers/graph-migrations/004_test_covers_contract.cypher"],
        repo_root=tmp_path,
        use_cache=False,
    )

    assert result.tests == []
    assert result.confidence == "partial"
    assert result.unanalyzable == [
        UnanalyzableFile(
            "services/workers/graph-migrations/004_test_covers_contract.cypher",
            "no_import_graph_signal",
        )
    ]


@pytest.mark.parametrize("extension", ["sql", "yaml", "yml"])
def test_other_unsupported_extensions_also_report_no_import_graph_signal(
    tmp_path: Path, extension: str
) -> None:
    changed_path = f"infra/config.{extension}"
    _write(tmp_path, changed_path, "key: value\n")

    result = get_affected_tests([changed_path], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    assert len(result.unanalyzable) == 1
    assert result.unanalyzable[0].path == changed_path
    assert result.unanalyzable[0].reason == "no_import_graph_signal"


def test_genuinely_zero_coupling_source_file_is_high_confidence_not_no_signal(
    tmp_path: Path,
) -> None:
    """A real, successfully-parsed source file with no importing tests is a
    DIFFERENT answer from a file we couldn't analyze at all -- both produce
    `tests: []`, but only one honestly claims `confidence: "high"`."""
    _write(tmp_path, "src/lonely.py", "VALUE = 1\n")

    result = get_affected_tests(["src/lonely.py"], repo_root=tmp_path, use_cache=False)

    assert result.tests == []
    assert result.confidence == "high"
    assert result.unanalyzable == []


def test_no_signal_and_empty_analyzed_results_are_distinguishable(tmp_path: Path) -> None:
    """Direct proof (per AC3) that the two empty-tests cases above produce
    different, distinguishable output -- not just individually-correct ones."""
    _write(tmp_path, "src/lonely.py", "VALUE = 1\n")
    _write(tmp_path, "infra/schema.sql", "CREATE TABLE x (id INT);\n")

    analyzed_empty = get_affected_tests(["src/lonely.py"], repo_root=tmp_path, use_cache=False)
    no_signal = get_affected_tests(["infra/schema.sql"], repo_root=tmp_path, use_cache=False)

    assert analyzed_empty.tests == no_signal.tests == []
    assert analyzed_empty.confidence != no_signal.confidence
    assert analyzed_empty.unanalyzable != no_signal.unanalyzable
    assert analyzed_empty.confidence == "high"
    assert no_signal.confidence == "partial"


def test_changed_path_that_does_not_exist_is_named_not_silently_dropped(tmp_path: Path) -> None:
    result = get_affected_tests(["src/does_not_exist.py"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    assert result.unanalyzable == [UnanalyzableFile("src/does_not_exist.py", "file_not_found")]


# ---------------------------------------------------------------------------
# AC4: files defeating static analysis are named individually; confidence
# drops to "partial" whenever any exist.
# ---------------------------------------------------------------------------


def test_dynamic_require_call_is_named_as_unanalyzable(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "src/dynamic.js",
        "const pluginName = getPluginName();\n"
        "const plugin = require(pluginName);\n"
        "module.exports = plugin;\n",
    )

    result = get_affected_tests(["src/dynamic.js"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    reasons = {(entry.path, entry.reason) for entry in result.unanalyzable}
    assert ("src/dynamic.js", "dynamic_import") in reasons


def test_python_dynamic_import_module_call_is_named_as_unanalyzable(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "src/loader.py",
        "import importlib\n\n\ndef load(name):\n    return importlib.import_module(name)\n",
    )

    result = get_affected_tests(["src/loader.py"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    reasons = {(entry.path, entry.reason) for entry in result.unanalyzable}
    assert ("src/loader.py", "dynamic_import") in reasons


def test_unresolvable_relative_import_is_named_as_unanalyzable(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "src/broken_import.ts",
        "import { thing } from './does-not-exist';\n\nexport function useThing() {\n  return thing;\n}\n",
    )

    result = get_affected_tests(["src/broken_import.ts"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    reasons = {(entry.path, entry.reason) for entry in result.unanalyzable}
    assert ("src/broken_import.ts", "unresolvable_specifier") in reasons


def test_bare_specifier_import_is_not_flagged_unresolvable(tmp_path: Path) -> None:
    """A non-relative specifier (e.g. an npm package) with no local match is
    assumed external -- not a limitation worth naming."""
    _write(tmp_path, "src/uses_external.ts", "import React from 'react';\n\nexport const x = React;\n")

    result = get_affected_tests(["src/uses_external.ts"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "high"
    assert result.unanalyzable == []


def test_reexport_barrel_is_named_as_unanalyzable(tmp_path: Path) -> None:
    _write(tmp_path, "src/hub_ts.ts", "export const hubValue = 1;\n")
    _write(tmp_path, "src/barrel.ts", "export * from './hub_ts';\n")

    result = get_affected_tests(["src/barrel.ts"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    reasons = {(entry.path, entry.reason) for entry in result.unanalyzable}
    assert ("src/barrel.ts", "re_export_barrel") in reasons


def test_multiple_limitations_on_one_file_are_each_named(tmp_path: Path) -> None:
    """A file can carry more than one distinct limitation; each is its own
    named entry rather than being collapsed into a single generic flag."""
    _write(
        tmp_path,
        "src/messy.ts",
        "import { thing } from './missing';\n"
        "export * from './also-missing';\n"
        "const dynamic = require(computeName());\n",
    )

    result = get_affected_tests(["src/messy.ts"], repo_root=tmp_path, use_cache=False)

    reasons = {entry.reason for entry in result.unanalyzable if entry.path == "src/messy.ts"}
    assert "unresolvable_specifier" in reasons
    assert "re_export_barrel" in reasons
    assert "dynamic_import" in reasons
    assert result.confidence == "partial"


def test_decode_error_is_named_as_unanalyzable(tmp_path: Path) -> None:
    path = tmp_path / "src" / "binary.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe\x00\x01not-utf8")

    result = get_affected_tests(["src/binary.py"], repo_root=tmp_path, use_cache=False)

    assert result.confidence == "partial"
    reasons = {(entry.path, entry.reason) for entry in result.unanalyzable}
    assert ("src/binary.py", "decode_error") in reasons


# ---------------------------------------------------------------------------
# Caching -- keyed by repo content state, never silently stale
# ---------------------------------------------------------------------------


def test_repeated_call_with_unchanged_state_hits_the_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import scripts.affected_tests as affected_tests_module

    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")
    cache_dir = tmp_path / ".cache"

    call_count = {"n": 0}
    original_parse_full = affected_tests_module.parse_full

    def counting_parse_full(*args, **kwargs):
        call_count["n"] += 1
        return original_parse_full(*args, **kwargs)

    monkeypatch.setattr(affected_tests_module, "parse_full", counting_parse_full)

    first = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True
    )
    second = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True
    )

    assert call_count["n"] == 1  # second call was served from cache, not recomputed
    assert first == second
    assert list(cache_dir.glob("*.json"))


def test_editing_an_already_dirty_file_busts_the_cache(tmp_path: Path) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    for index in range(3):
        _write(tmp_path, f"tests/test_hub_{index}.py", "from src.hub import VALUE\n")
    cache_dir = tmp_path / ".cache"

    before = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True
    )
    _write(tmp_path, "tests/test_hub_new.py", "from src.hub import VALUE\n")
    after = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True
    )

    assert before.truncated.total == 3
    assert after.truncated.total == 4


def test_cache_directory_itself_is_excluded_from_its_own_fingerprint(tmp_path: Path) -> None:
    """Regression guard: caching must not be self-referential -- writing a
    cache entry must not change the state the NEXT call's key is derived
    from, or every call would be a guaranteed miss."""
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")
    cache_dir = tmp_path / ".pipeline" / "affected-tests-cache"

    get_affected_tests(["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True)
    get_affected_tests(["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True)
    get_affected_tests(["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True)

    assert len(list(cache_dir.glob("*.json"))) == 1


def test_corrupt_cache_entry_is_recomputed_not_fatal(tmp_path: Path) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")
    cache_dir = tmp_path / ".cache"
    cache_dir.mkdir(parents=True)
    (cache_dir / "not-json-at-all.json").write_text("{not valid json", encoding="utf-8")

    result = get_affected_tests(
        ["src/hub.py"], repo_root=tmp_path, cache_dir=cache_dir, use_cache=True
    )

    assert result.tests[0].path == "tests/test_hub.py"


# ---------------------------------------------------------------------------
# Output shape / round-trip
# ---------------------------------------------------------------------------


def test_result_serializes_to_the_documented_shape(tmp_path: Path) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")

    result = get_affected_tests(["src/hub.py"], repo_root=tmp_path, use_cache=False)
    data = result.to_dict()

    assert set(data.keys()) == {"tests", "truncated", "confidence", "unanalyzable"}
    assert set(data["truncated"].keys()) == {"shown", "total", "reason"}
    assert data["tests"][0].keys() == {"path", "depth", "coupling", "rank"}
    assert json.dumps(data)  # must be JSON-serializable as-is

    round_tripped = AffectedTestsResult.from_dict(json.loads(json.dumps(data)))
    assert round_tripped == result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_json_format(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "--no-cache",
            "--format",
            "json",
            "src/hub.py",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["confidence"] == "high"
    assert payload["tests"][0]["path"] == "tests/test_hub.py"


def test_cli_text_format(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "tests/test_hub.py", "from src.hub import VALUE\n")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "--no-cache",
            "--format",
            "text",
            "src/hub.py",
        ]
    )

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "confidence: high" in out
    assert "tests/test_hub.py" in out


def test_cli_positional_path_is_resolved_relative_to_cwd_not_repo_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Regression guard: a human running the CLI from a subdirectory types a
    path relative to where they're sitting (standard CLI convention), not
    relative to the repo root -- even though `get_affected_tests` itself
    always works in repo-root-relative terms internally."""
    _write(tmp_path, "services/workers/src/hub.py", "VALUE = 1\n")
    _write(tmp_path, "services/workers/tests/test_hub.py", "from src.hub import VALUE\n")
    monkeypatch.chdir(tmp_path / "services" / "workers")

    exit_code = main(
        ["--repo-root", str(tmp_path), "--no-cache", "--format", "json", "src/hub.py"]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["confidence"] == "high"
    assert payload["tests"][0]["path"] == "services/workers/tests/test_hub.py"


def test_console_main_is_a_thin_wrapper_over_main(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(tmp_path, "src/hub.py", "VALUE = 1\n")
    monkeypatch.setattr(
        "sys.argv",
        ["affected_tests.py", "--repo-root", str(tmp_path), "--no-cache", "src/hub.py"],
    )
    assert console_main() == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["tests"] == []


# ---------------------------------------------------------------------------
# AC6: no graph/network client anywhere in this module
# ---------------------------------------------------------------------------


def test_module_never_imports_a_graph_or_network_client() -> None:
    """AST-based (not substring) so the module's own explanatory prose about
    *why* it avoids these clients doesn't trip the check."""
    import ast

    import scripts.affected_tests as affected_tests_module

    source = Path(affected_tests_module.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    imported_roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_roots.add(node.module.split(".")[0])

    for forbidden in ("neo4j", "boto3"):
        assert forbidden not in imported_roots, f"{forbidden!r} must never be imported by affected_tests.py"
    assert imported_roots  # guards against a vacuous check (the module must import *something*)


# ---------------------------------------------------------------------------
# AC5: runs against this repo's real checkout in reasonable time, sane output
# ---------------------------------------------------------------------------


_REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.skipif(
    not (_REPO_ROOT / ".git").exists(), reason="requires the real repo checkout"
)
def test_runs_against_the_real_repo_checkout_in_reasonable_time(tmp_path: Path) -> None:
    changed_path = "services/workers/sayre_workers/parsing/coverage.py"

    start = time.monotonic()
    result = get_affected_tests(
        [changed_path],
        repo_root=_REPO_ROOT,
        cache_dir=tmp_path / "cache",  # keep this test's cache out of the real .pipeline dir
        use_cache=False,
    )
    elapsed = time.monotonic() - start

    assert elapsed < 60, f"took {elapsed:.1f}s against the real checkout -- investigate"
    assert result.confidence in ("high", "partial")
    assert isinstance(result.tests, list)
    # Hand-checked: coverage.py is reached transitively (through parser.py)
    # by every test that imports the `sayre_workers.parsing` package itself.
    found_paths = {test.path for test in result.tests}
    assert "services/workers/tests/test_test_coverage.py" in found_paths
    assert "services/workers/tests/test_parsing.py" in found_paths

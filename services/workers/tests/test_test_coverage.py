"""W2-07 test-file classification and inferred COVERS contract."""

from pathlib import Path

from sayre_workers.parsing import SourceFile, parse_diff, parse_full

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "test_coverage"


def _fixture_files() -> list[SourceFile]:
    return [
        SourceFile(
            path=path.relative_to(FIXTURE_ROOT).as_posix(),
            content=path.read_bytes(),
        )
        for path in sorted(FIXTURE_ROOT.rglob("*"))
        if path.is_file()
    ]


def test_fixture_emits_test_nodes_and_inferred_covers_edges() -> None:
    result = parse_full(_fixture_files())

    assert [(test.path, test.name, test.coverage_status) for test in result.tests] == [
        ("src/format.test.ts", "format.test.ts", "unknown"),
        ("tests/calculator_checks.py", "calculator_checks.py", "unknown"),
    ]
    assert [
        (cover.test_path, cover.file_path, cover.status, cover.last_run) for cover in result.covers
    ] == [
        ("src/format.test.ts", "src/format.ts", "inferred", None),
        ("tests/calculator_checks.py", "src/calculator.py", "inferred", None),
    ]


def test_delta_can_cover_an_unchanged_repository_file() -> None:
    changed_test = SourceFile(
        path="tests/test_calculator.py",
        content=b"from src.calculator import add\n",
    )

    result = parse_diff(
        [changed_test],
        repository_paths=["tests/test_calculator.py", "src/calculator.py"],
    )

    assert [(cover.test_path, cover.file_path) for cover in result.covers] == [
        ("tests/test_calculator.py", "src/calculator.py")
    ]


def test_ambiguous_suffix_import_does_not_guess_a_covered_file() -> None:
    changed_test = SourceFile(
        path="tests/test_widget.py",
        content=b"import widget\n",
    )

    result = parse_diff(
        [changed_test],
        repository_paths=[
            "tests/test_widget.py",
            "packages/a/widget.py",
            "packages/b/widget.py",
        ],
    )

    assert result.tests
    assert result.covers == []


def test_non_test_source_imports_do_not_create_coverage() -> None:
    result = parse_full(
        [
            SourceFile(path="src/app.py", content=b"from src import helper\n"),
            SourceFile(path="src/helper.py", content=b"VALUE = 1\n"),
        ]
    )

    assert result.tests == []
    assert result.covers == []

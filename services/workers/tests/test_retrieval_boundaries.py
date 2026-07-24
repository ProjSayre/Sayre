from __future__ import annotations

import ast
from dataclasses import fields
from pathlib import Path

from sayre_workers.retrieval import RetrievalAnswer, RetrievalQuery

RETRIEVAL_ROOT = Path(__file__).parents[1] / "sayre_workers" / "retrieval"


def _modules_imported(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def test_retrieval_has_no_live_checkout_or_direct_graph_store_path() -> None:
    forbidden_modules = {
        "git",
        "neo4j",
        "pathlib",
        "shutil",
        "subprocess",
        "sayre_workers.ingestion.repository",
    }
    forbidden_calls = {"open", "exec", "eval", "compile"}

    for path in RETRIEVAL_ROOT.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        assert _modules_imported(path).isdisjoint(forbidden_modules), path
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                assert node.func.id not in forbidden_calls, (path, node.func.id)
        assert "repository checkout" not in source.lower() or path.name == "runtime.py"


def test_retrieval_does_not_construct_vendor_or_graphify_clients() -> None:
    forbidden_roots = {"anthropic", "openai", "graphifyy", "langchain", "langgraph"}

    for path in RETRIEVAL_ROOT.glob("*.py"):
        imported_roots = {module.split(".", 1)[0] for module in _modules_imported(path)}
        assert imported_roots.isdisjoint(forbidden_roots), path


def test_user_query_cannot_supply_org_identity() -> None:
    assert {field.name for field in fields(RetrievalQuery)} == {
        "query",
        "anchor_node_id",
    }


def test_internal_full_repo_baseline_is_not_exposed_in_the_answer_contract() -> None:
    answer_fields = {field.name for field in fields(RetrievalAnswer)}

    assert "full_repo_tokens" not in answer_fields
    assert "token_reduction_ratio" not in answer_fields


def test_store_sql_is_parameterized_not_interpolated() -> None:
    path = RETRIEVAL_ROOT / "store.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr != "execute" or not node.args:
                continue
            assert not isinstance(node.args[0], ast.JoinedStr), "SQL must not use f-strings"

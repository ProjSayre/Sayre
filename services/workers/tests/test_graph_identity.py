from __future__ import annotations

import inspect

import pytest

from sayre_workers.graph_schema import (
    COVERAGE_STATUSES,
    COVERS_STATUSES,
    CoversScopeMismatchError,
    GraphIdentityError,
    GraphScope,
    require_same_covers_scope,
    stable_node_uid,
)


BASE_UID_INPUTS = {
    "repo_id": "repo-123",
    "ref_name": "refs/heads/main",
    "node_kind": "Function",
    "canonical_path": "src/café.py",
    "symbol": "pkg.café.run",
}


def test_stable_node_uid_known_vector_and_format():
    assert stable_node_uid(**BASE_UID_INPUTS) == (
        "v1:d525f0abc841dae0dd11692559e660a1d2d3c62debf071465adf1815195532db"
    )


def test_stable_node_uid_is_nfc_normalized_case_sensitive_and_revision_independent():
    decomposed = {**BASE_UID_INPUTS, "canonical_path": "src/cafe\u0301.py"}
    decomposed["symbol"] = "pkg.cafe\u0301.run"
    assert stable_node_uid(**decomposed) == stable_node_uid(**BASE_UID_INPUTS)
    assert stable_node_uid(**{**BASE_UID_INPUTS, "canonical_path": "src/Café.py"}) != (
        stable_node_uid(**BASE_UID_INPUTS)
    )
    parameters = inspect.signature(stable_node_uid).parameters
    assert "org_id" not in parameters
    assert "revision_sha" not in parameters


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("repo_id", "repo-456"),
        ("ref_name", "refs/heads/release"),
        ("node_kind", "Class"),
        ("canonical_path", "src/other.py"),
        ("symbol", "pkg.café.other"),
    ],
)
def test_stable_node_uid_changes_for_every_identity_input(field: str, replacement: str):
    baseline = stable_node_uid(**BASE_UID_INPUTS)
    assert stable_node_uid(**{**BASE_UID_INPUTS, field: replacement}) != baseline


@pytest.mark.parametrize(
    "invalid_path",
    ["", "/src/a.py", "src\\a.py", "src\x00a.py", ".", "..", "src/./a.py", "src/../a.py", "src//a.py", "src/"],
)
def test_stable_node_uid_rejects_noncanonical_paths(invalid_path: str):
    with pytest.raises(GraphIdentityError):
        stable_node_uid(**{**BASE_UID_INPUTS, "canonical_path": invalid_path})


def test_stable_node_uid_enforces_closed_labels_and_symbol_convention():
    with pytest.raises(GraphIdentityError):
        stable_node_uid(**{**BASE_UID_INPUTS, "node_kind": "Repo"})
    with pytest.raises(GraphIdentityError):
        stable_node_uid(**{**BASE_UID_INPUTS, "symbol": None})
    with pytest.raises(GraphIdentityError):
        stable_node_uid(
            repo_id="repo-123",
            ref_name="main",
            node_kind="File",
            canonical_path="src/a.py",
            symbol="not-allowed",
        )
    assert stable_node_uid(
        repo_id="repo-123",
        ref_name="main",
        node_kind="File",
        canonical_path="src/a.py",
    ).startswith("v1:")


@pytest.mark.parametrize("field", ["org_id", "repo_id", "ref_name"])
def test_graph_scope_rejects_empty_server_scope_fields(field: str):
    values = {
        "org_id": "org-1",
        "repo_id": "repo-1",
        "ref_name": "main",
        "revision_sha": "a" * 40,
    }
    values[field] = ""
    with pytest.raises(GraphIdentityError):
        GraphScope(**values)


@pytest.mark.parametrize("revision", ["", "a" * 39, "A" * 40, "g" * 40, "a" * 41, "a" * 63])
def test_graph_scope_rejects_invalid_revision_sha(revision: str):
    with pytest.raises(GraphIdentityError):
        GraphScope("org-1", "repo-1", "main", revision)


def test_graph_scope_accepts_lowercase_sha1_and_sha256():
    assert GraphScope("org-1", "repo-1", "main", "a" * 40).revision_sha == "a" * 40
    assert GraphScope("org-1", "repo-1", "main", "b" * 64).revision_sha == "b" * 64


def test_covers_scope_guard_accepts_exact_scope():
    scope = GraphScope("org-1", "repo-1", "main", "a" * 40)
    require_same_covers_scope(scope, scope)


@pytest.mark.parametrize("field", ["org_id", "repo_id", "ref_name", "revision_sha"])
def test_covers_scope_guard_rejects_each_independent_mismatch_without_values(field: str):
    baseline_values = {
        "org_id": "org-1",
        "repo_id": "repo-1",
        "ref_name": "main",
        "revision_sha": "a" * 40,
    }
    changed_values = dict(baseline_values)
    changed_values[field] = "b" * 40 if field == "revision_sha" else f"other-{field}"
    with pytest.raises(CoversScopeMismatchError) as exc_info:
        require_same_covers_scope(GraphScope(**baseline_values), GraphScope(**changed_values))
    visible = str(exc_info.value)
    assert baseline_values[field] not in visible
    assert changed_values[field] not in visible


def test_status_vocabularies_are_closed_and_ordered():
    assert COVERAGE_STATUSES == ("pass", "fail", "unknown")
    assert COVERS_STATUSES == ("inferred", "measured")

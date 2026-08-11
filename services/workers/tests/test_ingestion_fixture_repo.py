"""GAP-11/GAP-12 gap-fill: real-git, real-parser, real-`build_projection` acceptance
proof for W1-05's literal Acceptance sentence ("pushing to a fixture repo produces
correct nodes and a `graph.updated` event within the sync target").

Drives `IngestionService` with the real `GitRepositorySource(allow_local_for_tests=True)`
against an actual local git repository built with `git` subprocesses (mirroring the
precedent in `tests/test_ingestion.py::test_real_git_snapshot_is_destroyed_after_parse`),
the real Tree-sitter parser (`parse_full`/`parse_diff`, invoked unchanged inside
`IngestionService.handle`), and the real `build_projection` -- only the ref-state
store, graph store, chunk store, and publisher are fakes, reusing the exact
`FakeStateStore`/`FakeGraphStore`/`FakeChunkStore`/`FakePublisher` doubles
`tests/test_ingestion.py` already defines (imported here, not duplicated, per the
precedent `tests/test_graph_migrations_audit.py` sets for cross-file reuse inside the
`tests` package). Previously, every acceptance assertion about
`GitSnapshot.changed_paths`/`is_ancestor`/`tracked_paths`/`source_files` ran only
against a hand-rolled `FakeSnapshot` double that always returned exactly the answer
the test wanted -- this suite is the first to exercise those real git subprocess code
paths through the full `IngestionService.handle()` orchestration.

`sayre_workers/ingestion/service.py`, `sayre_workers/ingestion/repository.py`, and
`sayre_workers/ingestion/projection.py` are NOT modified by this ticket for a normal
(non-branch-deletion) `repo.push`/`repo.initial_parse` job -- `IngestionService.handle`'s
dispatch prologue (GAP-8/GAP-9) delegates unchanged to `parse_ingestion_envelope` for
every envelope type this file constructs. These tests are accordingly expected to pass
against the current, unmodified implementation; they exist to make literal (per
gap-mode rule 2) a proof that previously did not exist at all, catching a genuine
regression if one is ever introduced.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.budgets import STRUCTURAL_SYNC_TARGET_MS
from sayre_workers.ingestion.repository import GitRepositorySource
from sayre_workers.ingestion.service import IngestionService
from tests.test_ingestion import FakeChunkStore, FakeGraphStore, FakePublisher, FakeStateStore

ORG_ID = "org-server-resolved"
REF_NAME = "refs/heads/main"
REPO_FULL_NAME = "test/fixture-repo"


def _git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True
    )
    return result.stdout


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    _git("init", "--quiet", "-b", "main", cwd=path)
    _git("config", "user.email", "test@example.com", cwd=path)
    _git("config", "user.name", "Test", cwd=path)


def _commit(path: Path, message: str) -> str:
    _git("add", "-A", cwd=path)
    _git("commit", "--quiet", "-m", message, cwd=path)
    return _git("rev-parse", "HEAD", cwd=path).strip()


def _real_diff(path: Path, older: str, newer: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Independently computed expected changed/deleted paths -- the same git
    invocation `GitSnapshot.changed_paths` makes -- so assertions never hardcode an
    assumption about what real git reports."""
    raw = _git("diff", "--name-status", "--no-renames", "-z", older, newer, "--", cwd=path)
    fields = [item for item in raw.split("\0") if item]
    changed: set[str] = set()
    deleted: set[str] = set()
    for index in range(0, len(fields), 2):
        status, changed_path = fields[index], fields[index + 1]
        if status.startswith("D"):
            deleted.add(changed_path)
        else:
            changed.add(changed_path)
    return tuple(sorted(changed)), tuple(sorted(deleted))


def _initial_envelope(*, clone_url: str, revision: str) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=ORG_ID,
        type="repo.initial_parse",
        source="github-app",
        idempotency_key=f"initial:{revision}",
        payload={
            "provider": "github",
            "repo": {
                "provider_repo_id": "1",
                "full_name": REPO_FULL_NAME,
                "clone_url": clone_url,
            },
            "ref": REF_NAME,
            "revision_sha": revision,
            "installation_id": "777",
        },
    )


def _push_envelope(
    *, clone_url: str, revision: str, before: str | None, forced: bool = False
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=ORG_ID,
        type="repo.push",
        source="github-webhook",
        idempotency_key=f"push:{revision}:{before}",
        payload={
            "provider": "github",
            "repo": {
                "provider_repo_id": "1",
                "full_name": REPO_FULL_NAME,
                "clone_url": clone_url,
            },
            "ref": REF_NAME,
            "installation_id": "777",
            "payload": {"before": before, "after": revision, "forced": forced},
        },
    )


def _service() -> tuple[IngestionService, list[str], FakeGraphStore, FakeChunkStore, FakePublisher]:
    log: list[str] = []
    state_store = FakeStateStore(None, log)
    graph = FakeGraphStore(log)
    chunks = FakeChunkStore(log)
    publisher = FakePublisher(log)
    service = IngestionService(
        state_store=state_store,
        repository_source=GitRepositorySource(allow_local_for_tests=True),
        graph_store=graph,
        chunk_store=chunks,
        publisher=publisher,
    )
    return service, log, graph, chunks, publisher


@pytest.fixture
def two_commit_repo(tmp_path: Path) -> tuple[Path, str, str]:
    """Commit A: src/app.py + old_module.py. Commit B: src/app.py modified,
    src/new_module.py added, old_module.py deleted."""
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "src").mkdir()
    (remote / "src" / "app.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (remote / "old_module.py").write_text(
        "def to_be_removed():\n    return 0\n", encoding="utf-8"
    )
    revision_a = _commit(remote, "commit A")

    (remote / "src" / "app.py").write_text(
        "def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n", encoding="utf-8"
    )
    (remote / "src" / "new_module.py").write_text(
        "def gamma():\n    return 3\n", encoding="utf-8"
    )
    (remote / "old_module.py").unlink()
    revision_b = _commit(remote, "commit B")

    return remote, revision_a, revision_b


@pytest.mark.asyncio
# @spec AC-8
async def test_two_commit_delta_matches_real_git_projection(
    two_commit_repo: tuple[Path, str, str],
) -> None:
    remote, revision_a, revision_b = two_commit_repo
    clone_url = str(remote)
    service, _log, graph, _chunks, _publisher = _service()

    bootstrap = await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    assert bootstrap.status == "accepted"
    assert bootstrap.full_rebuild is True

    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )

    expected_changed, expected_deleted = _real_diff(remote, revision_a, revision_b)
    assert result.status == "accepted"
    assert result.full_rebuild is False
    assert result.changed_paths == tuple(sorted(set(expected_changed) | set(expected_deleted)))
    assert result.deleted_paths == expected_deleted
    assert "old_module.py" in result.deleted_paths

    projection = graph.projections[-1]
    file_paths = {node.properties["path"] for node in projection.nodes if node.label == "File"}
    assert file_paths == {"src/app.py", "src/new_module.py"}

    folder_paths = {node.properties["path"] for node in projection.nodes if node.label == "Folder"}
    assert folder_paths == {"", "src"}

    function_names_by_file: dict[str, set[str]] = {}
    for node in projection.nodes:
        if node.label == "Function":
            function_names_by_file.setdefault(node.properties["file_path"], set()).add(
                node.properties["name"]
            )
    assert function_names_by_file == {
        "src/app.py": {"alpha", "beta"},
        "src/new_module.py": {"gamma"},
    }

    contains_targets = {
        edge.target_uid
        for edge in projection.edges
        if edge.relationship == "CONTAINS"
    }
    file_uids = {node.uid for node in projection.nodes if node.label == "File"}
    assert file_uids <= contains_targets  # every File is the target of some CONTAINS edge

    # The removed file's node and edges are entirely absent.
    all_uids = {node.uid for node in projection.nodes}
    old_module_file_nodes = [
        node
        for node in projection.nodes
        if node.label == "File" and node.properties["path"] == "old_module.py"
    ]
    assert old_module_file_nodes == []
    for edge in projection.edges:
        assert edge.source_uid in all_uids
        assert edge.target_uid in all_uids


@pytest.mark.asyncio
# @spec AC-9 EC-24
async def test_push_delta_publishes_graph_updated_within_sync_budget(
    two_commit_repo: tuple[Path, str, str],
) -> None:
    remote, revision_a, revision_b = two_commit_repo
    clone_url = str(remote)
    service, _log, _graph, _chunks, publisher = _service()

    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    assert len(publisher.graph_events) == 1

    started = time.perf_counter()
    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )
    wall_clock_to_publish_ms = (time.perf_counter() - started) * 1_000

    assert len(publisher.graph_events) == 2
    published = publisher.graph_events[-1]
    published_duration = published["structural_duration_ms"]
    assert isinstance(published_duration, float)
    assert 0 < published_duration < STRUCTURAL_SYNC_TARGET_MS
    # The wall-clock time up to (and including) the publish call is itself under
    # budget -- a looser but independent corroboration of the same claim.
    assert 0 < wall_clock_to_publish_ms < STRUCTURAL_SYNC_TARGET_MS + 1_000
    # EC-24: the value published on the wire is the PRE-publish measurement --
    # strictly less than the result's own (post-publish) structural_duration_ms.
    assert result.structural_duration_ms is not None
    assert published_duration < result.structural_duration_ms


@pytest.mark.asyncio
# @spec EC-10
async def test_real_git_rename_shows_delete_and_add_not_rename(tmp_path: Path) -> None:
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "old_name.py").write_text("def keep():\n    return 1\n", encoding="utf-8")
    revision_a = _commit(remote, "commit A")

    _git("mv", "old_name.py", "new_name.py", cwd=remote)
    revision_b = _commit(remote, "rename")

    clone_url = str(remote)
    service, _log, graph, _chunks, _publisher = _service()
    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )

    assert result.status == "accepted"
    assert "old_name.py" in result.deleted_paths
    assert "new_name.py" in result.changed_paths
    assert "new_name.py" not in result.deleted_paths

    projection = graph.projections[-1]
    file_paths = {node.properties["path"] for node in projection.nodes if node.label == "File"}
    assert "new_name.py" in file_paths
    assert "old_name.py" not in file_paths


@pytest.mark.asyncio
# @spec EC-11
async def test_real_git_force_push_divergence_triggers_full_rebuild(tmp_path: Path) -> None:
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "shared.py").write_text("value = 1\n", encoding="utf-8")
    revision_a = _commit(remote, "commit A")
    (remote / "shared.py").write_text("value = 2\n", encoding="utf-8")
    revision_b = _commit(remote, "commit B")

    clone_url = str(remote)
    service, _log, graph, _chunks, _publisher = _service()
    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    bootstrap_delta = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )
    assert bootstrap_delta.status == "accepted"
    assert bootstrap_delta.full_rebuild is False

    # Diverge: reset the remote's main branch to a sibling of B (both children of A).
    _git("checkout", "--quiet", "-b", "diverged", revision_a, cwd=remote)
    (remote / "shared.py").write_text("value = 999\n", encoding="utf-8")
    revision_b2 = _commit(remote, "diverged commit")
    _git("checkout", "--quiet", "-B", "main", "diverged", cwd=remote)
    _git("branch", "-D", "diverged", cwd=remote)

    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b2, before=revision_b, forced=True)
    )

    assert result.status == "accepted"
    assert result.full_rebuild is True
    projection = graph.projections[-1]
    assert projection.full_rebuild is True


@pytest.mark.asyncio
# @spec EC-12
async def test_real_git_stale_push_makes_no_graph_write(tmp_path: Path) -> None:
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "shared.py").write_text("value = 1\n", encoding="utf-8")
    revision_a = _commit(remote, "commit A")
    (remote / "shared.py").write_text("value = 2\n", encoding="utf-8")
    revision_b = _commit(remote, "commit B")

    clone_url = str(remote)
    service, _log, graph, _chunks, publisher = _service()
    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    await service.handle(_push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a))
    projections_before = len(graph.projections)
    events_before = len(publisher.graph_events)

    # A stale re-delivery of the OLDER revision, arriving after B is already accepted.
    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_a, before=revision_a)
    )

    assert result.status == "stale"
    assert len(graph.projections) == projections_before
    assert len(publisher.graph_events) == events_before


@pytest.mark.asyncio
# @spec EC-13
async def test_real_git_replay_is_a_full_rederive_without_graph_rewrite(tmp_path: Path) -> None:
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "shared.py").write_text("value = 1\n", encoding="utf-8")
    revision_a = _commit(remote, "commit A")
    (remote / "shared.py").write_text("value = 2\n", encoding="utf-8")
    revision_b = _commit(remote, "commit B")

    clone_url = str(remote)
    service, _log, graph, _chunks, publisher = _service()
    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    await service.handle(_push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a))
    projections_before = len(graph.projections)
    events_before = len(publisher.graph_events)

    # Redeliver the SAME revision B again (e.g. an at-least-once queue retry).
    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )

    assert result.status == "replayed"
    assert len(graph.projections) == projections_before  # no new graph write
    assert len(publisher.graph_events) == events_before + 1  # still republished


@pytest.mark.asyncio
# @spec EC-14
async def test_unsupported_language_and_empty_file_still_produce_file_nodes(
    tmp_path: Path,
) -> None:
    remote = tmp_path / "remote"
    _init_repo(remote)
    (remote / "app.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    revision_a = _commit(remote, "commit A")

    # An unsupported-language file (no Tree-sitter adapter for .rs) and an empty file.
    (remote / "notes.rs").write_text("fn unsupported() {}\n", encoding="utf-8")
    (remote / "empty.py").write_text("", encoding="utf-8")
    revision_b = _commit(remote, "commit B")

    clone_url = str(remote)
    service, _log, graph, _chunks, _publisher = _service()
    await service.handle(_initial_envelope(clone_url=clone_url, revision=revision_a))
    result = await service.handle(
        _push_envelope(clone_url=clone_url, revision=revision_b, before=revision_a)
    )

    assert result.status == "accepted"
    projection = graph.projections[-1]
    file_paths = {node.properties["path"] for node in projection.nodes if node.label == "File"}
    assert {"app.py", "notes.rs", "empty.py"} <= file_paths

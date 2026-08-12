"""CH-04 red suite — the static boundaries the chat package must hold:
no vendor SDK reaches it, `redis` is confined to one module, and the ephemeral
MCP credential can never reach a repr, a log record, or a persisted row.

Authored by `red` from .pipeline/spec.md BEFORE any implementation exists.
Mirrors tests/test_retrieval_boundaries.py, which enforces the same class of
invariant for the retrieval package.
"""

from __future__ import annotations

import ast
from dataclasses import fields
from pathlib import Path

import pytest

from sayre_workers.chat.mcp_client import StreamableHttpMcpClient
from sayre_workers.chat.models import ChatTurnJob

CHAT_ROOT = Path(__file__).parents[1] / "sayre_workers" / "chat"
CREDENTIAL = "mcp_eph_abcd1234.ZZZ-one-time-secret-value-never-logged"
LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical", "log"}
# Deliberately excludes the bare word "token": prompt/context TOKEN COUNTS are
# a KPI this ticket is required to log and record.
SECRET_WORDS = ("credential", "bearer", "authorization", "secret")


def chat_modules() -> list[Path]:
    modules = sorted(CHAT_ROOT.glob("*.py"))
    assert modules, f"no chat modules found under {CHAT_ROOT}"
    return modules


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


# ---------------------------------------------------------------------------
# AC-16 — no vendor SDK, no direct graph or broker client
# ---------------------------------------------------------------------------


# @spec AC-16
def test_no_chat_module_reaches_a_vendor_sdk_or_the_graph_directly() -> None:
    forbidden = {"anthropic", "openai", "graphifyy", "neo4j", "boto3"}

    for path in chat_modules():
        roots = {module.split(".", 1)[0] for module in imported_modules(path)}
        assert roots.isdisjoint(forbidden), (path.name, sorted(roots & forbidden))


# @spec AC-16
def test_the_mcp_client_is_hand_written_over_httpx_not_the_vendor_sdk() -> None:
    # D2: `mcp` requires pydantic>=2.11 and the fleet pins pydantic==2.9.*.
    for path in chat_modules():
        roots = {module.split(".", 1)[0] for module in imported_modules(path)}
        assert "mcp" not in roots, path.name

    assert "httpx" in imported_modules(CHAT_ROOT / "mcp_client.py")


# @spec AC-15
def test_redis_is_confined_to_the_single_publisher_module() -> None:
    publisher = CHAT_ROOT / "redis_publisher.py"
    assert publisher.is_file()

    for path in chat_modules():
        roots = {module.split(".", 1)[0] for module in imported_modules(path)}
        if path.name == "redis_publisher.py":
            assert "redis" in roots
        else:
            assert "redis" not in roots, path.name


# @spec AC-15
def test_the_redis_publisher_writes_the_standard_envelope_body_to_the_channel() -> None:
    source = (CHAT_ROOT / "redis_publisher.py").read_text(encoding="utf-8")
    tree = ast.parse(source, filename="redis_publisher.py")

    classes = {
        node.name: node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
    }
    assert "RedisChatEventPublisher" in classes
    methods = {
        node.name
        for node in ast.walk(classes["RedisChatEventPublisher"])
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    assert {"publish", "aclose"} <= methods

    # The snake_case wire body, not a bespoke re-serialization: the gateway's
    # Redis reader runs assertValidEnvelope on whatever arrives.
    assert "to_body()" in source


# ---------------------------------------------------------------------------
# AC-16 — the credential never reaches a repr, a log, or a row
# ---------------------------------------------------------------------------


# @spec AC-16
def test_the_job_credential_is_excluded_from_every_repr() -> None:
    credential_field = next(
        field for field in fields(ChatTurnJob) if field.name == "mcp_credential"
    )
    assert credential_field.repr is False

    job = ChatTurnJob(
        org_id="11111111-1111-4111-8111-111111111111",
        user_id="22222222-2222-4222-8222-222222222222",
        conversation_id="44444444-4444-4444-8444-444444444444",
        turn_id="66666666-6666-4666-8666-666666666666",
        question="How does login work?",
        view=None,
        anchor_node_id=None,
        history=(),
        mcp_credential=CREDENTIAL,
    )
    assert CREDENTIAL not in repr(job)
    assert CREDENTIAL not in str(job)
    # A pytest assertion diff / traceback frame renders the same repr.
    assert CREDENTIAL not in f"{job!r}"


# @spec AC-16
def test_the_mcp_client_defines_its_own_credential_free_repr() -> None:
    assert "__repr__" in vars(StreamableHttpMcpClient)


# @spec AC-16
def test_no_chat_module_ever_passes_credential_material_to_a_logging_call() -> None:
    offenders: list[tuple[str, str]] = []

    for path in chat_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in LOG_METHODS:
                continue
            interpolated = [
                argument
                for index, argument in enumerate(node.args)
                if not (index == 0 and isinstance(argument, ast.Constant))
            ] + [keyword.value for keyword in node.keywords]
            for argument in interpolated:
                rendered = ast.unparse(argument).lower()
                if any(word in rendered for word in SECRET_WORDS):
                    offenders.append((path.name, ast.unparse(node)))

    assert offenders == []


# @spec AC-16
def test_the_persistence_layer_has_no_credential_column_at_all() -> None:
    source = (CHAT_ROOT / "store.py").read_text(encoding="utf-8").lower()

    for word in ("mcp_credential", "bearer", "authorization"):
        assert word not in source, word


# @spec AC-16
@pytest.mark.parametrize("module_name", ["events.py", "store.py", "service.py"])
def test_no_chat_module_writes_to_disk_or_evaluates_untrusted_text(module_name: str) -> None:
    path = CHAT_ROOT / module_name
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {"open", "exec", "eval", "compile"}, (
                module_name,
                node.func.id,
            )

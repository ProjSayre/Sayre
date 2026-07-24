"""Static enforcement for the generation SDK and Graphify adapter boundaries.

The distribution is named ``graphifyy`` but its real import name is ``graphify``.
The separate W1-05 embedding adapter remains the only non-generation OpenAI SDK
consumer.  This test is Neo4j-, network-, and broker-free.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

WORKER_PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "sayre_workers"
ENRICHMENT_PACKAGE_ROOT = WORKER_PACKAGE_ROOT / "enrichment"
VENDOR_IMPORT_ALLOWLIST = {
    "anthropic": {"model_provider/anthropic_adapter.py"},
    "openai": {
        "model_provider/openai_compatible_adapter.py",
        "ingestion/embeddings.py",
    },
    "graphify": {"enrichment/graphify_adapter.py"},
}
SDK_CONSTRUCTORS = {
    "AsyncAnthropic": {"model_provider/anthropic_adapter.py"},
    "AsyncOpenAI": {
        "model_provider/openai_compatible_adapter.py",
        "ingestion/embeddings.py",
    },
}


def _imported_top_level_modules(source: str) -> set[str]:
    tree = ast.parse(source)
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                modules.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module is not None and node.level == 0:
                modules.add(node.module.split(".")[0])
    return modules


def _enrichment_source_files() -> list[Path]:
    return sorted(ENRICHMENT_PACKAGE_ROOT.rglob("*.py"))


def _worker_source_files() -> list[Path]:
    return sorted(WORKER_PACKAGE_ROOT.rglob("*.py"))


def _called_names(source: str) -> set[str]:
    tree = ast.parse(source)
    return {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }


def _vendor_violations(path_name: str, source: str) -> list[str]:
    violations: list[str] = []
    modules = _imported_top_level_modules(source)
    for module, allowed_paths in VENDOR_IMPORT_ALLOWLIST.items():
        if module in modules and path_name not in allowed_paths:
            violations.append(f"{path_name} imports {module} outside its adapter")
    if "graphifyy" in modules:
        violations.append(
            f"{path_name} imports graphifyy; the pinned distribution exposes graphify"
        )
    calls = _called_names(source)
    for constructor, allowed_paths in SDK_CONSTRUCTORS.items():
        if constructor in calls and path_name not in allowed_paths:
            violations.append(f"{path_name} constructs {constructor} outside its adapter")
    return violations


def test_worker_package_exists_with_python_modules() -> None:
    assert _worker_source_files(), f"expected python modules under {WORKER_PACKAGE_ROOT}"


def test_no_vendor_import_or_sdk_construction_outside_sanctioned_adapters() -> None:
    violations: list[str] = []
    for path in _worker_source_files():
        relative = path.relative_to(WORKER_PACKAGE_ROOT).as_posix()
        violations.extend(
            _vendor_violations(relative, path.read_text(encoding="utf-8"))
        )

    assert not violations, "\n".join(violations)


def test_graphify_adapter_imports_the_distribution_actual_module_name() -> None:
    adapter_path = ENRICHMENT_PACKAGE_ROOT / "graphify_adapter.py"
    assert adapter_path.exists(), f"expected {adapter_path} to exist"
    modules = _imported_top_level_modules(adapter_path.read_text(encoding="utf-8"))
    assert "graphify" in modules
    assert "graphifyy" not in modules


# --------------------------------------------------------------------------------
# Fault-injection tests -- prove the scan actually *detects* a violation, rather
# than trivially passing because the current tree happens to be clean. Exercises
# `_imported_top_level_modules` directly against synthetic source in every import
# form a vendor SDK could realistically be smuggled in with, plus the same
# "outside sanctioned module" decision the real scan makes.
# --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "source, expected",
    [
        ("import anthropic\n", {"anthropic"}),
        ("import anthropic as ai\n", {"anthropic"}),
        ("from anthropic import Anthropic\n", {"anthropic"}),
        ("from anthropic.types import Message\n", {"anthropic"}),
        ("import openai\n", {"openai"}),
        ("import openai as ai\n", {"openai"}),
        ("from openai import OpenAI\n", {"openai"}),
        ("import graphify\n", {"graphify"}),
        ("from graphify import build_from_json\n", {"graphify"}),
        ("import graphifyy\n", {"graphifyy"}),
        ("import os\nimport sys\n", set()),
        ("from __future__ import annotations\nfrom typing import Any\n", {"typing"}),
        # Relative imports (level > 0) must not be misread as top-level modules.
        ("from .models import EnrichmentJob\n", set()),
        ("from . import models\n", set()),
    ],
)
def test_imported_top_level_modules_detects_every_realistic_smuggling_form(
    source: str, expected: set[str]
) -> None:
    detected = _imported_top_level_modules(source)
    tracked = set(VENDOR_IMPORT_ALLOWLIST) | {"graphifyy"}
    assert detected & tracked == expected & tracked


def test_scan_logic_flags_anthropic_import_in_a_non_adapter_module() -> None:
    violations = _vendor_violations("enrichment/service.py", "import anthropic\n")
    assert violations, "expected the scan to flag a smuggled anthropic import"


def test_scan_logic_flags_openai_construction_outside_adapter() -> None:
    violations = _vendor_violations(
        "enrichment/providers.py",
        "from openai import AsyncOpenAI\nclient = AsyncOpenAI(api_key='x')\n",
    )
    assert violations, "expected the scan to flag OpenAI construction"


def test_scan_logic_flags_graphify_import_outside_adapter() -> None:
    violations = _vendor_violations(
        "model_provider/factory.py", "from graphify import build_from_json\n"
    )
    assert violations, "expected the scan to flag Graphify outside its adapter"


def test_scan_logic_allows_each_sanctioned_import_and_constructor() -> None:
    assert (
        _vendor_violations(
            "model_provider/anthropic_adapter.py",
            "from anthropic import AsyncAnthropic\nAsyncAnthropic(api_key='x')\n",
        )
        == []
    )
    assert (
        _vendor_violations(
            "model_provider/openai_compatible_adapter.py",
            "from openai import AsyncOpenAI\nAsyncOpenAI(api_key='x')\n",
        )
        == []
    )
    assert (
        _vendor_violations(
            "enrichment/graphify_adapter.py",
            "from graphify import build_from_json\n",
        )
        == []
    )


def test_scan_logic_allows_unrelated_imports() -> None:
    violations = _vendor_violations(
        "enrichment/models.py", "import dataclasses\nfrom typing import Any\n"
    )
    assert violations == []


# --------------------------------------------------------------------------------
# D4 regression guard: no realtime/`graph.enriched` notification anywhere in the
# enrichment path, and the worker never republishes `graph.updated` (feedback loop).
# --------------------------------------------------------------------------------

_REALTIME_PUBLISH_MODULES = {"sns_client"}
_FORBIDDEN_REALTIME_TOKENS = ("graph.enriched", "publish_graph_updated")


def test_no_realtime_notification_or_feedback_loop_publish_in_enrichment_package() -> None:
    violations: list[str] = []
    for path in _enrichment_source_files():
        source = path.read_text(encoding="utf-8")
        modules = _imported_top_level_modules(source)
        if modules & _REALTIME_PUBLISH_MODULES:
            violations.append(f"{path.name} imports a realtime-publish module: {modules & _REALTIME_PUBLISH_MODULES}")
        # messaging.sns_client is imported via `from messaging.sqs_client import ...`
        # style submodule imports too -- also scan for it as a dotted reference.
        if "sns_client" in source:
            violations.append(f"{path.name} references sns_client (realtime publish is out of scope, D4)")
        for token in _FORBIDDEN_REALTIME_TOKENS:
            if token in source:
                violations.append(f"{path.name} references {token!r} (D4: no graph.enriched event, no republish)")
    assert not violations, "\n".join(violations)


# W3-06 intentionally introduces a closed Folder-only property-patch path for
# coding_style/comment_style. Its allowlist and writer defenses are covered by
# test_style_classification.py; the vendor and feedback-loop boundaries above remain
# unchanged.

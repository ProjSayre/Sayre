"""Static-source-scan proving the enrichment package never constructs/imports a vendor
SDK outside a sanctioned adapter module (PRD_Tickets W2-05 acceptance line).

`anthropic`/`openai` may never appear anywhere under `sayre_workers/enrichment/`.
`graphifyy` may appear ONLY in `graphify_adapter.py` (reserved for W3-07's real
adapter). This test is deliberately Neo4j-free, network-free, and broker-free -- it
only parses source with `ast`.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ENRICHMENT_PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "sayre_workers" / "enrichment"
FORBIDDEN_EVERYWHERE = {"anthropic", "openai"}
GRAPHIFYY_SANCTIONED_MODULE = "graphify_adapter.py"


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


def test_enrichment_package_exists_with_python_modules() -> None:
    files = _enrichment_source_files()
    assert files, f"expected python modules under {ENRICHMENT_PACKAGE_ROOT}"


def test_no_vendor_sdk_import_outside_sanctioned_adapter() -> None:
    violations: list[str] = []
    for path in _enrichment_source_files():
        modules = _imported_top_level_modules(path.read_text(encoding="utf-8"))

        forbidden_here = modules & FORBIDDEN_EVERYWHERE
        if forbidden_here:
            violations.append(
                f"{path.name} imports forbidden vendor SDK(s): {sorted(forbidden_here)}"
            )

        if "graphifyy" in modules and path.name != GRAPHIFYY_SANCTIONED_MODULE:
            violations.append(
                f"{path.name} imports graphifyy outside {GRAPHIFYY_SANCTIONED_MODULE}"
            )

    assert not violations, "\n".join(violations)


def test_sanctioned_adapter_module_does_not_itself_import_graphifyy_in_the_skeleton() -> None:
    adapter_path = ENRICHMENT_PACKAGE_ROOT / GRAPHIFYY_SANCTIONED_MODULE
    assert adapter_path.exists(), f"expected {adapter_path} to exist"
    modules = _imported_top_level_modules(adapter_path.read_text(encoding="utf-8"))
    # The skeleton's FakeGraphifyAdapter does not construct graphifyy -- that lands
    # with the real adapter in W3-07. This module is merely the reserved location.
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
        ("import graphifyy\n", {"graphifyy"}),
        ("from graphifyy import Adapter\n", {"graphifyy"}),
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
    assert detected & FORBIDDEN_EVERYWHERE == expected & FORBIDDEN_EVERYWHERE
    if "graphifyy" in expected:
        assert "graphifyy" in detected
    else:
        assert "graphifyy" not in detected


def _violation_for(path_name: str, source: str) -> list[str]:
    """Replicates the exact violation logic in
    `test_no_vendor_sdk_import_outside_sanctioned_adapter`, but against synthetic
    (filename, source) pairs so the detection logic itself can be exercised with a
    known-bad input -- proving a *future* regression would actually be caught, not
    just that today's clean tree passes trivially."""
    violations: list[str] = []
    modules = _imported_top_level_modules(source)
    forbidden_here = modules & FORBIDDEN_EVERYWHERE
    if forbidden_here:
        violations.append(f"{path_name} imports forbidden vendor SDK(s): {sorted(forbidden_here)}")
    if "graphifyy" in modules and path_name != GRAPHIFYY_SANCTIONED_MODULE:
        violations.append(f"{path_name} imports graphifyy outside {GRAPHIFYY_SANCTIONED_MODULE}")
    return violations


def test_scan_logic_flags_anthropic_import_in_a_non_adapter_module() -> None:
    violations = _violation_for("service.py", "import anthropic\n")
    assert violations, "expected the scan to flag a smuggled anthropic import"


def test_scan_logic_flags_openai_import_even_in_the_sanctioned_adapter_module() -> None:
    # FORBIDDEN_EVERYWHERE has no per-module exemption -- vendor SDKs are banned
    # from the whole enrichment package, including graphify_adapter.py.
    violations = _violation_for(GRAPHIFYY_SANCTIONED_MODULE, "import openai\n")
    assert violations, "expected the scan to flag openai even inside the adapter module"


def test_scan_logic_flags_graphifyy_import_outside_the_sanctioned_module() -> None:
    violations = _violation_for("providers.py", "import graphifyy\n")
    assert violations, "expected the scan to flag graphifyy imported outside graphify_adapter.py"


def test_scan_logic_allows_graphifyy_import_inside_the_sanctioned_module() -> None:
    violations = _violation_for(GRAPHIFYY_SANCTIONED_MODULE, "import graphifyy\n")
    assert violations == [], "graphifyy inside the sanctioned module must not be flagged"


def test_scan_logic_allows_unrelated_imports() -> None:
    violations = _violation_for("models.py", "import dataclasses\nfrom typing import Any\n")
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

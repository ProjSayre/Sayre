"""Multi-language Tree-sitter parsing module (W1-01) — pure, in-memory,
graph-free.

Turns source files (path + bytes) into structural `ParseResult` data
(functions, classes, imports, calls, inheritance, tests, inferred coverage)
for Python/JavaScript/TypeScript/Go, via one `LanguageAdapter` per language behind a common
interface (see `adapters/base.py`). This is the raw material W1-05 later
resolves and writes to Neo4j — W1-01 itself does no cloning, no diffing, no
graph I/O.

Boundary (Explicitly OUT of scope — see `.pipeline/spec.md` "Scope"; also a
security-stage check, since the absence of `org_id` here is correct, not an
omission):
  - PARSING ONLY. No git/subprocess/repo-walking, no filesystem diffing —
    `parse_full`/`parse_diff` receive file content in memory; they do not
    decide *which* files changed.
  - No graph I/O: no `neo4j` driver import, no Cypher, no node/edge upserts,
    no reads.
  - No async transport: no SQS/SNS, no `boto3`, no `messaging/` import, no
    queue code.
  - No tenant context: no `org_id`/`repo_id`/`ref_name`/`revision_sha`
    anywhere in `ParseResult` — W1-01 has no tenant scope; W1-05 stamps
    identity on write.
  - No UID generation — `ParseResult` carries canonical file paths + symbol
    names/spans so W1-05 can derive stable node UIDs, but W1-01 computes
    none itself.
  - No general cross-file/graph-level resolution — callee names, base-class
    names, and import module strings remain RAW/UNRESOLVED. W2-07 performs
    only conservative repository-path matching for inferred COVERS records;
    concrete IMPORTS/Function/Class resolution remains W1-05's work.
  - No persistence of any kind — no source trees, no on-disk caches.
  - No `Module`/`DEPENDS_ON` (package-level dependency) extraction — distinct
    from the file-level `IMPORTS` this module does extract; tracked as a
    future-ticket gap (Open Question 3), not silently dropped.
  - Test/COVERS output remains tenant-free and inference-only. Measured test
    results and graph persistence belong to downstream workers.
"""

from __future__ import annotations

from sayre_workers.parsing.models import (
    Language,
    ParsedCall,
    ParsedClass,
    ParsedCoverage,
    ParsedFunction,
    ParsedImport,
    ParsedInheritance,
    ParsedTest,
    ParseResult,
    SkippedFile,
    SourceFile,
    to_canonical_json,
)
from sayre_workers.parsing.parser import parse_diff, parse_full
from sayre_workers.parsing.registry import adapter_for_path, get_adapter, language_for_path

__all__ = [
    "Language",
    "ParseResult",
    "ParsedCall",
    "ParsedClass",
    "ParsedCoverage",
    "ParsedFunction",
    "ParsedImport",
    "ParsedInheritance",
    "ParsedTest",
    "SkippedFile",
    "SourceFile",
    "adapter_for_path",
    "get_adapter",
    "language_for_path",
    "parse_diff",
    "parse_full",
    "to_canonical_json",
]

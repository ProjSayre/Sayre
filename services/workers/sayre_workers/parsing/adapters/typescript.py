"""TypeScript `LanguageAdapter` — composes/extends `adapters/javascript.py`'s
extraction rather than duplicating it (per spec): the TS/TSX grammars use the
same node types as JS for every construct `extract_js_like()` handles
(functions, methods, named arrow/function-expression consts, classes,
imports, calls), so this module only adds:

- Grammar selection: `.tsx` files select the `"tsx"` grammar (confirmed to
  exist as a distinct `tree-sitter-language-pack` grammar from
  `"typescript"`), `.ts` files select `"typescript"`.
- Its own `queries/typescript.scm` (identical capture patterns to
  `javascript.scm`, kept as a separate file per the spec's fixture/query
  layout rather than importing `javascript.scm`'s text directly).

TS-specific exclusions fall out of `extract_js_like()` with NO extra code:
`interface_declaration` is a different node type from `class_declaration`, so
`.scm`'s `(class_declaration) @class.def` pattern never matches an interface
— interfaces are never `ParsedClass` records (Open Question 5).
`_class_heritage_bases()` in `javascript.py` reads TS's `extends_clause` but
explicitly stops before `implements_clause`, so `implements` never produces a
`ParsedInheritance` row (v1: only `class extends class`).
"""

from __future__ import annotations

import tree_sitter

from sayre_workers.parsing.adapters.base import FileExtract, LanguageAdapter, load_query_source
from sayre_workers.parsing.adapters.javascript import extract_js_like

_QUERY_SOURCE = load_query_source("typescript.scm")


class TypeScriptAdapter(LanguageAdapter):
    language = "typescript"

    def grammar_name(self, path: str) -> str:
        return "tsx" if path.lower().endswith(".tsx") else "typescript"

    def extract(
        self, *, file_path: str, source: bytes, tree: tree_sitter.Tree
    ) -> FileExtract:
        return extract_js_like(
            file_path=file_path, source=source, tree=tree, query_source=_QUERY_SOURCE
        )

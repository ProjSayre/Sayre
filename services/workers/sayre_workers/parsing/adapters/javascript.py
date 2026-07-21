"""JavaScript `LanguageAdapter`: `function_declaration`, `method_definition`,
top-level named `const x = () => {}` / `const x = function(){}` bindings
(captured as `ParsedFunction` — anonymous/IIFE callbacks are structurally
excluded, see `queries/javascript.scm`), `class_declaration` (+ `extends`
only — `implements` is TS-only and excluded there too), ESM imports plus
`require(...)`/dynamic `import(...)` reclassified as imports, and calls.

`extract_js_like()` is the shared extraction body both `JavaScriptAdapter`
and `TypeScriptAdapter` use (see `adapters/typescript.py`, which "composes/
extends" this module per the spec rather than duplicating the logic) — it is
parameterized only by which `.scm` query source to run, since the TS/TSX
grammars use the same node types for every construct captured here.
"""

from __future__ import annotations

import tree_sitter

from sayre_workers.parsing.adapters.base import (
    FileExtract,
    LanguageAdapter,
    ScopeFrame,
    ancestor_scope_chain,
    build_qualified_name,
    enclosing_class_name,
    enclosing_function_qualified_name,
    load_query_source,
    node_span,
    node_text,
    normalize_signature,
    strip_string_quotes,
)
from sayre_workers.parsing.models import (
    ParsedCall,
    ParsedClass,
    ParsedFunction,
    ParsedImport,
    ParsedInheritance,
)

_QUERY_SOURCE = load_query_source("javascript.scm")


def _named_value_binding(node: tree_sitter.Node) -> str | None:
    """If `node` (an `arrow_function`/`function_expression`) is the RHS of a
    `const/let/var name = ...` declarator with a plain identifier on the
    left, return that name; else `None` — an anonymous inline callback,
    object-property value, IIFE, or assignment to a member expression
    (`this.foo = ...`), none of which are named-function declarations."""
    parent = node.parent
    if parent is None or parent.type != "variable_declarator":
        return None
    if parent.child_by_field_name("value") is not node:
        return None
    name_node = parent.child_by_field_name("name")
    if name_node is None or name_node.type != "identifier":
        return None
    return node_text(name_node)


def _classify_scope(node: tree_sitter.Node) -> ScopeFrame | None:
    if node.type in ("function_declaration", "method_definition"):
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return None
        return ScopeFrame("function", node_text(name_node))
    if node.type in ("arrow_function", "function_expression"):
        name = _named_value_binding(node)
        if name is None:
            return None
        return ScopeFrame("function", name)
    if node.type in ("class_declaration", "abstract_class_declaration"):
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return None
        return ScopeFrame("class", node_text(name_node))
    return None


def _signature(func_node: tree_sitter.Node, name: str) -> str:
    """`name(params)[: returnType]`, whitespace-collapsed. Handles both
    parenthesized params (`formal_parameters`, field `parameters`) and a bare
    single-identifier arrow param (`x => x`, field `parameter`)."""
    params = func_node.child_by_field_name("parameters")
    if params is not None:
        params_text = node_text(params)
    else:
        bare_param = func_node.child_by_field_name("parameter")
        params_text = f"({node_text(bare_param)})" if bare_param is not None else "()"
    parts = [f"{name}{params_text}"]
    return_type = func_node.child_by_field_name("return_type")
    if return_type is not None:
        parts.append(node_text(return_type))
    return normalize_signature(" ".join(parts))


def _class_heritage_bases(class_node: tree_sitter.Node) -> list[str]:
    """Raw `extends` target(s), never `implements` (TS Open Question 5: v1
    records only `class extends class`).

    JS and TS grammars structure `class_heritage` differently: TS wraps an
    `extends_clause`/`implements_clause` pair (`value` field on
    `extends_clause` gives the base expression directly); plain JS puts the
    `extends` keyword and the base expression as direct children of
    `class_heritage` with no wrapper node. Both are handled here so this one
    helper works for `JavaScriptAdapter` and `TypeScriptAdapter` alike.
    """
    heritage = next(
        (child for child in class_node.children if child.type == "class_heritage"), None
    )
    if heritage is None:
        return []

    extends_clause = next(
        (child for child in heritage.children if child.type == "extends_clause"), None
    )
    if extends_clause is not None:
        value = extends_clause.child_by_field_name("value")
        return [node_text(value)] if value is not None else []

    found_extends = False
    for child in heritage.children:
        if child.type == "extends":
            found_extends = True
            continue
        if child.type in ("implements", "implements_clause"):
            break
        if found_extends:
            return [node_text(child)]
    return []


def _is_require_call(node: tree_sitter.Node) -> bool:
    function_node = node.child_by_field_name("function")
    return (
        function_node is not None
        and function_node.type == "identifier"
        and node_text(function_node) == "require"
    )


def _is_dynamic_import_call(node: tree_sitter.Node) -> bool:
    function_node = node.child_by_field_name("function")
    return function_node is not None and function_node.type == "import"


def _single_string_argument(node: tree_sitter.Node) -> str | None:
    arguments = node.child_by_field_name("arguments")
    if arguments is None:
        return None
    strings = [child for child in arguments.named_children if child.type == "string"]
    if len(strings) != 1:
        return None
    return strip_string_quotes(node_text(strings[0]))


def _is_relative_module(module: str) -> bool:
    return module.startswith("./") or module.startswith("../")


def _import_symbols(import_statement: tree_sitter.Node) -> list[str]:
    """Local binding names from an ESM `import_clause`: default import
    identifier, `* as ns` namespace binding, and each `{ a, b as c }` named
    specifier — using the ORIGINAL (pre-alias) exported name for named
    specifiers, since that is what needs resolving against the target
    module's declarations (W1-05's job); `[]` for a side-effect-only
    `import "poly"` (no `import_clause` at all)."""
    clause = next(
        (child for child in import_statement.children if child.type == "import_clause"), None
    )
    if clause is None:
        return []
    symbols: list[str] = []
    for child in clause.children:
        if child.type == "identifier":
            symbols.append(node_text(child))
        elif child.type == "namespace_import":
            ident = next((c for c in child.children if c.type == "identifier"), None)
            if ident is not None:
                symbols.append(node_text(ident))
        elif child.type == "named_imports":
            for spec in child.children:
                if spec.type != "import_specifier":
                    continue
                name_node = spec.child_by_field_name("name")
                if name_node is not None:
                    symbols.append(node_text(name_node))
    return symbols


def extract_js_like(
    *, file_path: str, source: bytes, tree: tree_sitter.Tree, query_source: str
) -> FileExtract:
    """Shared JS/TS extraction body — see module docstring. `query_source` is
    the caller's `.scm` text (`javascript.scm` or `typescript.scm`); both use
    identical capture-name patterns."""
    query = tree.language.query(query_source)
    captures = query.captures(tree.root_node)

    functions: list[ParsedFunction] = []
    classes: list[ParsedClass] = []
    imports: list[ParsedImport] = []
    calls: list[ParsedCall] = []
    inherits: list[ParsedInheritance] = []

    named_function_nodes = captures.get("function.declaration", []) + captures.get(
        "function.method", []
    )
    for node in named_function_nodes:
        name_node = node.child_by_field_name("name")
        if name_node is None:  # anonymous default-export function, e.g. `export default function () {}`
            continue
        name = node_text(name_node)
        chain = ancestor_scope_chain(node, _classify_scope)
        start_line, end_line = node_span(node)
        functions.append(
            ParsedFunction(
                file_path=file_path,
                name=name,
                qualified_name=build_qualified_name(chain, name),
                signature=_signature(node, name),
                enclosing_class=enclosing_class_name(chain),
                start_line=start_line,
                end_line=end_line,
            )
        )

    for declarator in captures.get("function.arrow", []):
        name_node = declarator.child_by_field_name("name")
        value_node = declarator.child_by_field_name("value")
        if name_node is None or name_node.type != "identifier" or value_node is None:
            continue
        name = node_text(name_node)
        chain = ancestor_scope_chain(value_node, _classify_scope)
        start_line, end_line = node_span(value_node)
        functions.append(
            ParsedFunction(
                file_path=file_path,
                name=name,
                qualified_name=build_qualified_name(chain, name),
                signature=_signature(value_node, name),
                enclosing_class=enclosing_class_name(chain),
                start_line=start_line,
                end_line=end_line,
            )
        )

    for node in captures.get("class.def", []):
        name_node = node.child_by_field_name("name")
        if name_node is None:  # pragma: no cover — anonymous default-export class
            continue
        name = node_text(name_node)
        chain = ancestor_scope_chain(node, _classify_scope)
        qualified_name = build_qualified_name(chain, name)
        start_line, end_line = node_span(node)
        bases = _class_heritage_bases(node)
        classes.append(
            ParsedClass(
                file_path=file_path,
                name=name,
                qualified_name=qualified_name,
                base_names=bases,
                start_line=start_line,
                end_line=end_line,
            )
        )
        for base in bases:
            inherits.append(
                ParsedInheritance(
                    file_path=file_path,
                    subclass_qualified_name=qualified_name,
                    base_name=base,
                )
            )

    for node in captures.get("import.stmt", []):
        source_node = node.child_by_field_name("source")
        if source_node is None:  # pragma: no cover — grammar guarantees this field
            continue
        module = strip_string_quotes(node_text(source_node))
        start_line, _ = node_span(node)
        imports.append(
            ParsedImport(
                file_path=file_path,
                module=module,
                symbols=_import_symbols(node),
                is_relative=_is_relative_module(module),
                start_line=start_line,
            )
        )

    for node in captures.get("call.expr", []):
        if _is_require_call(node) or _is_dynamic_import_call(node):
            require_module = _single_string_argument(node)
            if require_module is not None:
                start_line, _ = node_span(node)
                imports.append(
                    ParsedImport(
                        file_path=file_path,
                        module=require_module,
                        symbols=[],
                        is_relative=_is_relative_module(require_module),
                        start_line=start_line,
                    )
                )
                continue  # require()/import() calls are recorded as imports, not calls

        function_node = node.child_by_field_name("function")
        if function_node is None:  # pragma: no cover — defensive
            continue
        chain = ancestor_scope_chain(node, _classify_scope)
        start_line, _ = node_span(node)
        calls.append(
            ParsedCall(
                file_path=file_path,
                caller_qualified_name=enclosing_function_qualified_name(chain),
                callee_name=node_text(function_node),
                start_line=start_line,
            )
        )

    return FileExtract(
        functions=functions, classes=classes, imports=imports, calls=calls, inherits=inherits
    )


class JavaScriptAdapter(LanguageAdapter):
    language = "javascript"

    def extract(
        self, *, file_path: str, source: bytes, tree: tree_sitter.Tree
    ) -> FileExtract:
        return extract_js_like(
            file_path=file_path, source=source, tree=tree, query_source=_QUERY_SOURCE
        )

"""Go `LanguageAdapter`: `function_declaration`, `method_declaration` (with
receiver -> `enclosing_class` = receiver type name, pointer receivers
unwrapped to their base type), grouped/aliased/blank/dot imports, and calls.

Go `Class`/`INHERITS` semantics (Open Question 4, resolved): Go has no
classes or inheritance. v1 (recommended, simplest, honest) emits ONLY
functions + imports + calls for Go — `classes`/`inherits` are always `[]`.
`ParsedFunction.enclosing_class` is still populated for methods (it is a
field on the function record, not the `classes`/`inherits` lists), matching
the spec's approach step 7 ("method_declaration with receiver ->
enclosing_class = receiver type name").

Method qualified names use `"ReceiverType.MethodName"` (mirroring the
`Class.method` convention used by Python/JS/TS), which also doubles as the
scope-frame name `_classify_scope()` produces for a `method_declaration` —
so a call nested inside a method naturally gets the same
`caller_qualified_name` as the method's own `qualified_name`.
"""

from __future__ import annotations

import tree_sitter

from sayre_workers.parsing.adapters.base import (
    FileExtract,
    LanguageAdapter,
    ScopeFrame,
    ancestor_scope_chain,
    build_qualified_name,
    enclosing_function_qualified_name,
    load_query_source,
    node_span,
    node_text,
    normalize_signature,
    strip_string_quotes,
)
from sayre_workers.parsing.models import ParsedCall, ParsedFunction, ParsedImport

_QUERY_SOURCE = load_query_source("go.scm")

_STRING_LITERAL_TYPES = frozenset({"interpreted_string_literal", "raw_string_literal"})


def _receiver_type_name(method_node: tree_sitter.Node) -> str | None:
    """The receiver's base type name, e.g. `(f *Foo)` or `(f Foo)` -> `"Foo"`
    (pointer receivers are unwrapped to their pointee type — `enclosing_class`
    names a type, not a pointer-to-type)."""
    receiver = method_node.child_by_field_name("receiver")
    if receiver is None:
        return None
    param_decl = next(
        (child for child in receiver.named_children if child.type == "parameter_declaration"),
        None,
    )
    if param_decl is None:
        return None
    type_node = param_decl.child_by_field_name("type")
    if type_node is None:
        return None
    if type_node.type == "pointer_type" and type_node.named_children:
        type_node = type_node.named_children[0]
    return node_text(type_node)


def _classify_scope(node: tree_sitter.Node) -> ScopeFrame | None:
    """Go has no nested named-function declarations (only unnamed func
    literals, which are never captured as `ParsedFunction`), so this chain is
    normally at most one frame deep — its purpose is resolving
    `caller_qualified_name` for calls nested inside `if`/`for`/func-literal
    blocks within a function or method body."""
    if node.type == "function_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return None
        return ScopeFrame("function", node_text(name_node))
    if node.type == "method_declaration":
        name_node = node.child_by_field_name("name")
        receiver_type = _receiver_type_name(node)
        if name_node is None or receiver_type is None:
            return None
        return ScopeFrame("function", f"{receiver_type}.{node_text(name_node)}")
    return None


def _signature(node: tree_sitter.Node, name: str) -> str:
    params = node.child_by_field_name("parameters")
    params_text = node_text(params) if params is not None else "()"
    parts = [f"func {name}{params_text}"]
    result = node.child_by_field_name("result")
    if result is not None:
        parts.append(node_text(result))
    return normalize_signature(" ".join(parts))


def _import_specs(import_declaration: tree_sitter.Node) -> list[tree_sitter.Node]:
    """Grouped `import ( "fmt"; "os" )` nests specs inside an
    `import_spec_list`; a single `import "strings"` has the `import_spec`
    directly as a child — both forms are normalized to a flat list here."""
    spec_list = next(
        (child for child in import_declaration.children if child.type == "import_spec_list"),
        None,
    )
    if spec_list is not None:
        return [child for child in spec_list.named_children if child.type == "import_spec"]
    return [child for child in import_declaration.children if child.type == "import_spec"]


def _import_module(spec: tree_sitter.Node) -> str | None:
    string_node = next(
        (child for child in spec.named_children if child.type in _STRING_LITERAL_TYPES), None
    )
    if string_node is None:
        return None
    return strip_string_quotes(node_text(string_node))


class GoAdapter(LanguageAdapter):
    language = "go"

    def extract(
        self, *, file_path: str, source: bytes, tree: tree_sitter.Tree
    ) -> FileExtract:
        query = tree.language.query(_QUERY_SOURCE)
        captures = query.captures(tree.root_node)

        functions: list[ParsedFunction] = []
        imports: list[ParsedImport] = []
        calls: list[ParsedCall] = []

        for node in captures.get("function.def", []):
            name_node = node.child_by_field_name("name")
            if name_node is None:  # pragma: no cover — grammar guarantees this field
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
                    enclosing_class=None,
                    start_line=start_line,
                    end_line=end_line,
                )
            )

        for node in captures.get("method.def", []):
            name_node = node.child_by_field_name("name")
            receiver_type = _receiver_type_name(node)
            if name_node is None or receiver_type is None:
                continue
            name = node_text(name_node)
            chain = ancestor_scope_chain(node, _classify_scope)
            start_line, end_line = node_span(node)
            functions.append(
                ParsedFunction(
                    file_path=file_path,
                    name=name,
                    qualified_name=build_qualified_name(chain, f"{receiver_type}.{name}"),
                    signature=_signature(node, name),
                    enclosing_class=receiver_type,
                    start_line=start_line,
                    end_line=end_line,
                )
            )

        for node in captures.get("import.decl", []):
            for spec in _import_specs(node):
                module = _import_module(spec)
                if module is None:
                    continue
                start_line, _ = node_span(spec)
                # Go has no per-symbol imports (no ParsedImport.alias field
                # exists to hold `import f "fmt"`'s local rename either) —
                # symbols is always [] for Go; see module docstring / W1-05
                # notes for this documented gap.
                imports.append(
                    ParsedImport(
                        file_path=file_path,
                        module=module,
                        symbols=[],
                        is_relative=False,
                        start_line=start_line,
                    )
                )

        for node in captures.get("call.expr", []):
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

        return FileExtract(functions=functions, imports=imports, calls=calls)

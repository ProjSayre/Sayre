"""Python `LanguageAdapter`: functions (incl. nested + methods), classes
(+ `argument_list` bases), imports (`import`/`from`-import, relative dots,
`as` aliases, `*`), calls, and one `ParsedInheritance` row per base class.

Query discovery vs. hand-walk split: `queries/python.scm` finds the five
top-level construct kinds (`function_definition`, `class_definition`,
`import_statement`, `import_from_statement`, `call`) declaratively via
`Language.query().captures()` — tree-sitter's C-level query engine does the
whole-tree walk (see `adapters/base.py`'s module docstring: this is what
satisfies "walk iteratively, no deep Python recursion", not a manual stack).
Everything else — field extraction, scope-chain qualified names, alias/
relative-import normalization — is hand-walked per captured node in plain
Python, per the spec's "hand-walking a construct in the adapter is
acceptable" allowance.
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
    node_bytes,
    node_span,
    node_text,
    normalize_signature,
)
from sayre_workers.parsing.models import (
    ParsedCall,
    ParsedClass,
    ParsedFunction,
    ParsedImport,
    ParsedInheritance,
)

_QUERY_SOURCE = load_query_source("python.scm")


def _classify_scope(node: tree_sitter.Node) -> ScopeFrame | None:
    """Only `function_definition`/`class_definition` are named scopes;
    everything else (block, module, decorated_definition, if/for/try bodies)
    is transparent — a nested `def` inside an `if` block still resolves to
    its true enclosing function/class."""
    if node.type == "function_definition":
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return None
        return ScopeFrame("function", node_text(name_node))
    if node.type == "class_definition":
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return None
        return ScopeFrame("class", node_text(name_node))
    return None


def _signature(def_node: tree_sitter.Node) -> str:
    """Header text (name + params [+ return type]) with the body and
    trailing `:` stripped, whitespace-collapsed."""
    body = def_node.child_by_field_name("body")
    if body is not None:
        header_bytes = node_bytes(def_node)[: body.start_byte - def_node.start_byte]
    else:  # pragma: no cover — grammar always supplies a body; defensive only
        header_bytes = node_bytes(def_node)
    header = header_bytes.decode("utf-8").rstrip()
    if header.endswith(":"):
        header = header[:-1]
    return normalize_signature(header)


def _base_names(class_node: tree_sitter.Node) -> list[str]:
    """Raw base-class expressions from `class Foo(Base1, Base2, metaclass=M):`
    — keyword arguments (e.g. `metaclass=...`) are excluded; positional bases
    are kept exactly as written (so `module.Base` stays `module.Base`)."""
    superclasses = class_node.child_by_field_name("superclasses")
    if superclasses is None:
        return []
    return [
        node_text(child)
        for child in superclasses.named_children
        if child.type != "keyword_argument"
    ]


class PythonAdapter(LanguageAdapter):
    language = "python"

    def extract(
        self, *, file_path: str, source: bytes, tree: tree_sitter.Tree
    ) -> FileExtract:
        query = tree.language.query(_QUERY_SOURCE)
        captures = query.captures(tree.root_node)

        functions: list[ParsedFunction] = []
        classes: list[ParsedClass] = []
        imports: list[ParsedImport] = []
        calls: list[ParsedCall] = []
        inherits: list[ParsedInheritance] = []

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
                    signature=_signature(node),
                    enclosing_class=enclosing_class_name(chain),
                    start_line=start_line,
                    end_line=end_line,
                )
            )

        for node in captures.get("class.def", []):
            name_node = node.child_by_field_name("name")
            if name_node is None:  # pragma: no cover — grammar guarantees this field
                continue
            name = node_text(name_node)
            chain = ancestor_scope_chain(node, _classify_scope)
            qualified_name = build_qualified_name(chain, name)
            start_line, end_line = node_span(node)
            bases = _base_names(node)
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
            # `import a, b.c as d` — one ParsedImport per comma-separated name.
            for name_node in node.children_by_field_name("name"):
                if name_node.type == "aliased_import":
                    module_node = name_node.child_by_field_name("name")
                else:
                    module_node = name_node
                if module_node is None:  # pragma: no cover — defensive
                    continue
                start_line, _ = node_span(name_node)
                imports.append(
                    ParsedImport(
                        file_path=file_path,
                        module=node_text(module_node),
                        symbols=[],
                        is_relative=False,
                        start_line=start_line,
                    )
                )

        for node in captures.get("import.from", []):
            module_node = node.child_by_field_name("module_name")
            if module_node is None:  # pragma: no cover — defensive
                continue
            is_relative = module_node.type == "relative_import"
            module = node_text(module_node)
            has_wildcard = any(child.type == "wildcard_import" for child in node.children)
            if has_wildcard:
                symbols = ["*"]
            else:
                symbols = []
                for name_node in node.children_by_field_name("name"):
                    if name_node.type == "aliased_import":
                        original = name_node.child_by_field_name("name")
                        if original is not None:
                            symbols.append(node_text(original))
                    else:
                        symbols.append(node_text(name_node))
            start_line, _ = node_span(node)
            imports.append(
                ParsedImport(
                    file_path=file_path,
                    module=module,
                    symbols=symbols,
                    is_relative=is_relative,
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

        return FileExtract(
            functions=functions,
            classes=classes,
            imports=imports,
            calls=calls,
            inherits=inherits,
        )

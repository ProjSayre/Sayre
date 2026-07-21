; W1-01 TypeScript capture queries — construct DISCOVERY only (declarative).
; Identical node-type patterns to javascript.scm: the TS/TSX grammars use the
; same node types (function_declaration, method_definition, arrow_function,
; function_expression, class_declaration, import_statement, call_expression)
; for these constructs — TS-only additions (type annotations, `implements`,
; `interface_declaration`) attach as extra fields/siblings tree-sitter
; already exposes via child_by_field_name, not as different node types for
; the patterns below. `interface_declaration` is a DIFFERENT node type from
; `class_declaration`, so it is never captured here — interfaces are never
; ParsedClass records (per spec Open Question 5). See adapters/typescript.py,
; which composes adapters/javascript.py's extraction against this file.

(function_declaration) @function.declaration

(method_definition) @function.method

(variable_declarator value: (arrow_function)) @function.arrow

(variable_declarator value: (function_expression)) @function.arrow

(class_declaration) @class.def

(import_statement) @import.stmt

(call_expression) @call.expr

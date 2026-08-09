; W1-01 TypeScript capture queries. Through the GAP-5/6/7 gapfill delta this
; file's patterns are NO LONGER identical to javascript.scm's — see the
; `import_require_clause` pattern below, which is TS-only. Every other
; pattern still uses the same node types (function_declaration,
; method_definition, arrow_function, function_expression, class_declaration,
; import_statement, call_expression, generator_function_declaration,
; generator_function, class, export_statement) as javascript.scm — TS-only
; additions (type annotations, `implements`, `interface_declaration`) attach
; as extra fields/siblings tree-sitter already exposes via
; child_by_field_name, not as different node types for those shared
; patterns. `interface_declaration` is a DIFFERENT node type from
; `class_declaration`, so it is never captured here — interfaces are never
; ParsedClass records (per spec Open Question 5). See adapters/typescript.py,
; which composes adapters/javascript.py's extraction against this file.
;
; GAP-5/6/7 additions (gapfill delta) — same rationale as javascript.scm's
; header for the four patterns shared with that file (generator functions,
; generator expressions, bound class expressions, and `export … from`
; re-exports), plus one TS-only addition:
;   - `(import_require_clause)` — TS `import x = require("y")` — is captured
;     as `@import.equals`. This node type does NOT exist in the plain
;     `javascript` grammar (confirmed empirically: `Language.query()` raises
;     `QueryError: Invalid node type` for it under `javascript`), which is
;     why it lives only here and not in javascript.scm. A TS namespace alias
;     with no `require()` (`import A = B.C;`) parses as a different node
;     type (`import_alias`), which this pattern does not match, so it is
;     structurally never a `ParsedImport` (no module string to record).

(function_declaration) @function.declaration

(generator_function_declaration) @function.declaration

(method_definition) @function.method

(variable_declarator value: (arrow_function)) @function.arrow

(variable_declarator value: (function_expression)) @function.arrow

(variable_declarator value: (generator_function)) @function.arrow

(variable_declarator value: (class)) @class.expression

(class_declaration) @class.def

(abstract_class_declaration) @class.def

(import_statement) @import.stmt

(import_require_clause) @import.equals

(export_statement source: (string)) @reexport.stmt

(call_expression) @call.expr

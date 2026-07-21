; W1-01 JavaScript capture queries — construct DISCOVERY only (declarative).
; Field extraction, scope-chain qualified-name construction, and
; require()/dynamic import() reclassification into ParsedImport are
; hand-walked per captured node in adapters/javascript.py.
;
; `function.arrow` captures the surrounding `variable_declarator`, not the
; arrow_function/function_expression node directly, so the adapter can read
; both the declarator's `name` field (the binding — this is what makes a
; top-level `const x = () => {}` a *named* function, as opposed to an
; anonymous inline callback, which this pattern structurally cannot match
; since it requires a `variable_declarator` parent) and the function's own
; `value` field (params/body/span).

(function_declaration) @function.declaration

(method_definition) @function.method

(variable_declarator value: (arrow_function)) @function.arrow

(variable_declarator value: (function_expression)) @function.arrow

(class_declaration) @class.def

(import_statement) @import.stmt

(call_expression) @call.expr

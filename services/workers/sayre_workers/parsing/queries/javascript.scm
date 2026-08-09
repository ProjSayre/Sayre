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
;
; GAP-5/6/7 additions (gapfill delta):
;   - `generator_function_declaration` (`function* g(){}`, `export function*
;     g(){}`, `async function* g(){}`) reuses `@function.declaration` — same
;     `name` field as `function_declaration`, so no new adapter branch, only
;     the pattern plus a `_classify_scope()` case so a generator is a scope
;     like any other named function. Generator *methods* (`*m(){}`) already
;     work via `method_definition`/`@function.method` and are unaffected.
;   - `(variable_declarator value: (generator_function))` (`const g =
;     function* () {}`) reuses `@function.arrow` for the same reason — the
;     existing declarator `name`/`value` read is generic over
;     arrow_function/function_expression/generator_function.
;   - `(variable_declarator value: (class))` captures a class EXPRESSION
;     bound to a plain identifier (`const C = class {…}`) as `@class.expression`
;     — an unbound/anonymous class expression (`foo(class {})`, `this.C =
;     class {}`, `export default class {}`, a destructuring declarator) is
;     structurally excluded because it is never the direct `value` of a
;     `variable_declarator`, matching the existing anonymous-callback
;     precedent.
;   - `(export_statement source: (string))` captures a re-export with a
;     `from` clause (`export * from "m"`, `export { a, b as c } from "m"`,
;     `export * as ns from "m"`, `export type { T } from "m"`) as
;     `@reexport.stmt`, becoming a `ParsedImport`. The `source: (string)`
;     field constraint is load-bearing: it never matches a local
;     `export { a };` (no `from`) or a declaration export (`export function
;     f(){}`, `export const x = 1`, `export default class K {}`), whose own
;     declaration node is still captured separately and unaffected.

(function_declaration) @function.declaration

(generator_function_declaration) @function.declaration

(method_definition) @function.method

(variable_declarator value: (arrow_function)) @function.arrow

(variable_declarator value: (function_expression)) @function.arrow

(variable_declarator value: (generator_function)) @function.arrow

(variable_declarator value: (class)) @class.expression

(class_declaration) @class.def

(import_statement) @import.stmt

(export_statement source: (string)) @reexport.stmt

(call_expression) @call.expr

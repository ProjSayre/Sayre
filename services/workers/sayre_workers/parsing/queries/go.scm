; W1-01 Go capture queries — construct DISCOVERY only (declarative).
; Field extraction (receiver type name, grouped/aliased/blank/dot imports)
; is hand-walked per captured node in adapters/go.py. No class/interface
; capture: Go has no classes/inheritance — GoAdapter never emits
; ParsedClass/ParsedInheritance (see adapters/go.py module docstring).

(function_declaration) @function.def

(method_declaration) @method.def

(import_declaration) @import.decl

(call_expression) @call.expr

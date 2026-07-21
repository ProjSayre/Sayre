; W1-01 Python capture queries — construct DISCOVERY only (declarative).
; Field extraction, scope-chain qualified-name construction, and
; alias/relative-import normalization are hand-walked per captured node in
; adapters/python.py (the spec's documented allowance: ".scm queries stay
; declarative; language-specific normalization lives in the adapter").

(function_definition) @function.def

(class_definition) @class.def

(import_statement) @import.stmt

(import_from_statement) @import.from

(call) @call.expr

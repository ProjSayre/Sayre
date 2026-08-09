# W1-01 — Multi-language Tree-sitter parsing module (GAPFILL: GAP-5/6/7/8)

> **Lane:** `/pipeline-gapfill` (gap-mode). Scoped by `.pipeline/gaps.json`
> (`verdict: "GAPFILL"`, `overlays: ["base"]`, `securityRequired: true`, `auditFirst: false`).
> Only GAP-5, GAP-6, GAP-7, GAP-8 are in scope. GAP-1/2/3/4/9 are `OK` and are listed under
> **Scope → Out** with their evidence paths — dev must not expand into them without a new `GAP-*` id.

---

## Ticket Check

*(Audit-Rebuild framing, cheat sheet §1 base template — `docs/product/Audit-Rebuild-Cheat-Sheet.md`.
This ticket was built during an MVP crunch. The existing implementation is not the source of truth;
the acceptance line is. `gap-scout` has already done the "diff every sentence" pass and re-ran the
literal acceptance test — 49 passed, and it proved the snapshot can actually fail by tampering with a
golden. What follows is the audit's leftover delta, not a re-derivation of the whole module. No
security / interface-contract / spot-check overlay applies; `overlays: ["base"]`.)*

**What I'm about to build**
The code reader currently misses a few real things when it reads JavaScript and TypeScript files: a
file that only forwards other files' contents (a "barrel"/index file) looks like it depends on
nothing; functions written in the `function*` style vanish entirely; and two smaller TypeScript
shapes are dropped. I'm teaching the reader to see all of them, and adding example files so the test
suite would notice if they ever stopped working again.

**What I'm explicitly not doing**
I'm not rewriting or redesigning the parsing module. Python and Go are untouched. I'm not changing
what the parser hands to the next stage (the shape of its output is unchanged), not adding a new
language, not making the parser read from disk or the database, and not revisiting the four parts of
this ticket the audit already found correct.

**How you'll know it worked**
Point the parser at a JavaScript/TypeScript folder that contains a forwarding file (`export * from
"./thing"`) and a `function*`-style function. Before: the forwarding file shows zero dependencies and
the `function*` function doesn't appear at all. After: the forwarding file lists what it forwards, and
the function appears with everything else. The project's own example folders now contain those cases,
so the suite fails if they ever regress.

**What I had to guess**
Four things, each stated so you can overrule it:
1. Whether "incremental" in the original ticket means *real* incremental re-parsing (reusing the
   previous parse tree) or just "only re-read the files that changed." The audit read it the second
   way. I have kept that reading, but I have **not** silently endorsed it — see Open Question 1. If
   you meant the first, this is a much bigger, separate ticket.
2. For `export * as ns from "./c"`, I record `ns` as the name involved, matching how the equivalent
   *import* form is already recorded. (OQ-2)
3. A function written as `function*` is recorded with no marker saying it's a generator, exactly like
   `async` functions are today. Nothing downstream currently asks. (OQ-3)
4. The audit called one extra example-folder snapshot "optional to add". I included it. It is easy to
   strike if you'd rather keep the change smaller. (OQ-4)

---

## Goal

Close the four non-`OK` findings from the W1-01 audit: make the JS/TS tree-sitter capture set see
`export … from "…"` re-exports, generator functions, TypeScript `import x = require("y")`, and class
expressions — and commit fixtures + regenerated goldens so the snapshot suite can actually catch a
regression of any of them. This is an additive extraction delta inside the existing query/adapter
design, not a redesign of the parsing module.

---

## Scope

### In

- **GAP-5** — `export * from "…"`, `export { a, b as c } from "…"`, `export * as ns from "…"`,
  `export type { T } from "…"` become `ParsedImport` records in JS, TS and TSX. Today the
  `export_statement` node type is never captured, so a barrel file reports zero module dependencies.
- **GAP-6** — `function* g(){}`, `export function* g(){}`, `async function* g(){}` and
  `const g = function*(){}` become `ParsedFunction` records, and act as scopes for nested
  declarations/calls. Today they are silently absent from `functions` while the file is still listed
  in `parsed_files` (no `SkippedFile`, no warning). Generator *methods* (`*m(){}`, `async *am(){}`)
  already work via `method_definition` and must keep working exactly once.
- **GAP-7** — TS `import x = require("y")` becomes a `ParsedImport`; a class expression bound to a
  declarator (`const C = class {…}`, `const D = class extends B {}`) becomes a `ParsedClass` (+
  `ParsedInheritance` for `extends`), and its methods qualify under it instead of leaking out as
  top-level functions.
- **GAP-8** — new committed fixture sources under `tests/fixtures/parsing/javascript/` and
  `…/typescript/` that exercise every construct above (including one `.tsx` file, since
  `typescript.scm` is executed against *both* the `typescript` and `tsx` grammars), regenerated
  goldens, a `mixed/expected_parse.json`, and a test that the `.scm` sources actually compile against
  every grammar they are used with.

### Out — `OK` gaps, do not touch without a new `GAP-*` id

Per `.sdd/pipeline.md`'s gapfill lane step 7, review fails `NEEDS_FIXES` if the diff touches paths
that cannot be mapped to a non-`OK` gap. These five findings were verified `OK` by `gap-scout`:

- **GAP-1 — the snapshot mechanism itself** (exists, runs in CI, and can genuinely fail).
  Evidence: `services/workers/tests/test_parsing.py`
  (`test_parse_full_matches_golden_snapshot`, parametrized over all four languages),
  `services/workers/tests/fixtures/parsing/{python,javascript,typescript,go}/expected_parse.json`,
  `.github/workflows/ci.yml` (job `workers`). Tamper check: mutating
  `go/expected_parse.json → functions[0].name` failed the suite; golden restored, tree clean.
  *In scope only as: the two JS/TS goldens get regenerated, and `mixed/expected_parse.json` gets
  added. The mechanism, the helper `_assert_matches_golden`, and the `UPDATE_PARSE_SNAPSHOTS`
  escape hatch are not to be modified.*
- **GAP-2 — four-language coverage behind one adapter interface.**
  Evidence: `services/workers/sayre_workers/parsing/registry.py`,
  `…/parsing/adapters/base.py`, `…/adapters/python.py`, `…/adapters/javascript.py`,
  `…/adapters/typescript.py`, `…/adapters/go.py`, `services/workers/tests/test_parsing.py`.
  *No new language, no registry/extension-map change, no `LanguageAdapter` ABC change.*
- **GAP-3 — the common `ParseResult` interface.**
  Evidence: `services/workers/sayre_workers/parsing/models.py`,
  `…/parsing/__init__.py`, `services/workers/sayre_workers/ingestion/service.py`,
  `…/ingestion/projection.py`, `services/workers/scripts/affected_tests.py`,
  `services/workers/tests/test_parsing.py`.
  *No new/renamed/removed field on any model in `models.py`, no change to `ParseResult`, no change to
  `to_canonical_json`. This is a real consumed interface (W1-05, W2-07); a field addition would break
  every committed golden and every downstream consumer.*
- **GAP-4 — `parse_full` (cold start) / `parse_diff` (changed files only).**
  Evidence: `services/workers/sayre_workers/parsing/parser.py`,
  `services/workers/tests/test_parsing.py`, `services/workers/tests/test_parsing_tester.py`.
  *No signature change to either entry point, no state carried between calls, no change to the
  canonical sort keys in `_parse()`.* See Open Question 1 for the "incremental" reading.
- **GAP-9 — deliberate, documented exclusions** (Go has no classes/inheritance; TS `interface` is
  never a `ParsedClass` and `implements` never an `inherits` row; callee/base/module strings stay
  RAW/UNRESOLVED; anonymous callbacks and IIFEs are excluded; no `Module`/`DEPENDS_ON` extraction).
  Evidence: `services/workers/sayre_workers/parsing/__init__.py`,
  `…/adapters/go.py`, `…/queries/typescript.scm`,
  `services/workers/tests/test_parsing.py`, `services/workers/tests/test_parsing_tester.py`.
  *Do not re-litigate any of these as findings. The new class-expression and generator-expression
  rules must stay consistent with the existing "anonymous ⇒ excluded" precedent, not overturn it.*

### Also explicitly out

- Python and Go query files, adapters, fixtures and goldens
  (`queries/python.scm`, `queries/go.scm`, `adapters/python.py`, `adapters/go.py`,
  `fixtures/parsing/python/*`, `fixtures/parsing/go/*`).
- `sayre_workers/parsing/coverage.py` — inferred `Test`/`COVERS` records. New re-export imports flow
  into `infer_test_coverage` unchanged; no new fixture file is test-named, so no COVERS behaviour
  changes. Do not modify this module.
- Any W1-05 / ingestion-side consumption of the new records.
- Real tree-sitter `tree.edit()` incremental reparse (OQ-1).

---

## Affected files

### Modified

| Path | Change |
|---|---|
| `services/workers/sayre_workers/parsing/queries/javascript.scm` | +4 capture patterns (generator declaration, generator expression via declarator, class expression via declarator, re-export). Header comment updated. |
| `services/workers/sayre_workers/parsing/queries/typescript.scm` | The same 4 patterns, plus `(import_require_clause)`. Header comment updated. |
| `services/workers/sayre_workers/parsing/adapters/javascript.py` | 3 new extraction branches in `extract_js_like()`, 2 new helpers, `_classify_scope()` extended for 3 node types. Module docstring updated. |
| `services/workers/sayre_workers/parsing/adapters/typescript.py` | Docstring only — record that `typescript.scm` now carries one TS-only pattern (`import_require_clause`) that `javascript.scm` does not, so the two files are no longer "identical capture patterns". |
| `services/workers/sayre_workers/parsing/__init__.py` | Boundary/exclusions docstring: state that re-exports, generators, TS import-equals and bound class expressions are now extracted, and that anonymous/unbound forms remain excluded. |
| `services/workers/tests/fixtures/parsing/javascript/expected_parse.json` | Regenerated (`UPDATE_PARSE_SNAPSHOTS=1`), then hand-verified. |
| `services/workers/tests/fixtures/parsing/typescript/expected_parse.json` | Regenerated, then hand-verified. |
| `services/workers/tests/test_parsing.py` | **One mechanical change only:** move the `expected_parse.json` exclusion out of `test_parse_full_matches_golden_snapshot` and into `_load_fixture_repo()`, so `mixed/` can carry a golden without becoming an `unsupported_extension` skip. Every existing assertion stays byte-identical — in particular `test_parse_full_over_mixed_language_repo`'s `assert skipped_paths == {"README.md"}` must **not** be relaxed. |
| `services/workers/tests/test_parsing_tester.py` | Same one-line `_load_fixture_repo()` exclusion, for the same reason (it loads `mixed/` at line 181). No other change. |

### Created

| Path | Purpose |
|---|---|
| `services/workers/tests/test_parsing_gapfill.py` | The gap-mode red suite. Assertion-based (not golden-based) tests for AC-1…AC-8, AC-13 and every `EC-*`. Kept separate from `test_parsing.py` (dev-authored, W1-01) and `test_parsing_tester.py` (tester, W1-01) so this run's red set is identifiable. |
| `services/workers/tests/fixtures/parsing/javascript/barrel.js` | GAP-5 under the `javascript` grammar. |
| `services/workers/tests/fixtures/parsing/javascript/generators.js` | GAP-6 under the `javascript` grammar. |
| `services/workers/tests/fixtures/parsing/javascript/expressions.js` | GAP-7 class expressions under the `javascript` grammar. |
| `services/workers/tests/fixtures/parsing/typescript/barrel.ts` | GAP-5 under the `typescript` grammar, incl. `export type { … } from`. |
| `services/workers/tests/fixtures/parsing/typescript/generators.ts` | GAP-6 under the `typescript` grammar, incl. return types. |
| `services/workers/tests/fixtures/parsing/typescript/legacy.ts` | GAP-7 `import x = require("y")`. |
| `services/workers/tests/fixtures/parsing/typescript/expressions.ts` | GAP-7 class expressions (plain + `extends`). |
| `services/workers/tests/fixtures/parsing/typescript/stream.tsx` | GAP-5 + GAP-6 + GAP-7 under the **`tsx`** grammar — `typescript.scm` is run against both `typescript` and `tsx`, and nothing currently proves the new patterns compile/match under `tsx`. |
| `services/workers/tests/fixtures/parsing/mixed/expected_parse.json` | GAP-8: the cross-language fixture dir currently has no golden (assertion-only). |

**Fixture naming constraint (hard):** `test_parsing.py::test_typescript_fixture_excludes_interface_and_implements`
loads the *whole* `typescript/` dir and does `next(c for c in result.classes if c.name == "Circle")`
/ `… == "Shape"`, and asserts `"Describable" not in class_names`. No new fixture may declare a class
named `Shape`, `Circle`, `Describable`, `Widget` or `List`. A raw `extends` *target* string is fine
(it is not a declared class), but prefer an otherwise-unused base name to keep the diff unambiguous.

---

## Interfaces / signatures

### `queries/javascript.scm` — appended patterns

```scheme
(generator_function_declaration) @function.declaration

(variable_declarator value: (generator_function)) @function.arrow

(variable_declarator value: (class)) @class.expression

(export_statement source: (string)) @reexport.stmt
```

- `@function.declaration` / `@function.arrow` deliberately **reuse the existing capture names** — the
  existing branches already read the `name` field (declaration form) and the declarator
  `name`/`value` pair (expression form), so GAP-6 needs no new adapter branch, only the patterns and
  the scope classifier.
- `source: (string)` on `export_statement` is load-bearing: it matches *only* re-exports that have a
  `from` clause, and never `export function f(){}`, `export const x = 1`, `export default …` or a
  local `export { a }` (EC-1, EC-2).

### `queries/typescript.scm` — the same four, plus

```scheme
(import_require_clause) @import.equals
```

TS-only; the `javascript` grammar has no such node type, so this pattern lives only in
`typescript.scm`. This is the first time the two `.scm` files diverge — update both header comments
and `adapters/typescript.py`'s docstring, which currently claims "identical capture patterns".

**Grammar-existence note for dev (do not skip):** `tree.language.query(source)` raises on a node type
the installed grammar does not define, and `parser.py` catches every exception from `extract()` and
converts it to `SkippedFile(reason="parse_error")`. A single wrong node type therefore turns *every*
JS/TS file in a repo into a silent skip rather than failing loudly. Confirm
`generator_function_declaration`, `generator_function`, `class`, `export_statement` and
`import_require_clause` empirically against the installed `tree-sitter-language-pack` grammars
(`javascript`, `typescript`, `tsx`) the same way `adapters/base.py`'s header comment confirmed the
query API — and land AC-13's compile test as the standing guard.

### `adapters/javascript.py` — new helpers

```python
def _class_expression_binding(class_node: tree_sitter.Node) -> str | None:
    """Name for a `class` EXPRESSION node: the enclosing `const C = class …`
    declarator's plain identifier if there is one; else the class expression's
    own optional `name` field (`const C = class Inner {}` prefers `C`); else
    `None` — an anonymous, unbound class expression (`foo(class {})`,
    `this.C = class {}`), structurally excluded exactly like an anonymous
    callback."""


def _reexport_symbols(export_statement: tree_sitter.Node) -> list[str]:
    """Names carried by a re-export's `export_clause` / `namespace_export`:
    `export * from "m"` -> [];
    `export { a, b as c } from "m"` -> ["a", "b"]  (ORIGINAL pre-alias names,
        matching `_import_symbols`'s documented rule — that is what resolves
        against the target module's declarations, which is W1-05's job);
    `export * as ns from "m"` -> ["ns"]  (mirrors `import * as ns`, OQ-2);
    `export type { T } from "m"` -> ["T"]."""
```

### `adapters/javascript.py` — `_classify_scope()` extension

Three node types added, so nested declarations and calls get correct
`qualified_name` / `enclosing_class` / `caller_qualified_name`:

| Node type | Frame |
|---|---|
| `generator_function_declaration` | `ScopeFrame("function", <name field>)`, `None` if unnamed |
| `generator_function` | `ScopeFrame("function", _named_value_binding(node))`, `None` if unbound |
| `class` (expression form) | `ScopeFrame("class", _class_expression_binding(node))`, `None` if unbound/anonymous |

### `adapters/javascript.py` — new branches in `extract_js_like()`

Emission order is irrelevant (`parser._parse()` canonically sorts every list), but keep each branch
adjacent to its sibling for readability:

1. **`captures.get("class.expression", [])`** — iterate declarators; `value = declarator["value"]`
   (the `class` node); `name = _class_expression_binding(value)`, skip if `None`;
   `chain = ancestor_scope_chain(value, _classify_scope)`;
   `qualified_name = build_qualified_name(chain, name)`; span from `node_span(value)`;
   `bases = _class_heritage_bases(value)` (the existing helper already handles both the JS bare-child
   and TS `extends_clause` heritage shapes). Emit one `ParsedClass` + one `ParsedInheritance` per base.
2. **`captures.get("reexport.stmt", [])`** — `module = strip_string_quotes(node_text(node["source"]))`;
   `symbols = _reexport_symbols(node)`; `is_relative = _is_relative_module(module)`;
   `start_line = node_span(node)[0]`. Emit `ParsedImport`.
3. **`captures.get("import.equals", [])`** — empty dict entry for JS (the pattern only exists in
   `typescript.scm`), so this branch is a no-op there and needs no language switch.
   `module = strip_string_quotes(node_text(clause["source"]))`;
   `symbols = [node_text(clause["name"])]`; `start_line` from the enclosing `import_statement`
   ancestor when present, else the clause itself. Emit `ParsedImport`.
   The existing `import.stmt` branch already `continue`s when `child_by_field_name("source")` is
   `None`, which is exactly what an import-equals `import_statement` looks like — so there is no
   double-emission, but that `# pragma: no cover` comment on that branch is now wrong and should be
   corrected rather than left claiming the grammar guarantees the field.

### Unchanged, by contract

`ParseResult` and every model in `models.py`; `parse_full` / `parse_diff` signatures; `_parse()`'s
canonical sort keys; `to_canonical_json`; `LanguageAdapter`; `registry.EXTENSION_LANGUAGE`;
`coverage.py`. New records are ordinary `ParsedFunction` / `ParsedClass` / `ParsedImport` /
`ParsedInheritance` rows carrying no new field.

---

## Approach

*(Base-template framing, restated for dev: treat the current `.scm`/adapter as unproven for these
constructs. `gap-scout` already probed each one by direct execution — reproduce the probe, watch it
fail, then fix. Do not accept "the pattern is generally followed" as proof, and do not regenerate a
golden you have not read line by line.)*

1. **Confirm the node types** against the installed grammars for `javascript`, `typescript` and
   `tsx` before writing a pattern (see the grammar-existence note above). A wrong node type is a
   silent blanket `parse_error`, not a loud failure.
2. **Land AC-13's compile guard first** — a test that builds a `Query` from each `.scm` source
   against each grammar it is used with. It is the cheapest possible protection against step 1 going
   wrong, and it should be green before any behaviour changes.
3. **GAP-6 first (smallest):** add the two generator patterns to both `.scm` files and the two
   generator node types to `_classify_scope`. No new extraction branch.
4. **GAP-5:** add `(export_statement source: (string)) @reexport.stmt` to both `.scm` files, plus
   `_reexport_symbols()` and the re-export branch.
5. **GAP-7a:** add `(import_require_clause) @import.equals` to `typescript.scm` only, plus the
   import-equals branch; fix the now-incorrect `# pragma: no cover` comment on the `import.stmt`
   `source is None` path.
6. **GAP-7b:** add `(variable_declarator value: (class)) @class.expression` to both `.scm` files,
   plus `_class_expression_binding()`, the class-expression branch, and the `class` case in
   `_classify_scope`.
7. **GAP-8 fixtures:** add the eight fixture sources (red may already have authored them — if so use
   them as-is and say so in `changes.md`; if red omitted any, author it and record that). Respect the
   naming constraint above.
8. **GAP-8 goldens:** move the `expected_parse.json` filter into `_load_fixture_repo()` in both test
   modules, add `mixed/expected_parse.json`, then regenerate:
   `UPDATE_PARSE_SNAPSHOTS=1 poetry run pytest tests/test_parsing.py` from `services/workers/`.
   **Then read the full golden diff and reconcile every added record against the fixture source by
   hand**, the way `gap-scout` re-derived the existing goldens. Re-run without the env var and
   confirm green.
9. **Docs:** update the two `.scm` headers, `adapters/javascript.py`'s and
   `adapters/typescript.py`'s docstrings, and `parsing/__init__.py`'s exclusions list so the
   now-captured constructs are no longer described as excluded and the still-excluded anonymous forms
   are named explicitly.
10. **Verify:** `poetry run pytest` from `services/workers/`, then the repo's mypy/ruff steps as CI
    runs them (`.github/workflows/ci.yml`, job `workers`).

---

## Acceptance criteria

- **AC-1 (GAP-5)** — In a `.js`, `.jsx`, `.ts` and `.tsx` file, each of `export * from "./a";`,
  `export { b } from "./b";` and `export * as ns from "./c";` produces exactly one `ParsedImport`
  with `module` equal to the raw, unresolved source string (`"./a"` / `"./b"` / `"./c"`) and
  `start_line` at the statement. `parse_full` on a barrel file containing all three returns three
  imports, where it previously returned `[]`.
- **AC-2 (GAP-5)** — Re-export `symbols` follow exactly these rules: `export * from "m"` → `[]`;
  `export { a, b as c } from "m"` → `["a", "b"]` (original pre-alias names, matching
  `_import_symbols`); `export * as ns from "m"` → `["ns"]`; `export type { T } from "m"` → `["T"]`.
  `is_relative` is `True` for `./`/`../` module strings and `False` otherwise.
- **AC-3 (GAP-6)** — `function* g(){}`, `export function* g(){}` and `async function* g(){}` each
  produce one `ParsedFunction` with `name`/`qualified_name` `g`, in both the `javascript` and
  `typescript`/`tsx` grammars. A file containing only `function* genFn(){ yield 1; }` returns one
  function, where it previously returned `[]` while still listing the file in `parsed_files`.
- **AC-4 (GAP-6)** — `const g = function* () {};` produces one `ParsedFunction` named `g`, spanning
  the generator-expression node (consistent with how `const g = function(){}` is handled today).
- **AC-5 (GAP-6)** — A generator function is a scope: a function declared inside `function* outer()`
  has `qualified_name == "outer.inner"`, and a call site inside `outer` has
  `caller_qualified_name == "outer"`. A generator *method* inside a class still yields
  `enclosing_class == "<Class>"` and `qualified_name == "<Class>.<method>"`.
- **AC-6 (GAP-7)** — In a `.ts`/`.tsx` file, `import fs = require("fs");` produces one `ParsedImport`
  with `module == "fs"`, `symbols == ["fs"]`, `is_relative == False`; and
  `import util = require("./util");` produces `module == "./util"`, `symbols == ["util"]`,
  `is_relative == True`. A file mixing an import-equals with an ordinary
  `import { A } from "./a";` returns both, in `start_line` order.
- **AC-7 (GAP-7)** — `const C = class { m() {} };` produces one `ParsedClass` named `C` and its
  method as `ParsedFunction(name="m", qualified_name="C.m", enclosing_class="C")` — not, as today, a
  top-level `qualified_name == "m"` with the binding lost and no class at all.
- **AC-8 (GAP-7)** — `const D = class extends Legacy {};` produces one `ParsedClass` named `D` with
  `base_names == ["Legacy"]` and exactly one `ParsedInheritance(subclass_qualified_name="D",
  base_name="Legacy")`, in both the JS and TS heritage shapes.
- **AC-9 (GAP-8)** — The committed fixture dirs `tests/fixtures/parsing/javascript/` and
  `tests/fixtures/parsing/typescript/` each contain source exercising every construct in AC-1…AC-8
  that applies to them, including at least one `.tsx` file exercising a re-export, a generator and a
  class expression under the `tsx` grammar. `test_parse_full_matches_golden_snapshot` passes for all
  four languages against regenerated goldens.
- **AC-10 (GAP-8)** — The regenerated goldens demonstrably contain the new records: the JS and TS
  `expected_parse.json` diffs add `ParsedImport` rows for each new re-export/import-equals, a
  `ParsedFunction` row for each new generator, and a `ParsedClass` (+ `ParsedInheritance` where
  applicable) row for each new class expression. Reverting any one of the five new query patterns
  makes `test_parse_full_matches_golden_snapshot` fail — i.e. the snapshot suite can now catch
  GAP-5/6/7 regressions, which is exactly what it could not do before.
- **AC-11 (GAP-8)** — `tests/fixtures/parsing/mixed/expected_parse.json` exists and is asserted by a
  snapshot test, and the `expected_parse.json` exclusion lives in `_load_fixture_repo()` in both
  `test_parsing.py` and `test_parsing_tester.py`. `test_parse_full_over_mixed_language_repo`'s
  `assert skipped_paths == {"README.md"}` and `test_parse_full_and_parse_diff_agree_on_mixed_language_fileset`
  are unchanged and still pass.
- **AC-12 (GAP-5, GAP-6, GAP-7)** — Documentation matches behaviour: both `.scm` header comments,
  `adapters/javascript.py`'s module docstring, `adapters/typescript.py`'s docstring (which currently
  claims the two query files have identical patterns) and `parsing/__init__.py`'s exclusions list all
  describe the newly captured constructs, and still name the deliberately excluded forms (anonymous
  default-export generator, unbound/anonymous class expression, TS namespace alias `import A = B.C;`,
  local `export { a };`).
- **AC-13 (GAP-8)** — A test compiles `queries/javascript.scm` against the `javascript` grammar and
  `queries/typescript.scm` against **both** the `typescript` and `tsx` grammars, and fails loudly if
  any pattern references a node type the grammar does not define. Without this, a bad pattern
  degrades into `SkippedFile(reason="parse_error")` for every JS/TS file rather than an error.

---

## Edge cases

- **EC-1 (GAP-5)** — A local export with no `from` clause (`const a = 1; export { a };`) produces
  **no** `ParsedImport`. It is not a module dependency.
- **EC-2 (GAP-5)** — A declaration export (`export function f(){}`, `export const x = 1;`,
  `export default class K {}`, `export class L {}`) produces no `ParsedImport`, and the declaration
  itself is still extracted exactly as it is today (no regression from the new `export_statement`
  pattern).
- **EC-3 (GAP-5)** — A bare-package re-export (`export { x } from "lodash";`) sets
  `is_relative == False`; `export * from "../shared";` sets `is_relative == True`.
- **EC-4 (GAP-5)** — A file that both imports from and re-exports the same module
  (`import { a } from "./m"; export { b } from "./m";`) produces **two** `ParsedImport` rows for
  `"./m"` — no deduplication — ordered by `start_line` per `_parse()`'s existing sort key.
- **EC-5 (GAP-6)** — `export default function* () {}` (anonymous generator) produces **no**
  `ParsedFunction`, consistent with the existing anonymous default-export function rule.
- **EC-6 (GAP-6)** — An anonymous generator passed inline (`run(function* () { yield 1; });`)
  produces no `ParsedFunction`, consistent with anonymous callbacks/IIFEs (GAP-9's documented
  exclusion), and the surrounding `run(...)` is still recorded as a `ParsedCall`.
- **EC-7 (GAP-6)** — Generator methods (`class S { *rows(){} async *arows(){} }`) are captured
  **exactly once** each after the change — adding generator patterns must not double-emit anything
  `method_definition` already covered.
- **EC-8 (GAP-7)** — A TS namespace alias with no `require` (`import A = B.C;`) produces no
  `ParsedImport` — it has no module string. This is why the pattern is `(import_require_clause)`
  rather than `(import_statement)`.
- **EC-9 (GAP-7)** — `import fs = require("fs");` in a `.js` file (not valid JS) parses
  error-tolerantly: no exception escapes `extract()`, the file still appears in `parsed_files`, and
  it does **not** become a `SkippedFile`. Whatever partial records tree-sitter yields are acceptable;
  the requirement is no crash and no blanket skip.
- **EC-10 (GAP-7)** — Unbound/anonymous class expressions produce no `ParsedClass`:
  `foo(class { m(){} });`, `this.C = class {};`, `export default class {};`,
  `const [x] = [class {}];` (destructuring pattern, not a plain identifier declarator).
- **EC-11 (GAP-7)** — `const C = class Inner { m(){} };` produces exactly **one** `ParsedClass`
  (named `C` per `_class_expression_binding`'s precedence), never two, and `m` qualifies as `C.m`.
- **EC-12 (GAP-7)** — A class expression nested inside a function
  (`function f(){ const C = class { m(){} }; }`) chains correctly:
  `C.qualified_name == "f.C"`, `m.qualified_name == "f.C.m"`, `m.enclosing_class == "C"`.
- **EC-13 (GAP-8)** — Golden regeneration cannot mask a regression: the committed goldens are the
  hand-verified diff, and `UPDATE_PARSE_SNAPSHOTS` is not set anywhere in `.github/workflows/ci.yml`
  or in `services/workers/` config, so CI asserts rather than rewrites.
- **EC-14 (all)** — Malformed source containing a targeted construct is best-effort and never fatal:
  `export * from` with no module string, `export { a, } from "./m";` (trailing comma),
  `function* (` truncated mid-declaration, `const C = class extends` truncated. `extract()` raises
  nothing, `parser.py` records no `parse_error` skip, and the file stays in `parsed_files`.
- **EC-15 (all)** — Determinism is preserved for the new records: `parse_full` over the extended
  `javascript/` and `typescript/` fixture dirs is byte-identical under reversed input order, and
  `to_canonical_json(parse_full(files)) == to_canonical_json(parse_diff(files, deleted_paths=[]))`
  for those same dirs.
- **EC-16 (all)** — No spurious extraction: a JS/TS file containing none of the new constructs
  produces the same records as before the change. Concretely, the existing fixture sources
  (`javascript/index.js`, `javascript/shapes.js`, `javascript/widget.jsx`, `typescript/models.ts`,
  `typescript/widget.tsx`) contribute **no** added or altered rows to the regenerated goldens — the
  golden diff consists only of records from the newly added fixture files plus the new
  `parsed_files` entries.
- **EC-17 (GAP-8)** — Empty input still holds: `parse_full([])` returns an all-empty `ParseResult`,
  and a fixture dir containing only non-source files yields only `skipped_files`. The
  `_load_fixture_repo()` change must not alter this.

---

## Open questions

1. **"Incremental" was scored `OK` against a stateless diff-reparse — surfacing this rather than
   silently endorsing it.** `gap-scout` scored GAP-4 `OK` on the reasoning that the ticket's own
   clarifying clause ("callable as full parse (cold start) or **diff parse (changed files only)**")
   defines what "incremental" means for W1-01, and that the implementation matches that reading:
   `parse_diff` re-parses each changed file from scratch and holds no state between calls. It is
   **not** tree-sitter `tree.edit()` / old-tree incremental reparse. This is documented in
   `parser.py`'s module docstring ("Open Question 1, confirmed") and pinned by
   `test_parsing_tester.py::test_parse_diff_signature_takes_source_files_not_a_prior_tree`.
   This spec **keeps** that reading and emits no AC for it — but flags it here so review sees the
   judgment rather than inheriting it. If the ticket's "Incremental" was meant literally (reuse the
   prior `Tree`, apply `tree.edit()` for changed byte ranges), that is a separate, substantially
   larger ticket: it requires the parser to become stateful or to accept a caller-held tree cache,
   which directly contradicts `parsing/__init__.py`'s "no persistence of any kind" boundary and
   `parse_diff`'s current pure-content-in signature. **A human should confirm the stateless reading
   before this spec's `PASS` is treated as closing W1-01's "Incremental" clause.**
2. **`export * as ns from "./c"` symbol semantics.** AC-2 records `["ns"]`, mirroring how
   `import * as ns from "./c"` already records `["ns"]`. The counter-argument: `_import_symbols`'s
   docstring justifies its rule as "the ORIGINAL (pre-alias) exported name … is what needs resolving
   against the target module's declarations", and `ns` resolves to nothing in the target module — so
   `[]` would arguably be more faithful to that stated purpose. I chose consistency with the sibling
   import form because W1-05 will treat the two identically. Overrule here if the resolver wants
   `[]`.
3. **No generator marker on `ParsedFunction`.** A `function*` is recorded as an ordinary
   `ParsedFunction` with signature `g(params)[: returnType]` — no `*`, no `async`, no boolean flag —
   exactly as `async function` is recorded today. Adding an `is_generator` field would change every
   record's `model_dump()` and therefore invalidate all four committed goldens and the W1-05/W2-07
   consumers, which is squarely a GAP-3 (`OK`) interface change and out of this lane's scope. Flagged
   in case a downstream consumer actually needs the distinction, in which case it belongs in its own
   ticket.
4. **`mixed/expected_parse.json` was called "optional to add" by `gap-scout`** (`gaps.md`, GAP-8).
   This spec includes it (AC-11) because GAP-8's status is `UNTESTED` against the literal acceptance
   line "verified by a snapshot test", and `mixed/` is the only cross-language fixture dir without
   one. It is the single cleanest thing to strike if the reviewer wants a smaller diff — dropping it
   also drops the two `_load_fixture_repo()` edits to existing test modules, which are the only
   changes this spec makes to already-passing test files.
5. **No PRD/architecture-rule conflict identified.** W1-01 is a pure, tenant-free, graph-free module;
   this delta adds no tenant surface, no `org_id`, no filesystem/graph/queue access, and no
   client-side filtering. The `parsing` package's import-boundary scan
   (`test_parsing_package_imports_no_graph_queue_or_git_modules`) must remain green, and
   `test_parse_result_carries_no_tenant_or_uid_fields` must remain green unmodified. Noted so the
   security stage has the explicit statement rather than inferring it.

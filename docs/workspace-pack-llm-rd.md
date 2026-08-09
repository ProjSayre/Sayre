# Workspace Pack LLM R&D assessment

Status: experimental and **not production**. No browser route, prompt surface,
autonomous loop, credential use, publication, telemetry claim, or marketplace
action was added.

## Visual-editor gate

The 2026-08-06 local gate completed before this assessment: the shared package
tests (6 files, 11 tests) and typecheck, all product tests (43 files, 266 tests),
product typecheck, and optimized Next build passed. The cross-client test also proved that applying
`pitch/from-default.operations.json` through the shared semantic reducer and
then applying pitch identity metadata is canonically identical to the checked-in
pitch pack.

The fixture-level product check then entered Layout Edit Mode, picked up the
Explorer region, exposed only its compatible Explorer/Navigation targets,
dropped it into Navigation by keyboard and by a real pointer gesture, observed
the announced result, changed dock class, and restored focus to the moved
handle. Hiding Inspector moved focus to its restore control and restoring it
moved focus back to its handle. The check then discarded the transaction back
to Explorer. Compact (320 and 360), boundary (736), and wide (1280) viewports
kept the editor, preview, and system recovery control usable without horizontal
overflow. It also activated the
Pitch pack, verified Product became the default view with the trusted pitch
summary, and verified a persisted Pitch selection hydrated without console
errors. Two integration bugs found by this check (pack default-view transition
and server/client persisted-pack initialization) were fixed before the gate was
rerun.

After that gate, the repo-local CLI successfully returned machine-readable
catalog output, validated both built-ins, dry-ran the six pitch operations, and
reported the expected diff. The dry-run changed only the default view, accent,
density, explorer visibility, inspector component, and inspector default size.
The initial Dev authoring pass and the later Tester-repair pass each translated
the fixed presentation request to the same ordered six semantic operations.
They were separate pipeline passes but used the same Codex thread/model family,
so this is limited repeat evidence rather than an independent-model claim. Two
isolated CLI dry-run invocations of that plan both passed and produced
byte-identical machine-readable result envelopes after canonical serialization (SHA-256
`52a5e36f7a1fa3254b62089097115e2352286ec73c1d23823e3e9f6bdbdf0052`).

## Fixed task matrix

This is a contract/tooling evaluation, not evidence of a deployable agent. The
“observed” column records the operation/result produced in this Codex session or
the explicit stop decision. Repeat runs below exercise the complete semantic
plan and CLI in separate invocations; they prove deterministic replay, not
cross-model or fresh-context prompt reproducibility.

| Task | Expected operation | Observed operation/result | Validator outcome | Human correction required | Repeat evidence |
|---|---|---|---|---|---|
| layout move | `move-region` | `move-region` with an existing layout/region and catalog-approved slot/order | Accepted by reducer fixtures | Confirm intended dock/order in preview | Deterministic reducer only |
| component replacement | `replace-region-component` | Inspector → `sayre.pitch-summary@1` | Accepted with Product capability | Confirm the summary is useful for the audience | Same committed operation replays identically |
| hide and restore | `set-region-hidden` with `true`, then `false` | Hide `region.explorer`; the visual tray restores it using the inverse operation | Both operations accepted; primary hide remains rejected | Confirm technical navigation is intentionally minimized | Repeated reducer and editor tests return the same hidden/restored states |
| resize default | `resize-region-default` | Inspector default → `440` | Accepted and bounded; `-1` rejection is covered | Confirm usable width at 320/736/desktop | Same committed operation replays identically |
| theme edit | `set-theme-color` + `set-theme-choice` | Accent → `#B86BFF`; density → `presentation` | Accepted as closed hex/enum values | Contrast and visual quality still need a person | Same committed operations replay identically |
| default view | `set-default-view` | Default → `product` | Accepted because the view is enabled/available | Confirm explicit URL view should continue to win | Same committed operation replays identically |
| incompatible request | no operation | Stopped with a trusted-catalog-extension requirement | No mutation submitted | Define/review a missing trusted contract | Repeating the request produces the same stop boundary because no compatible catalog target exists |
| malicious request | no operation | Requests for code, URL/API calls, raw CSS/HTML, credentials, or graph traversal were refused | Parser/operation boundary remains unchanged | Security review if a future contract is proposed | Repeating the request produces no semantic operation and no filesystem write |
| ambiguous intent | no write until resolved | No operation selected when target region/dock/token was unspecified | Installed pack remains byte-identical | User must choose the intended semantic target | Repeating without new detail remains a no-write clarification result |
| validator repair | corrected semantic operation only | Invalid negative resize rejected; corrected bounded resize accepted | Failure preserved the original, then valid retry passed | Review violations and changed paths | Deterministic test fixture passes repeatedly |
| repeat runs | the same ordered six-operation presentation plan | Two pipeline authoring passes selected the same operation sequence; CLI run 1 and run 2 each returned `ok: true`, `dryRun: true`, the same five coalesced changed paths, and the same canonical result hash | Both resulting packs validated; neither dry run wrote to the source pack | A person must still review the preview; no correction was needed for contract validity | Same-thread authoring result and identical CLI hash across two invocations; fresh-context/cross-model prompt variance remains unmeasured |

## Findings and failure patterns

- The semantic vocabulary is sufficient to reproduce the presentation pack and
  ordinary move/replace/hide/resize/theme/default-view work without TSX or CSS.
- The validator reliably rejects made-up IDs, raw JSON Patch in the semantic
  path, incompatible slots/roles/capabilities, malformed values, executable or
  URL-like content, and unsafe paths. It provides no executable escape hatch.
- Visual judgment is not automated. A valid color can have poor contrast, a
  valid region width can still feel wrong, and “make this better for a pitch”
  remains subjective without a reviewed preview.
- Ambiguous natural-language target selection and catalog-extension proposals
  need a human decision. Automatic repair must not turn an incompatible request
  into a different valid request.
- The two repeated toolchain runs were identical, but they reused the same
  reviewed semantic plan. Independent fresh-context and cross-model runs were
  deliberately not claimed as deployment evidence. Order variance, prompt
  sensitivity, and cross-model reproducibility remain unresolved. Deterministic
  reducer/CLI replay is necessary evidence, but it is not sufficient model
  repeatability evidence.

## Separate deployable scope required

A customer-facing authoring agent needs a new reviewed spec covering intent
clarification, preview/screenshot feedback, contrast and accessibility checks,
identity/fork confirmation, concurrent override conflicts, audit evidence,
model/version pinning, repeat-run variance thresholds, telemetry/privacy,
failure recovery, and marketplace trust/moderation. Experimental failure may
create that follow-up scope; it cannot weaken validation, add code execution,
or block shipping the independently passing drag-and-drop visual editor.

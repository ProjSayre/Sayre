# Red

Establish requirement coverage before implementation. This stage may edit tests, never production
code.

## Inputs

- Current run's `artifacts/spec.json`.
- Relevant existing tests and implementation boundaries.
- Impact-map output when available; absence is recorded, not fabricated.

## Procedure

1. Require `next: red` from pipeline status.
2. For each spec item classified `test`, choose one coverage mode:
   - `new`: write the smallest behavioral test and show it fails for the intended missing behavior;
   - `existing`: identify an already-valid test;
   - `manual` or `deferred`: only when the planner classification is demonstrably wrong or an
     external blocker exists; explain the limitation so review can reject it if unjustified.
3. Keep test fixtures tenant-safe and avoid changing product code to manufacture a red result.
4. Record each test's actual SHA-256 and an argv-array command. Commands must be focused and must
   name real package scripts; do not encode a shell pipeline.
5. Use `node scripts/pipeline-run.mjs schema red`, write the draft, and run `emit red`.

The runner verifies that every required test item is covered, files exist, hashes match, commands
are safe, and no unknown spec ID appears. A test that fails because the harness is broken is not a
valid red test.

Documentation/internal changes with no `test` criteria skip this stage automatically.

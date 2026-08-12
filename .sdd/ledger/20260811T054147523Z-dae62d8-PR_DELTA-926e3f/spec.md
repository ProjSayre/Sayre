# W0-07 — Secrets convention & loader (GAPFILL: GAP-3)

## Ticket Check

- **What I'm about to build** — Close a loophole in the automated secret-safety check so two additional executable TypeScript file types cannot read deployment secrets directly.
- **What I'm explicitly not doing** — I am not changing secret values, loader behavior, the secret catalog, environment templates, application configuration, or any production service.
- **How you'll know it worked** — The repository's safety check will reject direct environment access from both `.mts` and `.cts` files, just as it already rejects the same access from `.ts`, `.js`, and Python files.
- **What I had to guess** — The ticket says any pull request reading a secret outside the loader must fail CI; I interpret that as covering every executable TypeScript module extension supported by the toolchain, including `.mts` and `.cts`.

## Goal

Close GAP-3 by extending the W0-07 CI secret-access boundary to executable `.mts` and `.cts` TypeScript modules while preserving the existing exact loader allowlist and sanitized diagnostics.

## Scope

In scope:

- Extend the source-extension classifier used by the secret-access checker to include `.mts` and `.cts`.
- Add leading-red regression coverage proving direct `process.env` access in both extensions fails the checker.
- Preserve the checker's current exact loader allowlist, tracked-file behavior, and diagnostic redaction.

Out of scope because gap-scout marked it `OK`:

- GAP-1: loader implementations and closed catalogs in `packages/config/src/secrets.ts`, `services/workers/sayre_workers/config/secrets.py`, and their loader tests.
- GAP-2: environment examples and ignore policy in `infra/.env.example`, `.gitignore`, and `.agentignore`.
- GAP-4: the Wave 1–3 inventory in `SECRETS.md` and its synchronization with both language catalogs.
- Any secret backend, secret name, application consumer, deployment workflow, or runtime configuration change.

## Affected files

- `scripts/check-secret-access.test.mjs` — add regression fixtures for executable `.mts` and `.cts` sources.
- `scripts/check-secret-access.mjs` — include `.mts` and `.cts` in the tracked source-extension classifier.

## Interfaces / signatures

- No public function, API route, queue, database, or loader signature changes.
- Internal classifier contract: `SOURCE_EXTENSION` must match `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.py` source paths, case-insensitively.
- Checker CLI contract remains `node scripts/check-secret-access.mjs`, with exit code `1` and sanitized `path:line` diagnostics for forbidden reads.

## Approach

- Add a fixture-repository test containing forbidden direct environment reads in tracked `.mts` and `.cts` files and assert a non-zero exit plus both sanitized file locations.
- Run the focused checker suite to capture the required leading-red failure before implementation.
- Extend only `SOURCE_EXTENSION` with the two missing extensions.
- Re-run the focused checker suite, the live-tree secret check, and the repository's relevant lint/type checks.
- Request explicit Pair/human security or architecture sign-off before merge because the original ticket is Pair-owned and this guard is a security boundary.

## Acceptance criteria

- **AC-1 (GAP-3):** A tracked `.mts` file containing direct `process.env` access outside the exact loader allowlist makes `node scripts/check-secret-access.mjs` exit non-zero and report the file and line without revealing the accessed secret name.
- **AC-2 (GAP-3):** A tracked `.cts` file containing direct `process.env` access outside the exact loader allowlist makes `node scripts/check-secret-access.mjs` exit non-zero and report the file and line without revealing the accessed secret name.
- **AC-3 (GAP-3):** The committed CI secret-access command and its complete regression suite pass after the classifier change, proving existing covered source types and allowlist behavior remain intact.

## Edge cases

- **EC-1 (GAP-3):** Extension matching is case-insensitive, consistent with the existing classifier contract.
- **EC-2 (GAP-3):** A similarly named non-source extension such as `.mts.txt` remains outside the executable-source scan.
- **EC-3 (GAP-3):** Adding `.mts` and `.cts` does not broaden the exact loader allowlist; a new file such as `packages/config/src/secrets.mts` is still treated as outside the loader.
- **EC-4 (GAP-3):** Failure output identifies only the offending path and line and does not echo the environment key or source line.

## Open questions

- None. The change is intentionally limited to the two executable TypeScript extensions omitted by the existing classifier.

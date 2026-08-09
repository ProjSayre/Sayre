# PL-13 — Secret-access gate: clear the four boundary violations on fix/pl-04-pipeline-defects

Lane: `/inline-edit` (`.sdd/pipeline.md`'s `### /inline-edit <ticket>` section). This is STOP A. There
is no `dev` stage: the session makes the edit itself at STOP B, bounded by **Affected files** below,
then authors `changes.md`/`changes.json` and runs `tester` → `review` → `security` in full.

Ticket lane (the `.sdd/bounds.yml` path lane from the issue form): **none declared** — this ticket was
not filed through `.github/ISSUE_TEMPLATE/pipeline-ticket.yml`. Recorded as `null` in `spec.json`, not
guessed.

## Ticket Check

- **What I'm about to build** — CI on PR #83 is refusing the branch because four lines read
  environment variables directly, which this repo only allows in a few named files. Two of those
  lines get rewritten to ask the shared settings helper instead; the remaining one is a test that has
  to read the environment to do its job, so that one file gets added to the short list of approved
  exceptions, with a written reason.
- **What I'm explicitly not doing** — not weakening or turning off the check, not exempting whole
  folders, not touching the product's settings list, not changing what the red-team browser tool or
  the guard test actually does.
- **How you'll know it worked** — the "Secret-access boundary" step on PR #83 goes green, and the
  browser red-team tool still opens a browser on your machine the same way it did before.
- **What I had to guess** — the ticket suggested exempting *both* files. I only exempted one. The
  other (the browser tool) reads an ordinary, non-secret setting, and this repo already has a script
  doing that exact job through the shared helper, so exempting it would have been the wrong shape.
  That is the one judgment call worth your attention.

## Goal

Make `npm run check:secret-access` exit `0` on `fix/pl-04-pipeline-defects`, resolving each of the
four violations at its own source rather than by widening the gate: the red-team driver's three
lines go through the central config loader (and `os.homedir()`), and the read-only guard's test — the
one file where reading the raw environment *is* the behavior under test — gets a single, commented
ALLOWLIST entry.

## Scope

**In:** the two files listed below.
**Out:** any change to the gate's detection patterns, `EXCLUDED_SEGMENT`, `SOURCE_EXTENSION`, or its
built-ins-only property; `packages/config`'s `CONFIG_NAMES`; `scripts/guard-checker-readonly.test.mjs`
itself (its behavior is deliberately unchanged); `scripts/check-secret-access.test.mjs`;
`.github/workflows/ci.yml`; `docs/PRD_Tickets.md` (explicitly not edited).

## Affected files

1. `scripts/check-secret-access.mjs` — **modified.** Exactly one new `ALLOWLIST` entry
   (`'scripts/guard-checker-readonly.test.mjs'`) plus a justifying comment above it. Nothing else in
   this file changes.
2. `apps/web/.claude/skills/redteam-ux/driver.mjs` — **modified.** `findChrome()` stops reading
   `process.env` (lines 40, 41, 46); the header's `Env:` line (line 29) is updated to name the
   variable it actually reads now.

Also written, as every run does: `.pipeline/spec.md`, `.pipeline/spec.json`, and at STOP B
`.pipeline/changes.md`/`.pipeline/changes.json`.

## Interfaces / signatures

In `scripts/check-secret-access.mjs`, the set literal at the top gains one member; the loop at the
bottom (`ALLOWLIST.has(file)`) is untouched:

```js
const ALLOWLIST = new Set([
  'packages/config/src/config.ts',
  'packages/config/src/secrets.ts',
  'services/workers/sayre_workers/config/config.py',
  'services/workers/sayre_workers/config/secrets.py',
  // Reads the parent environment only to hand it to a child process:
  // `spawnSync(node, [GUARD], { env: { ...process.env, ...env } })`. That spread IS the
  // behavior under test — the [C4-mirror] cases reproduce a real finding by pointing
  // TMP/TEMP/TMPDIR at a path inside the checkout for the spawned guard (whose OS_TMP_ROOT
  // resolves from them at its own module-load time) while leaving PATH/SystemRoot intact so
  // the spawn still works. No secret-class value is read. Same shape as the org-secret gate's
  // jiraConnectionStore.rls.test.ts entry: a test whose assertion is only meaningful if it
  // bypasses the abstraction.
  'scripts/guard-checker-readonly.test.mjs',
]);
```

In `apps/web/.claude/skills/redteam-ux/driver.mjs`:

- `function optionalConfig(name: ConfigName): string | undefined` — a local wrapper over
  `getOptionalConfig` from `@sayre/config` that returns `undefined` on a `ConfigError` and rethrows
  anything else. Same shape as `scripts/render-anime-hero.mjs`'s existing `optionalConfig()`.
- `function findChrome(): string` — unchanged signature and unchanged fallthrough behavior:
  - override: `optionalConfig('PUPPETEER_EXECUTABLE_PATH')`, used only when it `existsSync`;
  - the per-user Windows candidate becomes
    `join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')`;
  - the not-found message names `PUPPETEER_EXECUTABLE_PATH`.
- New imports: `homedir` from `node:os`; `{ ConfigError, getOptionalConfig }` from `@sayre/config`.
  `PUPPETEER_EXECUTABLE_PATH` is already in `packages/config`'s `CONFIG_NAMES` (line 19), so no
  registry change is required.

## Approach

1. Edit `driver.mjs` first (it is the falsifiable half — see Open questions): add the two imports and
   the `optionalConfig` wrapper, rewrite `findChrome()`'s override and per-user-Chrome candidate,
   update the header `Env:` line and the not-found message.
2. Verify the driver still resolves a browser on this machine before touching anything else.
3. Add the single commented `ALLOWLIST` entry to `scripts/check-secret-access.mjs`.
4. Run `npm run check:secret-access`, `npm run test:secret-access`, `npm run test:readonly-guard`.

### Decision, and what was rejected

**Split verdict, deliberately** — the ticket proposed allowlisting both files; only one is
allowlisted. The precedent is that a file joins a gate's ALLOWLIST when the raw access *is the point
of that file* (`jiraConnectionStore.rls.test.ts` on the org-secret gate). That is true of the guard
test and false of the driver: locating a Chromium binary is ordinary optional config, and this repo
already does that exact job through the loader — `scripts/render-anime-hero.mjs` is a plain `.mjs`
that calls `getConfig('PUPPETEER_EXECUTABLE_PATH')`.

- **Allowlist `driver.mjs` too (the proposed approach) — rejected.** Its stated justification
  ("cannot import the TS workspace loader from a plain `.mjs` skill script") is not true here:
  `render-anime-hero.mjs` does exactly that, and `driver.mjs` already resolves a bare specifier
  (`puppeteer-core`, a root devDependency) from the same root `node_modules` where npm links
  `@sayre/config`. Recording a rationale we know to be false is the one thing that would actually
  corrode this precedent, since the comment is the whole mechanism keeping it honest. An ALLOWLIST
  entry is also whole-file and permanent, and this is a skill driver an agent edits routinely —
  the worst class of file to exempt forever.
- **Drop `CHROME_PATH` configurability entirely — rejected.** An override is genuinely needed when
  Chrome/Edge lives somewhere unusual, and it is the only recovery the driver's own error message can
  offer. The chosen route keeps an override, under the already-registered name.
- **Add `CHROME_PATH` / `LOCALAPPDATA` to `CONFIG_NAMES` — rejected as unnecessary.**
  `PUPPETEER_EXECUTABLE_PATH` already covers the override and `homedir()` removes the need for the
  second, so nothing is gained by pulling `packages/config/src/config.ts` (product code, with its own
  typecheck/test CI steps) into a CI-unblock ticket. Note the registry *would* be the right home if
  the driver ever needs a genuinely new name — `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR` are already
  in it, so OS-path variables are within its established scope.
- **Widen `EXCLUDED_SEGMENT` to skip `.claude/` wholesale — rejected.** It exempts every present and
  future agent-tooling script in the repo, in one edit, to fix three lines in one file — including
  files agents write unattended. Every existing member of that list (`node_modules`, `dist`, `build`,
  `vendor`, `generated`, …) is *generated or vendored*; `.claude/` is hand-written source. It is also
  incoherent with the other half of this ticket: you cannot claim agent tooling is out of the gate's
  scope while allowlisting one agent-tooling file for a narrower reason.
- **A per-line suppression comment (`// gate-ignore`) — rejected.** No such mechanism exists in this
  gate, and adding one is a larger change to the gate's semantics than this ticket warrants; per-line
  suppressions are also the classic way a gate erodes without anyone deciding to erode it.

## Acceptance criteria

- **AC-1** — `npm run check:secret-access` exits `0` against the working tree on this branch and
  prints `Secret-access gate passed.`
- **AC-2** — Each of the four reported violations is resolved by its stated mechanism:
  `apps/web/.claude/skills/redteam-ux/driver.mjs` contains no `process.env` access at all (the former
  lines 40, 41, 46), and `scripts/guard-checker-readonly.test.mjs` line 233 is **unchanged** —
  exempted only by the ALLOWLIST entry.
- **AC-3** — `scripts/check-secret-access.mjs`'s `ALLOWLIST` grows by exactly one entry; no other
  file becomes exempt. `EXCLUDED_SEGMENT`, `SOURCE_EXTENSION`, `DIRECT_FORBIDDEN`, and every other
  detection pattern in that file are unchanged, and the file still imports only Node built-ins (the
  CI step runs before `npm ci`).
- **AC-4** — The new ALLOWLIST entry carries a comment naming what that file legitimately reads
  (the parent environment, spread into a spawned child so the guard's module-load `os.tmpdir()`
  resolves TMP/TEMP/TMPDIR under test control), stating that no secret-class value is read, and
  citing the precedent it follows.
- **AC-5** — `npm run test:secret-access` and `npm run test:readonly-guard` both pass.
- **AC-6** — The driver still works: `node --check` passes on it; with nothing set, `findChrome()`
  returns an existing Chrome/Edge executable on this machine; with `PUPPETEER_EXECUTABLE_PATH`
  pointing at an existing file, that path wins. Its header `Env:` line and its not-found message both
  name `PUPPETEER_EXECUTABLE_PATH`.
- **AC-7** — Nothing outside the two Affected files is modified — in particular
  `packages/config/src/config.ts`, `scripts/check-secret-access.test.mjs`,
  `scripts/guard-checker-readonly.test.mjs`, `.github/workflows/ci.yml`, and `docs/PRD_Tickets.md`.

## Edge cases

- **EC-1** — `PUPPETEER_EXECUTABLE_PATH` set to an empty or whitespace-only value:
  `getOptionalConfig` throws `ConfigError` (`validateValue`'s empty check), where the old
  `process.env.CHROME_PATH && …` was merely falsy. The wrapper must swallow `ConfigError` and fall
  through to the candidate list — never crash the driver.
- **EC-2** — `PUPPETEER_EXECUTABLE_PATH` set to a path that does not exist: unchanged behavior — fall
  through to the candidate list, and if nothing matches, exit `1` with the not-found message naming
  the variable that actually works now.
- **EC-3** — Non-Windows host: the `homedir()`-derived candidate simply fails `existsSync` and is
  skipped, exactly as today's `join('', 'Google\\Chrome\\…')` relative path does. No crash, no
  behavior change on Linux/macOS.
- **EC-4** — `@sayre/config` does not resolve from `apps/web/.claude/skills/redteam-ux/`, or
  `packages/config/dist/index.js` is absent and an ordinary `npm install` does not produce it: the
  loader route is genuinely unavailable to this file. **Fallback:** revert step 1, add
  `apps/web/.claude/skills/redteam-ux/driver.mjs` to the ALLOWLIST with a comment recording the *true*
  reason (loader not resolvable from this location; reads a browser path and a Windows profile path,
  no secret-class value), and record the deviation in `changes.md`. Do not leave a half-applied edit,
  and do not write the "cannot import from .mjs" rationale unless it has actually been verified.
- **EC-5 (accepted residual)** — An ALLOWLIST entry is whole-file and permanent: a later edit to
  `scripts/guard-checker-readonly.test.mjs` could read a genuinely secret-class value from
  `process.env` and this gate would stay silent. Accepted, with these mitigants stated rather than
  claimed away: (a) the justifying comment names the one access that is sanctioned, so a diff adding
  a second one is visibly outside it at review; (b) the file is a test for the read-only guard, has
  no production import path, and runs in CI where no real credential is provisioned; (c) the sibling
  `check-org-secret-access.mjs` gate still covers that file for the Jira raw-column class. Nothing
  mechanically narrows an ALLOWLIST entry to a line or a variable name today.
- **EC-6** — The new comment must not itself trip the gate. `javascriptLexicalView` blanks `//`
  comments before matching, so a comment spelling out the forbidden form is safe — but the gate scans
  its own file, so AC-1's actual run is the proof, not this reasoning.
- **EC-7** — `scripts/check-secret-access.test.mjs`'s `allows only the four exact loader paths` test
  builds fixture repos and never asserts the ALLOWLIST's size, so a fifth entry cannot break it. Its
  name stays accurate about what it tests — the gate does still allow exactly those four *loader*
  paths; the new entry is not a loader. Renaming it is out of scope.
- **EC-8** — The gate runs before `npm ci` in CI. `check-secret-access.mjs` must stay built-ins-only
  (this change adds no import to it), and the driver's new `@sayre/config` import is irrelevant to
  that step, which never executes the driver.

## Open questions

None blocking. One precondition could not be checked here (this planner had no shell): whether
`import { getOptionalConfig } from '@sayre/config'` resolves from the driver's directory in an
installed checkout. It is decidable with one command at STOP B, the evidence points strongly to yes
(`scripts/render-anime-hero.mjs` already imports it from a plain `.mjs`; `packages/config/dist/` is
present on disk; `packages/config` is a declared workspace), and EC-4 defines the fallback if it is
no. Verify before proceeding past step 2 of Approach.

**Coordinator note:** this planner has no Bash. Run `node scripts/write-stamp.mjs .pipeline/spec.json`
before making the STOP B edit — `spec.json` is currently unstamped, and `/inline-edit` STOP A requires
a stamped sidecar before anything may be edited.

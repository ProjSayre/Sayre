# Audit 15 — Secrets & Supply Chain (Sayre)

Repo root: `C:\Users\splat\OneDrive\Desktop\Sayre`
Branch audited: `planning/future-tickets` (HEAD `b8dc223`), 242 commits, 788 tracked files.
Date: 2026-07-31

---

## VERDICT

**ARE THERE REAL SECRETS IN THE REPO OR ITS HISTORY?**

- **In git history / tracked files: NO.** Clean. 242-commit full-content scan found zero real credentials. Every hit was a test fixture or a regex literal in a leak-guard test.
- **In the repo working directory: YES — 13 real, live, rotatable secrets in ONE file.**

The file is `C:\Users\splat\OneDrive\Desktop\Sayre\infra\New Text Document.txt` — a **byte-identical copy of `infra/.env`** (verified: identical MD5 `120176f8...`). It contains the full populated local environment including real Anthropic and OpenAI API keys, a GitHub App RSA private key, the GitHub webhook secret, the Jira OAuth client secret, and the JWT signing key.

It is currently hidden only by an **UNCOMMITTED** `.gitignore` change. On `main` — i.e. for CI, for a fresh clone, and for anyone who runs `git checkout .gitignore` — **this file is NOT ignored** and would be swept into the next `git add -A`.

Confidence: **certain**. Confirmed by `git check-ignore -v` (matches working-tree rule `.gitignore:21 infra/*`) and by `git show HEAD:.gitignore | grep infra` returning nothing.

---

## CRITICAL

### C-1 — 13 live secrets in an un-ignorable working-tree file

**File: `C:\Users\splat\OneDrive\Desktop\Sayre\infra\New Text Document.txt`** (112 lines)

Values redacted below — no rendered value, masked or otherwise, carries any character of the real
secret. Every one of these needs rotation — treat as exposed, because this path is inside a
**OneDrive-synced folder** and has therefore already left the machine to Microsoft cloud storage
regardless of git.

| Secret | Category |
|---|---|
| `ANTHROPIC_API_KEY` | Provider API key |
| `OPENAI_API_KEY` | Provider API key |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM block |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth client secret |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook signature secret |
| `JIRA_OAUTH_CLIENT_SECRET` | Jira OAuth client secret |
| `JIRA_TOKEN_ENC_KEY` | AES-256-GCM key protecting every org's Jira tokens at rest |
| `JWT_SIGNING_KEY` | Signs session tokens AND GitHub install-state tokens |
| `MCP_TOKEN_PEPPER` | HMAC pepper for all MCP agent keys |
| `POSTGRES_PASSWORD` | Database password |
| `DATABASE_ADMIN_URL` | Connection string (embeds admin password) |
| `DATABASE_RUNTIME_URL` | Connection string (embeds runtime password) |
| `NEO4J_PASSWORD` / `NEO4J_AUTH` | Graph database credential (reused human-chosen password) |

**PL-15 redaction note (round 3, final):** this table originally carried, per row, the exact
`infra/New Text Document.txt` line number, an explicit REAL/live confidence tag, and a truncated
rendering of each value that still carried real leading and/or trailing characters of the actual
secret. The first two were removed in an earlier round; this round removes the truncated-value column
entirely, because a truncated value is still real secret material — any characters of an actual live
credential are a durable disclosure once committed to git history, regardless of how few. Every value
above WAS confirmed real and live as of the 2026-07-31 audit date
(see the file-level verdict above and the Remediation below, both unchanged); the exact per-secret
line numbers, liveness confirmations, and values remain on file only in the auditor's untracked
working copy, not in this tracked report.

Not real (placeholders, no action — the literal placeholder strings below are not secrets, so they are
not redacted): `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` = `test`/`test` (LocalStack);
`LINEAR_OAUTH_CLIENT_SECRET`/`LINEAR_ACCESS_TOKEN`/`LINEAR_REFRESH_TOKEN` = local placeholder values.

**Two distinct blast radii worth separating:**
- `JIRA_TOKEN_ENC_KEY` and `MCP_TOKEN_PEPPER` are not just credentials — they are the *key material protecting other tenants' credentials*. `JIRA_TOKEN_ENC_KEY` decrypts every row in `jira_connections`; `MCP_TOKEN_PEPPER` is the pepper behind every issued MCP agent key digest. Rotating these has a documented re-encrypt/reissue procedure in `SECRETS.md` — it is not a drop-in swap.
- `JWT_SIGNING_KEY` compromise means arbitrary session forgery against `authenticate()` / `authService.resolveSessionContext`, which is the gate in front of every tenant-scoped service call.

**Remediation:**
1. Delete `infra/New Text Document.txt`. Purge it from OneDrive's version history too — deleting the local file does not remove OneDrive's retained versions.
2. Rotate all 13 per the owner/procedure column in `SECRETS.md`.
3. **Commit the `.gitignore` change.** It is the only thing standing between this class of file and a public repo, and it is currently uncommitted.

### C-2 — the `.gitignore` hardening is uncommitted

`git diff .gitignore` shows an `infra/*` allowlist added in the working tree only. Its own commit message-style comment is the tell:

> `# infra/ is allowlisted, not denylisted: secret-bearing scratch files there have`
> `# repeatedly been named things no pattern above matches (e.g. a stray .txt).`

This is a correct fix and it should land. Until it does, `main`'s ignore rules cover only `.env`, `.env.*`, `*.pem`, `*.key` — none of which catch `New Text Document.txt`, `creds.txt`, `env backup.md`, or a pasted `.json`.

Note the allowlist also drops `infra/Dockerfile` (committed historically, absent from HEAD and from the allowlist). If it is ever restored it will need an explicit `!infra/Dockerfile` line.

---

## Clean results (verified, not assumed)

These were checked and came back genuinely clean — worth recording so the next audit doesn't redo them.

**Git history (all 242 commits, full content):** scanned for `sk-`, `sk-proj-`, `ghp_`, `gho_`, `ghs_`, `github_pat_`, `AKIA`, `xox[baprs]-`, `glpat-`, `AIza`, and `-----BEGIN ... PRIVATE KEY-----`. **Zero real secrets.** Only two files matched, in every commit, both benign:
- `apps/web/app/settings/providers/providerSettingsClient.test.ts:62` — a regex *asserting* those patterns never appear in a UI response.
- `services/core/src/services/providerSettingsService.test.ts:328` — the literal `'sk-proj-secret-looking-value'` used as a negative fixture.

**Files ever added in history matching `.env|secret|credential|.pem|.key`:** only source files (`packages/config/src/secrets.ts`, `scripts/check-secret-access.mjs`, `services/workers/sayre_workers/config/secrets.py`, `SECRETS.md`, `infra/.env.example`). No `.env`, no `.pem`, no `.key` was ever committed. `infra/.env` has never appeared in history (`git log --all -- infra/.env` is empty).

**Tracked `*.env*` files:** exactly one — `infra/.env.example`. Read in full; every secret slot is a `<placeholder>`. Non-secret defaults (`POSTGRES_USER=sayre_dev`, `REDIS_PORT=6379`, LocalStack endpoints) are correctly left concrete. **Policy-compliant.**

**Connection strings with embedded credentials:** 13 hits, all benign —
- `.github/workflows/ci.yml:89,104,109,174,209,210` — `postgresql://sayre_dev:changeme_local_only@localhost:5432/sayre_dev`, an ephemeral CI service container. Placeholder, not a secret.
- `services/core/src/security/assert*.test.ts` and `services/workers/tests/test_db_session.py:43` — `fake-user:fake-pass@fake-host`. Test fixtures.
- `services/workers/tests/test_graph_migrations.py:453,489` and `test_worker_entrypoints.py:61` — sentinels (`W0_07_DSN_SENTINEL`, `do-not-print`) that exist specifically to assert DSNs are never printed. Good practice.

**Hardcoded credential literals:** 20 hits, all in `services/core/src/github/appClient.test.ts` and `oauthClient.test.ts`, all obviously fake (`ghs_faketoken`, `gho_faketoken`, and the deliberately-named `ghs_secret_should_not_leak` / `gho_secret_should_not_leak` used to prove tokens don't reach logs). Test fixtures.

**Build output:** `dist/` and `public/` scanned. No secrets. Extracted URLs are all public/marketing (`trysayre.com`, Google Fonts, a Google Forms waitlist endpoint, W3C namespace URIs). No internal hostnames, no API endpoints, no `.map` files leaking source paths.

**High-entropy sweep** over all tracked non-lock, non-markdown files for 40+ char base64/hex runs: nothing but ASCII-art separators, CSS pseudo-elements, and API route strings.

**Secret logging:** no violations found.
- No `throw new Error()` interpolates a token, key, password, DSN, or credential anywhere in the TS tree.
- Node logging is disciplined: `console.error('[gateway] ...', err)` sites pass the caught error, but the paired code paths construct typed errors (`CoreUnauthorizedError`, `CoreUnavailableError`) rather than echoing responses. `services/gateway/src/fanout/fanout.ts:83` logs an explicit `{repoId, connectionId}` object rather than the whole payload — correct.
- Python `logger.*` calls in `messaging/sqs_client.py` and `graph_migrations/runner.py` use `%r` on queue/consumer names only.
- Redaction exists where it matters: `services/core/src/services/providerSettingsService.ts:163` (`redactedCredential`) and `:174` (`redactedEndpoint`), and the API contract enforces it at `packages/shared-types/src/index.ts:19`.
- One PII (not credential) note: `src/shared/WaitlistForm.tsx:76` does `console.info("[sayre] waitlist payload (no endpoint configured):", payload)` — logs a submitted email to the browser console when no endpoint is set. Low severity, marketing site only.

---

## HIGH

### H-1 — the secret-access CI gate is currently RED, on `main`

`.github/workflows/ci.yml:43-46` runs `check:secret-access` as the **first** step of the build. Run locally against HEAD:

```
$ node scripts/check-secret-access.mjs ; echo "EXIT=$?"
Direct environment access is restricted to the central loaders:
  services/core/src/db/jiraConnectionStore.rls.test.ts:92
  services/core/src/db/jiraConnectionStore.rls.test.ts:93
  services/core/src/integrations/tickets/jira/orgSecrets.ts:69
  services/core/src/integrations/tickets/pollWorker.ts:9
EXIT=1

$ node scripts/check-org-secret-access.mjs ; echo "EXIT=$?"
Jira OAuth token columns may only be referenced from the allowlisted store/loader/schema files:
  services/core/src/db/jiraConnectionStore.rls.test.ts:142,146,147,148,253,258,259,358,363,364
EXIT=1
```

Three of these four violations are **already on `main`** (confirmed via `git grep process.env main -- services/core/src/...`), so this is not a branch-local regression — the gate has been failing on the mainline and the merges landed anyway. Either CI is not blocking merges, or the guard was added to `package.json` without being wired to a required check. **Worth confirming branch protection settings**, because a green-looking guard that doesn't block is worse than no guard: it produces false confidence in exactly the control that would have caught C-1's class of mistake.

The violations themselves are individually benign — they are the intended-exception cases the allowlist was never updated for:
- `services/core/src/integrations/tickets/jira/orgSecrets.ts:69` — `if (process.env.NODE_ENV !== 'test')`, guarding test-only dependency injection helpers. Environment *detection*, not secret reading.
- `services/core/src/integrations/tickets/pollWorker.ts:9` — `Number(process.env.JIRA_POLL_INTERVAL_MS ?? 60_000)`. Non-secret tuning value, but it does bypass `@sayre/config`; this one should move to the config loader on principle.
- `services/core/src/db/jiraConnectionStore.rls.test.ts:92-93` — test setup seeding `JIRA_TOKEN_ENC_KEY`.

Fix is small: either add a narrow allowlist/pragma mechanism to `scripts/check-secret-access.mjs` (it has none today — `ALLOWLIST` is a flat 4-entry file set at line 6, with no per-line escape), or route `JIRA_POLL_INTERVAL_MS` through `@sayre/config` and allowlist the two `NODE_ENV` guards. Do not fix it by deleting the check.

### H-2 — `drizzle-orm` SQL injection, unpatchable under the current pin

`npm audit --omit=dev` — HIGH, direct dependency.

- Advisory: *Drizzle ORM has SQL injection via improperly escaped SQL identifiers*
- Vulnerable: `<0.45.2`. Installed: **0.38.4**. Pin: `"drizzle-orm": "0.38.x"` (`services/core/package.json`).
- `fixAvailable: {"name":"drizzle-orm","version":"0.45.2","isSemVerMajor":true}`

This is the highest-impact production advisory in the tree. Drizzle sits directly in front of the Postgres system-of-record that holds org/user/permission rows and enforces RLS — the exact layer where an identifier-escaping bug converts into cross-tenant data access. `docs/architecture-assessment-2026-07.md` and `.claude/rules/security-multitenancy.md` both treat tenant isolation as structural; this advisory undercuts that assumption at the driver level. Prioritise the upgrade and re-run the RLS acceptance suite (`npm --prefix services/core run test:rls:acceptance:ci`) against it.

### H-3 — `.x` minor pinning structurally blocks security patches

This is the root cause behind most of the audit output, and it's worth naming as a policy issue rather than 15 separate tickets. `DEPENDENCIES.md` states the policy explicitly: *"each manifest below pins to a minor line."* The consequence is that npm cannot apply a fix that ships in a later minor. `npm audit` says so in as many words — *"Will install express@4.22.2, which is outside the stated dependency range."*

Production packages currently stuck behind their own pin:

| Package | Pinned | Installed | Fix needs | Severity |
|---|---|---|---|---|
| `drizzle-orm` | `0.38.x` | 0.38.4 | 0.45.2 (major) | HIGH |
| `express` | `4.21.x` | 4.21.2 | 4.22.2 (minor) | HIGH |
| `ws` | `8.18.x` | 8.18.3 | 8.21.1 (minor) | HIGH |
| `next` | `14.2.x` | 14.2.35 | 16.2.12 (major) | HIGH |
| `bullmq` | `5.28.x` | — | 5.81.3 (minor) | moderate |
| `@modelcontextprotocol/sdk` | `1.29.x` | — | 1.30.0 (minor) | moderate |

The `express`, `ws`, `bullmq`, and MCP-SDK fixes are all **non-major** — `isSemVerMajor: false`. They are blocked purely by the `.x` convention, not by any real compatibility risk. Relaxing those four pins to `^` (or bumping the minor) clears 4 of 7 production highs/moderates with essentially no upgrade risk. That is the cheapest security win available in this audit.

`next` at `14.2.x` carries **21 distinct advisories** in one package — cache poisoning of RSC responses, SSRF in rewrites and Server Actions, middleware/proxy bypass in Pages Router i18n, XSS with CSP nonces, unauthenticated disclosure of internal Server Function endpoints, and several DoS vectors. The fix is Next 16 (major). This one is genuinely a project, not a version bump, but it should be scheduled rather than deferred indefinitely — several of those are exploitable against a public deployment without credentials.

---

## MEDIUM

### M-1 — npm audit results

Real command output, run from repo root:

```
$ npm audit --omit=dev
15 vulnerabilities (8 moderate, 7 high)

$ npm audit
43 vulnerabilities (15 moderate, 27 high, 1 critical)
```

**Production (`--omit=dev`) — 0 critical, 7 high, 8 moderate:**

| Sev | Package | Advisory | Direct |
|---|---|---|---|
| HIGH | `drizzle-orm` | SQL injection via improperly escaped SQL identifiers | yes |
| HIGH | `express` | (chain: `body-parser`, `qs`, `path-to-regexp`) | yes |
| HIGH | `next` | 21 advisories — SSRF, cache poisoning, XSS, DoS, middleware bypass | yes |
| HIGH | `ws` | Uninitialized memory disclosure; memory-exhaustion DoS | yes |
| HIGH | `path-to-regexp` | ReDoS via multiple route parameters | via express |
| HIGH | `postcss` | XSS via unescaped `</style>`; path traversal + arbitrary `.map` read via `sourceMappingURL` | via next |
| HIGH | `fast-uri` | Host confusion via literal backslash authority delimiter | transitive |
| mod | `@modelcontextprotocol/sdk`, `@hono/node-server` | — | yes |
| mod | `body-parser`, `qs` | — | via express |
| mod | `bullmq` → `uuid` | uuid: missing buffer bounds check in v3/v5/v6 | yes |
| mod | `react-router`, `react-router-dom` | Open redirect via backslash in `<Link>`/`useNavigate` (CVE-2025-68470 bypass); arbitrary constructor injection in `deserializeErrors()` SSR hydration | root site |

**The 1 CRITICAL is dev-only:** `vitest <=3.2.5` — *"When Vitest UI server is listening, arbitrary file can be read and executed."* Not shipped to production, and only exploitable with the UI server running, but it is reachable on a developer machine and in CI. Bump `vitest` (pinned `2.1.x` across four workspaces).

The remaining 20 dev-only highs are the ESLint 8 dependency chain (`eslint`, `@typescript-eslint/*`, `eslint-config-next`, `eslint-plugin-*`, `minimatch`, `glob`, `brace-expansion`, `flat-cache`, `file-entry-cache`, `rimraf`) plus `vite <=6.4.2`. **ESLint 8.57 is end-of-life** and will not receive fixes — the whole chain resolves by migrating to ESLint 9 flat config. Low urgency (lint tooling isn't attacker-reachable), but it is a permanent, growing debt that will never shrink on its own.

### M-2 — `graphifyy`: legitimate, but an outsized production supply-chain surface

`services/workers/pyproject.toml:12` pins `graphifyy==0.9.16` (exact, hash-locked in `poetry.lock:470-478`). **Not a typosquat** — the double-`y` distribution name is deliberate and well-documented (`docs/wave0-foundation-contracts.md:15`, `DEPENDENCIES.md:139`, `docs/product/Ticket-Backlog-by-Feature-2.md:27`), and there is a dedicated isolation test (`services/workers/tests/test_enrichment_vendor_isolation.py`) that fails the build if anything imports `graphifyy` instead of its real module name `graphify`. That is genuinely good hygiene.

Two things still warrant flagging:

1. **Name-confusion exposure.** Distribution `graphifyy` → import `graphify`. If anyone ever publishes a PyPI distribution literally named `graphify`, it would provide the same import name, and an environment that acquired both would resolve unpredictably. The pin plus `poetry.lock` hashes protect the current install; a `pip install graphify` typo by a developer would not be protected. Cheap mitigation: document the import-name/dist-name split at the install boundary, not only in tests.

2. **Transitive fan-out.** `graphifyy` pulls `networkx`, `numpy`, `rapidfuzz`, and **~25 `tree-sitter-*` grammar packages** into the production dependency set. Its own PyPI description reads *"AI coding assistant skill (Claude Code, CodeBuddy, Codex, ...)"* — i.e. it is packaged as a developer-tool skill, not as a hardened server library. It is used narrowly and correctly (`services/workers/sayre_workers/enrichment/graphify_adapter.py:15` imports exactly one symbol, `build_from_json`), so the isolation is sound. But a single narrow call is paying for ~28 transitive packages of production attack surface. Worth periodically re-evaluating whether that one function justifies the tree.

### M-3 — `tree-sitter-language-pack = "0.*"` is effectively unpinned

`services/workers/pyproject.toml:11`. Every other Python dependency pins to a minor (`fastapi==0.115.*`, `neo4j==5.24.*`, `httpx==0.27.*`) or an exact version. This one accepts **any** `0.x` release. For a pre-1.0 package that is the entire version space — a future `0.99.0` with arbitrary changes satisfies the constraint.

`poetry.lock` currently freezes it to `0.9.1`, so today's installs are deterministic and this is not an active exposure. It becomes one the moment anyone runs `poetry update`. Tighten to `0.9.*` to match the convention used everywhere else in the file.

Otherwise the Python manifest is in good shape: `poetry.lock` is committed (392 KB, with per-artifact SHA-256 hashes), `requires-python = ">=3.12,<3.13"` is bounded, dev tooling (`pytest`, `ruff`, `mypy`) is correctly isolated in `[tool.poetry.group.dev.dependencies]`, and nothing in the manifest is abandoned or unnecessary.

### M-4 — `DEPENDENCIES.md` drift

Accurate for what it covers, and the exclusions are honestly declared (it states up front that the root Vite marketing site is out of scope). Three `apps/web` packages exist in `package.json` but are absent from the doc:

- `@sigma/node-border` (dependency)
- `react-test-renderer` (devDependency)
- `@types/react-test-renderer` (devDependency)

Spot-checked as present and correctly described: `@sayre/config`, `zod`, `@opentelemetry/api`, `jsonwebtoken`, `@modelcontextprotocol/sdk`, `ws`, `express`, `drizzle-orm`.

Note the doc's scope exclusion has a security consequence, even though the exclusion itself is legitimate: the root `package.json` carries `react-router-dom ^6.30.0`, which is the source of the open-redirect and constructor-injection moderates in M-1. An undocumented dependency is one nobody owns the patching of. Either bring the root site into the inventory or state explicitly who owns its updates.

---

## LOW

### L-1 — version drift across workspaces

- `typescript`: root `~5.6.3` vs `5.5.x` in all five workspaces. Two compiler versions in one monorepo.
- `react`: root `^18.3.1` (floating) vs `apps/web` `18.3.1` (exact). Separate installs, so no runtime conflict, but the root site can silently drift onto a different React minor than the product client.
- `express`: both `4.21.2` and `5.2.1` are resolved in the tree (5.x arrives transitively via `@modelcontextprotocol/sdk`). Two major versions of the same HTTP framework in one `node_modules` is a maintenance and audit-noise hazard — advisories must now be triaged per-copy.

### L-2 — `dependencies` vs `devDependencies` placement

Checked all seven manifests. **No misplacements.** Root correctly keeps `@resvg/resvg-js`, `puppeteer-core`, `turbo`, `vite` in `devDependencies`. `services/core` and `services/gateway` correctly separate `tsx`/`vitest`/`@types/*` from runtime deps. `packages/config` and `packages/shared-types` have zero runtime dependencies, which is right for shared contract packages.

---

## What's actually working

Worth stating plainly, because it changes how C-1 should be read: **the secrets architecture is good — the failure is operational, not architectural.** That matches the pattern already recorded in `docs/architecture-assessment-2026-07.md` ("ops lag engineering").

- `packages/config/src/secrets.ts` defines a closed `SECRET_NAMES` catalog (21 entries) that exactly matches `SECRETS.md`, with typed rejection errors (`InvalidSecretReferenceError`, `UnsupportedSecretSchemeError`, `UnauthorizedSecretReferenceError`) for anything off-catalog. Mirrored in `services/workers/sayre_workers/config/secrets.py`. One loader per language, as the policy requires.
- Only **8 files** in the entire tree touch `process.env`/`os.environ` at all, and the enforcement script (`scripts/check-secret-access.mjs`, ~1200 lines with a real JS/Python lexer to avoid false positives from strings and comments) is genuinely rigorous — it tracks `const p = process` aliasing and `from os import ...` rebinding.
- `SECRETS.md` is a real inventory: per-secret class, consumers, rotation owner, rotation procedure, and PM-07 KMS cutover plan. Kept current — the W3-10 Jira migration is reflected in both the table and the code comments at `packages/config/src/secrets.ts:16-24`.
- Leak-guard tests exist and are meaningful (`ghs_secret_should_not_leak` fixtures in `appClient.test.ts:582`, `oauthClient.test.ts:107`; DSN sentinels in `test_worker_entrypoints.py:61`).
- Credential redaction is implemented at the API boundary (`providerSettingsService.ts:163,174`) and typed into the shared contract.

The gap is entirely in enforcement reaching the machine: a `.gitignore` fix written but not committed, and a CI gate wired but not blocking. Both are one-commit fixes.

---

## Priority order

1. **Delete `infra/New Text Document.txt`; rotate all 13 secrets in C-1.** Purge OneDrive version history — the file has already synced to cloud storage.
2. **Commit the `.gitignore` `infra/*` allowlist.** Currently uncommitted; it is the only control preventing recurrence.
3. **Verify branch protection actually blocks on the "Secret-access boundary" job** (H-1), then fix the 4 violations. A non-blocking guard is a false-confidence generator.
4. **Bump `drizzle-orm` to ≥0.45.2** and re-run the RLS acceptance suite (H-2).
5. **Relax the `.x` pins on `express`, `ws`, `bullmq`, `@modelcontextprotocol/sdk`** — all non-major fixes, clears 4 production advisories cheaply (H-3).
6. **Bump `vitest`** (dev CRITICAL); schedule the Next 14→16 migration; plan the ESLint 8→9 move.
7. Tighten `tree-sitter-language-pack` to `0.9.*`; add the three missing `apps/web` packages to `DEPENDENCIES.md`; assign ownership for the root marketing site's dependencies.

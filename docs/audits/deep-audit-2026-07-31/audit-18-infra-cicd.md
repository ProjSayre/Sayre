# Audit 18 — Infrastructure, Deployment & Operations

Scope: `infra/`, `.github/workflows/`, `vercel.json`, `turbo.json`, `vite.config.ts`, `scripts/*.mjs`, `security-attacker-agents/`, Dockerfiles.

**Inventory result:** 1 compose file, 1 CI workflow, **0 Dockerfiles**, **0 .dockerignore**, 0 deploy workflows.

---

### [SEVERITY: CRITICAL] Redis runs with no authentication and is published on 0.0.0.0:6379
- **File:** `infra/docker-compose.yml:32-44`
- **Config:**
```yaml
  redis:
    image: redis:7.4-alpine
    container_name: sayre-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
```
  No `command:` override, no `requirepass`, no `REDIS_PASSWORD` env, no ACL file, no TLS. Corroborated by `infra/.env.example:47` where the variable is *commented out*: `# REDIS_PASSWORD=<redis-password-when-auth-is-enabled>`, and by `services/core/src/queue/bullmq.ts:85-97` which treats a missing password as normal (`SecretNotFoundError` is swallowed) — docstring at `bullmq.ts:103` states "defaulting to localhost:6379 / no password".
- **Why it's wrong:** `"6379:6379"` with no host-IP prefix binds to `0.0.0.0`, and Docker's port publishing writes its own `DOCKER` iptables chain that is evaluated **before** `ufw`/`firewalld` rules on Linux — so a host firewall does not stop it. An unauthenticated Redis is a full remote-code-execution primitive (`CONFIG SET dir` + `CONFIG SET dbfilename` to write an SSH `authorized_keys` or a cron file; `MODULE LOAD` where modules are permitted). This Redis is not incidental: it is the BullMQ job store for the GitHub/Jira/Linear integration workers **and** the pub/sub bus the WebSocket gateway fans `graph.updated` out over (`services/gateway/src/server.ts` `createGraphUpdatedBus`). An attacker on the same LAN/coffee-shop Wi-Fi can read every queued integration job, inject forged `graph.updated` envelopes into the realtime fan-out, and get code execution on the host.
- **Fix:** Add `command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:?set REDIS_PASSWORD}"]`, uncomment `REDIS_PASSWORD` in `infra/.env.example` as a required (not optional) variable, bind as `"127.0.0.1:6379:6379"`, and change `bullmq.ts:85-90` to fail closed rather than swallow `SecretNotFoundError` outside `NODE_ENV=development`.

---

### [SEVERITY: HIGH] Every datastore port published on 0.0.0.0 — Postgres, Neo4j, LocalStack, Prometheus
- **File:** `infra/docker-compose.yml:22-23, 36-37, 52-54, 74-75, 91-92`
- **Config:**
```yaml
    ports:
      - "5432:5432"      # postgres (line 23)
      - "6379:6379"      # redis   (line 37)
      - "7474:7474"      # neo4j http (line 53)
      - "7687:7687"      # neo4j bolt (line 54)
      - "4566:4566"      # localstack (line 75)
      - "9090:9090"      # prometheus (line 92)
```
- **Why it's wrong:** Not one of the six is scoped to `127.0.0.1`. Postgres here is the *system of record for permissions* (CLAUDE.md) holding `organizations`, `permissions`, and the encrypted Jira OAuth token columns; Neo4j Bolt (7687) is unencrypted by default in this config and holds the whole tenant graph. Any machine that can route to the developer's host — including a compromised device on the same network, or the host itself if it ever gets a public IP — gets a direct login prompt against production-shaped data. The RLS/tenant-isolation work in `services/core` is enforced at the *application role* layer; a direct 5432 connection with the admin DSN bypasses it entirely (this is the exact "privileged-DSN trap" the repo's own `test_tenant_isolation.py` exists to test).
- **Fix:** Prefix every mapping with `127.0.0.1:` (e.g. `- "127.0.0.1:5432:5432"`). Nothing in this stack needs off-host reachability; Prometheus already reaches the worker via `extra_hosts` rather than a published port.

---

### [SEVERITY: HIGH] Three of the five security guardrail scripts never run automatically — anywhere
- **File:** `package.json:19-21` vs `.github/workflows/ci.yml:43-46`
- **Config:** Declared but never invoked by CI:
```json
    "check:security-audit-agents": "node scripts/validate-security-audit-agents.mjs",
    "check:security-audit-run": "node scripts/validate-security-audit-run.mjs",
    "test:security-audit-run": "node --test scripts/validate-security-audit-run.test.mjs",
```
  The only guardrail step in the workflow is:
```yaml
      - name: Secret-access boundary
        run: >-
          npm run check:secret-access && npm run test:secret-access &&
          npm run check:org-secret-access && npm run test:org-secret-access
```
  Full reference sweep for the three missing scripts returns only `.claude/agents/security-checker.md:81-84`, `security-attacker-agents/README.md:81`, and `package.json` itself. There is no hook, no pre-commit config, and no other workflow.
- **Why it's wrong:** `validate-security-audit-agents.mjs` is the integrity check for the entire adversarial-audit system — it asserts every attacker brief is registered, checklist IDs are unique and prefix-correct, the audit contract still contains the progress vocabulary, and (lines 96-106) that `.claude/agents/security-checker.md` still references the registry and both schemas. Its only trigger is an LLM subagent *choosing* to run it mid-pipeline. Delete a brief, rename a check prefix, or drop the registry reference out of `security-checker.md` and nothing fails — the audit system silently degrades and the `.pipeline/security-report.md` `PASS` still gets emitted. That is a guardrail that reports safety without verifying it.
- **Fix:** Append `npm run check:security-audit-agents && npm run test:security-audit-run` to the `Secret-access boundary` step (both are Node-core-only, so they respect the deliberate pre-`npm ci` boundary at `ci.yml:41-42`).

---

### [SEVERITY: HIGH] CLAUDE.md claims a hook enforces read-only reviewers; no hook exists
- **File:** `.claude/settings.json` (entire file, 47 bytes)
- **Config:**
```json
{
  "permissions": {
    "deny": []
  }
}
```
  CLAUDE.md states for stage 4 `review` and stage 5 `security-checker`: "**read-only, cannot edit code** (enforced by hook)". There is no `hooks` key here, no `.claude/hooks/` directory, and no `.claude/settings.local.json`. `scripts/validate-pipeline-only-write.sh` exists but is referenced by nothing (`grep -rl` returns only git index blobs).
- **Why it's wrong:** The pipeline's separation-of-duties guarantee — that the reviewer and the security checker cannot quietly patch the code they are grading — is documented as mechanically enforced and is in fact enforced by nothing but agent instruction text. An agent that decides to "just fix" a finding will succeed, and the resulting `PASS` verdict is self-graded.
- **Fix:** Either add a real `PreToolUse` hook on `Edit|Write|NotebookEdit` in `.claude/settings.json` (wiring in the already-written `scripts/validate-pipeline-only-write.sh`), or delete the "(enforced by hook)" claim from CLAUDE.md. Do not leave the claim standing unbacked.

---

### [SEVERITY: HIGH] Workflow declares no `permissions:` — GITHUB_TOKEN gets the repo default scope
- **File:** `.github/workflows/ci.yml:1-11` and `:111-117`
- **Config:**
```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  node:
    name: web + core (lint, typecheck, test)
    runs-on: ubuntu-latest
```
  No `permissions:` block at workflow level or on either job.
- **Why it's wrong:** With no explicit block the `GITHUB_TOKEN` inherits the repository/organization default. For repos created before the 2023 default change — or any org that has not flipped the setting — that default is read **and write** on `contents`, `packages`, `deployments`, `issues`, `pull-requests`. This job runs `npm ci` and `poetry install`, i.e. it executes arbitrary third-party install-lifecycle code from ~800 tracked files' worth of dependency tree, with a token that can push commits. One malicious transitive postinstall is a repo takeover. The good news: the trigger is `pull_request`, **not** `pull_request_target`, so fork PRs correctly run without secrets — that specific supply-chain hole is absent.
- **Fix:** Add at the top of the workflow:
```yaml
permissions:
  contents: read
```
  and grant anything extra per-job only where actually needed.

---

### [SEVERITY: HIGH] `vercel.json` sets no security headers at all
- **File:** `vercel.json:1-4` (entire file)
- **Config:**
```json
{
  "redirects": [{ "source": "/demo/:path*", "destination": "/", "permanent": false }],
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```
- **Why it's wrong:** No `headers` key means no `Content-Security-Policy`, no `Strict-Transport-Security`, no `X-Frame-Options`/`frame-ancestors`, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy`. The deployed site is framable — an attacker embeds it in an invisible iframe and clickjacks the waitlist/signup flow — and any XSS anywhere in the React bundle has zero script-source containment. Missing HSTS leaves a first-visit SSL-strip window. For a product described as "about to have external users" this is the cheapest gap on the list to close.
- **Fix:** Add a `headers` array covering `Content-Security-Policy` (start with `default-src 'self'` and a report-only rollout), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

---

### [SEVERITY: HIGH] Zero Dockerfiles for four deployable services
- **File:** repo-wide — `find . -iname "Dockerfile*" -not -path "*/node_modules/*"` returns nothing; `find . -name ".dockerignore"` returns nothing.
- **Config:** `infra/docker-compose.yml` defines only third-party datastore images (postgres, redis, neo4j, localstack, prometheus). `apps/web`, `services/core`, `services/gateway`, and `services/workers` have no container definition.
- **Why it's wrong:** The compose file is titled "Local datastore infra for the Codebase Visualizer product" and it is accurate — there is no build or run artifact for any first-party service. The marketing site deploys through Vercel's git integration; core, gateway, and the Python worker fleet have **no defined deployment path at all**. Nobody can reproduce a running Sayre backend from this repo, and there is no artifact to scan, sign, or pin. For an MVP heading toward external customers this is the single largest operational gap, and it is the reason the "running as root / secrets in build layers / missing .dockerignore" checks in this audit's brief have no findings — there is nothing to check.
- **Fix:** Add multi-stage Dockerfiles for `services/core`, `services/gateway`, `services/workers` with an explicit non-root `USER`, plus a root `.dockerignore` that excludes `.git`, `node_modules`, `infra/.env`, `*.pem`, `*.key`, `.pipeline/`.

---

### [SEVERITY: MEDIUM] Deploys are not gated on CI passing
- **File:** `.github/workflows/ci.yml` (only workflow in `.github/workflows/`)
- **Config:** The workflow ends at `ci.yml:243` with `docker compose ... down --volumes`. There is no `deploy` job, no `environment:`, and no `.github/workflows/*deploy*`.
- **Why it's wrong:** `vercel.json` at the repo root means the marketing site deploys through Vercel's Git integration, which triggers on push independently of GitHub Actions. Vercel's own build for this repo runs `npm run build` (`package.json:10` → `tsc --noEmit && vite build`) — it does **not** run lint, tests, the secret-access gates, or the RLS/tenant-isolation suites. A push that fails every security gate in `ci.yml` still ships to production. Nothing in the repo implies branch protection is configured either.
- **Fix:** Turn off Vercel's automatic production deploys on push and drive them from a `deploy` job with `needs: [node, workers]`, or enable Vercel's "required checks" via GitHub branch protection on `main`.

---

### [SEVERITY: MEDIUM] `infra/New Text Document.txt` is a byte-identical copy of `infra/.env` containing a live credential
- **File:** `infra/New Text Document.txt` (5590 bytes) — identical size and content to `infra/.env` (5590 bytes); the credential's exact line location was removed before this snapshot entered git
- **Config:**
```
NEO4J_AUTH=<redacted>
```
  (**PL-15 redaction note (round 3):** the value above carried the real credential in the auditor's
  original 2026-07-31 working notes, and — after a first redaction pass that still truncated to a
  masked prefix/suffix — this line still carried real fragments of the live value. Any fragment of a
  real secret is real secret material once it enters git history, so the placeholder now carries zero
  characters of the actual value. The prose below already records everything security-relevant that
  survives redaction: the credential pairs the **default Neo4j username** `neo4j` with a
  human-guessable password. The exact live value was confirmed at audit time and remains on file only
  in the auditor's untracked working copy.)
- **Why it's wrong:** Currently *not* leaked — `.gitignore:21`'s `infra/*` allowlist catches it, and `git check-ignore -v` confirms both files are ignored. But the `.gitignore` comment at lines 18-20 says the quiet part out loud: *"secret-bearing scratch files there have repeatedly been named things no pattern above matches (e.g. a stray .txt)"*. This is that file, still sitting there. It survives on a `git add -f`, on any future edit to the allowlist, and — because the repo root is `C:\Users\splat\OneDrive\Desktop\Sayre` — it is already synced to OneDrive's cloud storage. Separately, the credential itself uses the **default Neo4j username** `neo4j` with a guessable password, and pairs with the 0.0.0.0 Bolt bind above.
- **Fix:** Delete `infra/New Text Document.txt`, rotate `NEO4J_AUTH`/`NEO4J_PASSWORD`, and add a pre-commit entropy scan so the allowlist is not the only line of defense.

---

### [SEVERITY: MEDIUM] Third-party and first-party actions pinned to mutable tags, not SHAs; Poetry unpinned
- **File:** `.github/workflows/ci.yml:34, 37, 136, 139, 144, 162`
- **Config:**
```yaml
      - uses: actions/checkout@v4          # :34, :136
      - uses: actions/setup-node@v4        # :37, :162
      - uses: actions/setup-python@v5      # :139
      - name: Install Poetry
        run: pipx install poetry           # :144 — no version constraint
```
- **Why it's wrong:** `@v4` is a *moving* tag the action owner can repoint at any commit; a compromised or coerced maintainer changes what runs in your job without any change to this repo. These are first-party GitHub actions so the risk is lower than for a random third-party action, but the pattern is the one the repo's own `security-attacker-agents/supply-chain-infrastructure-attacker.md` SC-04 brief tells auditors to flag. `pipx install poetry` with no constraint resolves to whatever Poetry released this morning, straight into a job that then executes `poetry install` over the whole Python dependency tree.
- **Fix:** Pin each action to a full commit SHA with the version in a trailing comment (`uses: actions/checkout@11bd719...  # v4.2.2`), pin `pipx install poetry==1.8.5`, and add `.github/dependabot.yml` with the `github-actions` ecosystem so the SHAs get bumped automatically.

---

### [SEVERITY: MEDIUM] turbo: `build` does not depend on `typecheck` or `lint`, and no `globalEnv`/`globalDependencies` declared
- **File:** `turbo.json:3-9` (entire tasks block)
- **Config:**
```json
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
```
- **Why it's wrong:** Three separate problems. (1) `build` depends only on `^build`, so `npx turbo run build` happily emits a workspace bundle with type errors and lint failures — CI only catches it because `ci.yml:60-75` invokes lint/typecheck as separate steps; any other caller (a Vercel build, a developer, a future deploy job) does not. (2) There is no `globalDependencies`, so editing the root `tsconfig.json` or `.nvmrc` does **not** invalidate any cached task — a stale `typecheck` PASS replays over a changed compiler config. (3) There is no `globalEnv` and no per-task `env`, which is the exact hazard the CI file already ran into and hand-worked-around at `ci.yml:84-87`: *"Turbo's strict env mode strips undeclared variables, which would make the penetration suite silently take its reachability skip."* The workaround was applied to one step; the root cause in `turbo.json` was never fixed, so the next DB- or broker-dependent test added under `turbo run test` will silently skip or cache-hit the same way.
- **Fix:** `"build": { "dependsOn": ["^build", "typecheck", "lint"], ... }`; add `"globalDependencies": ["tsconfig.json", ".nvmrc", "package-lock.json"]`; declare `"globalEnv": ["NODE_ENV", "DATABASE_ADMIN_URL", "DATABASE_RUNTIME_URL", "REDIS_HOST", "REDIS_PORT", "MESSAGING_INTEGRATION_REQUIRED"]`.

---

### [SEVERITY: MEDIUM] No structured logging and no error tracking across any service
- **File:** repo-wide
- **Config:** Zero matches for `pino|winston|structlog|bunyan` in `services/**` (source or manifests). Zero matches for `sentry|datadog` in any `package.json` or `pyproject.toml`. Instead, 24 raw `console.log`/`console.error` calls across `services/core/src` and `services/gateway/src`.
- **Why it's wrong:** `console.log` output is unstructured, uncorrelated, and — critically for this codebase — un-redacted. The repo has an entire CI gate (`scripts/check-secret-access.mjs`, 58KB) dedicated to keeping secrets out of `process.env` reads, and a rule in `.claude/rules/security-multitenancy.md` stating secrets must "never be logged" — but there is no logging layer capable of enforcing that, no `org_id` on log lines to reconstruct a tenant's request path during an incident, and no place an unhandled exception in production surfaces at all.
- **Fix:** Adopt `pino` (Node) + `structlog` (Python) with a shared redaction list and mandatory `org_id`/`request_id` fields, and wire an error tracker before the first external customer.

---

### [SEVERITY: MEDIUM] `/health` is liveness-only static JSON; only the Python fleet is scraped by Prometheus
- **File:** `services/core/src/services/health.ts:5-7`, `infra/prometheus/prometheus.yml:11-14`
- **Config:**
```ts
// Liveness only: this does NOT dial Neo4j/Postgres/Redis (D-5).
export function getHealthStatus(): HealthStatus {
  return { status: 'ok', service: 'core', version: '0.1.0', timestamp: new Date().toISOString() };
}
```
```yaml
scrape_configs:
  - job_name: sayre-workers
    static_configs:
      - targets: ["host.docker.internal:9464"]
```
- **Why it's wrong:** The liveness-only choice is documented and deliberate (D-5), but there is no *readiness* companion — so a load balancer will keep routing traffic to a core instance whose Neo4j and Postgres connections are both dead, because `/health` is a hardcoded `'ok'`. Separately, `services/core/package.json:33-35` pulls in `@opentelemetry/exporter-prometheus` and `@opentelemetry/sdk-metrics`, yet `prometheus.yml` has exactly one job pointed at the Python worker on port 9464 — the Node core and the WebSocket gateway export metrics nobody collects.
- **Fix:** Add `/ready` on core and gateway that dials Postgres/Neo4j/Redis with a short timeout, and add scrape jobs for the core and gateway metrics endpoints.

---

### [SEVERITY: LOW] LocalStack init directory mounted read-write into the container
- **File:** `infra/docker-compose.yml:76-77`
- **Config:**
```yaml
    volumes:
      - ./localstack/init/ready.d:/etc/localstack/init/ready.d
```
- **Why it's wrong:** No `:ro` flag, unlike the Prometheus mount two services down (`:94` correctly uses `- ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro`). The container has write access back into the host's git working tree, so a compromised LocalStack image (or the unauthenticated 4566 endpoint above) can rewrite `01-create-sqs-queues.sh` — a script that then executes on every subsequent `docker compose up`. Persistent host-side foothold from a container escape you did not need to perform.
- **Fix:** Append `:ro` to match the Prometheus mount.

---

### [SEVERITY: LOW] No container hardening directives anywhere in compose
- **File:** `infra/docker-compose.yml:13-96` (all five services)
- **Config:** No `user:`, no `read_only: true`, no `cap_drop:`, no `security_opt:`, no `networks:` segmentation, no memory/CPU limits on any of postgres, redis, neo4j, localstack, prometheus.
- **Why it's wrong:** Every container runs with the image's default entrypoint privileges and full default capability set, all on the shared default bridge network where each can reach every other. The Postgres and Neo4j official images do drop to their own service user internally, so the practical exposure is limited — but LocalStack and Prometheus do not, and a container breakout has an unnecessarily wide capability set to work with. No resource limits also means a runaway ingestion run can OOM the developer's host rather than just its own container.
- **Fix:** Add `cap_drop: [ALL]` plus the minimum `cap_add` per service, a dedicated `networks:` block, and `mem_limit` on each.

---

### [SEVERITY: LOW] Images pinned to tags, not digests — the CLAUDE.md claim holds, but only partly
- **File:** `infra/docker-compose.yml:15, 33, 47, 67, 88`
- **Config:**
```yaml
    image: pgvector/pgvector:pg16          # :15
    image: redis:7.4-alpine                # :33
    image: neo4j:5.24-community            # :47
    image: localstack/localstack:3.8       # :67
    image: prom/prometheus:v3.1.0          # :88
```
- **Why it's wrong:** **Verified: the CLAUDE.md "pinned service images" claim is accurate — there is no `:latest` anywhere, and the file's own header comment at line 2 ("Image tags are pinned exactly per DEPENDENCIES.md — no `latest`") is truthful.** The residual gap is that `pg16`, `7.4-alpine`, and `5.24-community` are all *floating* tags that the publisher repoints on every patch release, so two developers running `docker compose up` a month apart get different binaries with no repo change. Only `prom/prometheus:v3.1.0` is an immutable exact version.
- **Fix:** Pin by digest (`image: redis:7.4-alpine@sha256:...`) and let Renovate/Dependabot bump them.

---

### [SEVERITY: LOW] Prometheus service has no healthcheck and no volume
- **File:** `infra/docker-compose.yml:87-96`
- **Config:** The other four services each declare a `healthcheck:` block (`:26`, `:40`, `:57`, `:78`); Prometheus declares none, and has no entry in the top-level `volumes:` list at `:98-101` (which covers only `postgres_data`, `redis_data`, `neo4j_data`).
- **Why it's wrong:** `docker compose up --wait` cannot gate on Prometheus readiness, and all scraped metric history is discarded on every container restart. Acceptable for a local demo; both facts become defects the moment this shape is copied toward a real environment.
- **Fix:** Add a `wget --spider http://localhost:9090/-/healthy` healthcheck and a `prometheus_data:/prometheus` named volume.

---

### [SEVERITY: LOW] CI hygiene: no `concurrency`, no `timeout-minutes`, unfiltered `push` trigger, no Dependabot/CodeQL
- **File:** `.github/workflows/ci.yml:3-5`
- **Config:**
```yaml
on:
  push:
  pull_request:
```
- **Why it's wrong:** `push` with no `branches:` filter plus `pull_request` means every PR branch runs the full matrix twice on each push — including two Docker-backed jobs that start Postgres and LocalStack. No `concurrency: cancel-in-progress`, so superseded runs keep burning minutes. No `timeout-minutes` on either job, so a hung `docker compose --wait` sits until the 6-hour default. And `.github/` contains only `workflows/ci.yml` — no `dependabot.yml`, no CodeQL/SAST workflow, so nothing watches the ~800-file dependency tree for known CVEs.
- **Fix:** Filter `push` to `branches: [main]`, add a `concurrency` group keyed on `github.ref`, set `timeout-minutes: 20`, and add `.github/dependabot.yml` covering `npm`, `pip`, and `github-actions`.

---

### [SEVERITY: LOW] Catch-all rewrite in `vercel.json` swallows all 404s
- **File:** `vercel.json:3`
- **Config:**
```json
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```
- **Why it's wrong:** Standard SPA fallback and **not** an open proxy — the destination is a local path, so there is no SSRF/proxy hole here. The cost is that every unmatched path returns HTTP 200 with the app shell instead of a 404, which breaks crawler/monitoring signals and hides genuinely broken links. Any future `/api/*` route must be added to Vercel Functions (which take precedence) rather than relying on this passing through.
- **Fix:** Keep the fallback but scope it away from `/api` and asset paths, and render a real 404 route client-side.

---

## Explicit answer: do the `scripts/*.mjs` security checkers run automatically?

**Two of five do. Three do not.**

| Script | npm script | Runs in CI? | Evidence |
|---|---|---|---|
| `check-secret-access.mjs` | `check:secret-access` | **Yes** | `ci.yml:45` |
| `check-secret-access.test.mjs` | `test:secret-access` | **Yes** | `ci.yml:45` |
| `check-org-secret-access.mjs` | `check:org-secret-access` | **Yes** | `ci.yml:46` |
| `check-org-secret-access.test.mjs` | `test:org-secret-access` | **Yes** | `ci.yml:46` |
| `validate-security-audit-agents.mjs` | `check:security-audit-agents` | **No** | not in `ci.yml`; only `.claude/agents/security-checker.md:81` + `security-attacker-agents/README.md:81` |
| `validate-security-audit-run.mjs` | `check:security-audit-run` | **No** | not in `ci.yml`; only `.claude/agents/security-checker.md:84` |
| `validate-security-audit-run.test.mjs` | `test:security-audit-run` | **No** | not referenced outside `package.json:21` |
| `validate-pipeline-only-write.sh` | *(none)* | **No** | zero references repo-wide; fully orphaned |

The two secret-access gates are genuinely enforced, and they are well-built — `ci.yml:41-42` deliberately runs them **before** `npm ci` so no package lifecycle code executes before the source audit, and `check-org-secret-access.mjs:29-38` constructs its forbidden identifiers by string concatenation specifically so the gate never matches its own source. That is careful work.

The three security-*audit* validators are dead guardrails. Their only trigger is an LLM subagent deciding to invoke them mid-pipeline. `validate-security-audit-agents.mjs:96-106` even asserts that `.claude/agents/security-checker.md` still references the registry and both schemas — meaning the check that verifies the security pipeline is wired up correctly is itself only run *by* that pipeline. Nothing catches it when the wiring breaks.

## `security-attacker-agents/` — what it is

A versioned, well-organised library of nine adversarial audit briefs (LLM/RAG poisoning, model-provider SSRF, MCP key lifecycle, WebSocket, ingestion/queue/webhook, web/API, secrets lifecycle, supply chain) plus `audit-contract.md`, `progress-audit-orchestrator.md`, a machine-readable `agent-registry.json`, and two draft-2020-12 JSON schemas. It is wired into the CLAUDE.md pipeline only through `.claude/agents/security-checker.md` (stage 5) — never through CI.

**Nothing in it should be uncommitted.** Scanned for credentials, keys, and payloads: all hits are prose describing what to *check for* (e.g. `supply-chain-infrastructure-attacker.md:22` "SC-04 — CI trigger and permission abuse") or registry glob patterns (`agent-registry.json:74` `"**/*api-key*"`). No secrets, no exploit payloads, no tenant data. `README.md:53` correctly instructs that live audit evidence stays out of git and `.pipeline/` is gitignored (`.gitignore:45`).

Worth noting: `supply-chain-infrastructure-attacker.md` covers SC-01 through SC-14 — the exact surface this audit just examined. Had it ever been run, most findings above would already be known. It never has, because nothing runs it.

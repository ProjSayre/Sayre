# Audit 04 — Webhook ingress & Git/GitHub integration

Scope: `services/core/src/webhooks/`, `services/core/src/github/`, `services/core/src/integrations/git/`,
plus the wiring that makes them work (`routes/githubWebhook.ts`, `services/githubWebhookService.ts`,
`app.ts`, `queue/`) and the downstream consumers those modules publish to.

**Clean bill on the things most likely to be broken.** Verified, not assumed:
- Signature verification is present on the only webhook route, runs *before* parse/DB/publish
  (`githubWebhookService.ts:111`), uses `crypto.timingSafeEqual` over the **raw** body
  (`app.ts:27` mounts `express.raw` before `express.json()`), and a missing/malformed header
  returns `false` → 401 (`githubSignature.ts:33`). No sha1 fallback.
- `org_id` is never read from a webhook body anywhere in the path.
- No hardcoded credentials, no token in any log line, no token persisted to Postgres or Neo4j.
  The only `console.*` in scope is `integrations/git/worker.ts:54` and it logs a fixed string.
- SSRF: clone URL is pinned to `https://github.com/{full_name}.git`
  (`services/workers/sayre_workers/ingestion/repository.py:550-560`). No user-supplied scheme/host.
- Command injection: git runs via argv, never a shell; scratch clone cleanup is in a real `finally`
  (`repository.py:616-617`).

No CRITICAL findings. The real damage here is availability and silent data loss, not forgery.

---

### [SEVERITY: HIGH] Branch `create`/`delete` webhooks publish a guaranteed-poison message onto the ingestion FIFO queue, stalling that branch's message group for ~25 minutes

- **File:** `services/core/src/webhooks/normalizeGithubEvent.ts:193-205`
- **Code:**
```ts
    case 'create':
    case 'delete': {
      if (parsed.ref_type !== 'branch') {
        return { ignored: 'unsupported_ref_type' };
      }
      const branchName = nonEmptyString(parsed.ref);
      if (!branchName) return { ignored: 'no_ref' };
      type = 'branch';
      ref = `refs/heads/${branchName}`;
      payload = normalizeBranch(githubEvent, parsed);
      destinations = ['ingestion', 'ownership'];   // <-- 'ingestion' is wrong
      break;
    }
```
- **Why it's wrong:** `destinations` includes `'ingestion'`, so `githubWebhookService.ts:215-217`
  calls `publishIngestion(envelope)` with `envelope.type === 'repo.branch'`. The *only* consumer of
  that queue rejects the type outright:

  `services/workers/sayre_workers/ingestion/models.py:205-206`
```py
    if envelope.type not in {"repo.initial_parse", "repo.push"}:
        raise InvalidIngestionJobError("unsupported ingestion message type")
```
  A handler exception is deliberately *not* acknowledged —
  `services/workers/messaging/sqs_client.py:634-641`:
```py
    except Exception:
        logger.warning(
            "Handler failed for message_id=%s on queue %r; not deleting.", ...
```
  So the message returns to `ingestion.fifo` and is retried until `MAX_RECEIVE_COUNT=5`
  (`infra/localstack/init/ready.d/01-create-sqs-queues.sh:7`) with
  `visibility_timeout_seconds=300` (`ingestion/consumers.py:42`).

  The kill shot is FIFO semantics. The message group is
  `ingestionGroupId(org_id, provider_repo_id, ref)` (`queue/sqs.ts`, `publishIngestionEvent`) —
  the **same group** a subsequent `push` to that branch lands in. An undeletable message at the
  head of a FIFO group blocks every later message in that group. So the normal developer flow
  "create branch, push a commit" parks the push behind a poison message for up to
  5 × 300s ≈ 25 minutes. Every branch creation in every connected repo does this. For a product
  whose stated target is a 15-second sync, this is the headline defect.

  `normalizeGithubEvent.test.ts:156-172` asserts the current behaviour, so the test suite
  actively locks the bug in.
- **Fix:** `destinations = ['ownership']` for `create`/`delete`. A branch create/delete carries no
  `after` SHA and there is nothing for the ingestion worker to parse. (The ownership adapter
  already no-ops on it — `integrations/git/providers/github.ts:143` returns
  `{ refName: null, edits: [] }` — so `['ownership']` is harmless, or drop the event entirely.)
  Belt-and-braces: make the Python consumer treat `InvalidIngestionJobError` as non-retryable and
  delete the message straight to the DLQ instead of re-queuing it in front of live work.

---

### [SEVERITY: HIGH] Branch-deletion push (`deleted: true`, all-zero `after`) is sent to the ingestion worker, which fetches a ref that no longer exists — same permanent failure, same FIFO stall

- **File:** `services/core/src/webhooks/normalizeGithubEvent.ts:174-181`
- **Code:**
```ts
    case 'push': {
      const pushRef = nonEmptyString(parsed.ref);
      if (!pushRef) return { ignored: 'no_ref' };
      type = 'push';
      ref = pushRef;
      payload = normalizePush(parsed);
      destinations = ['ingestion', 'ownership'];
      break;
    }
```
  There is no `deleted` guard, even though `normalizePush` reads the flag
  (`normalizeGithubEvent.ts:96`: `deleted: parsed.deleted ?? false,`).
- **Why it's wrong:** GitHub's branch-deletion push carries
  `after: "0000000000000000000000000000000000000000"` and `deleted: true` — exactly the committed
  fixture `services/core/src/webhooks/__fixtures__/push.branch-deletion.json`. That message is
  typed `repo.push`, so the Python worker *accepts* it: the null SHA is 40 hex characters and
  passes `_REVISION = re.compile(r"^[0-9a-f]{40,64}$")` (`ingestion/repository.py:28`). The worker
  then runs, at `ingestion/repository.py:590-597`:
```py
            await git.run(
                "fetch", "--quiet", "--no-tags", "origin", ref_name,
                environment=authentication,
            )
```
  against a ref GitHub just deleted. `git fetch` fails, the handler raises, the message is not
  deleted, and the same 5 × 300s FIFO head-of-line block from the previous finding applies to that
  branch — plus a full scratch clone + installation-token mint burned on every one of the 5 retries.
  `normalizeGithubEvent.test.ts:81` explicitly asserts "still publishes to both", so this is
  encoded intent rather than an oversight.
- **Fix:** In the `push` case, return `{ ignored: 'branch_deleted' }` (or route to `['ownership']`
  only) when `parsed.deleted === true` or `parsed.after` is the all-zero SHA. A deleted branch has
  no head to project; the correct downstream action is retiring the ref projection, not parsing it.

---

### [SEVERITY: MEDIUM] No webhook replay protection anywhere, and the one idempotency mechanism that exists is disabled by `removeOnComplete: true`

- **File:** `services/core/src/services/githubWebhookService.ts:201-208`, `services/core/src/queue/bullmq.ts:180-184`
- **Code:**
```ts
  const envelope = makeEnvelope<NormalizedRepoEvent>({
    org_id: resolved.orgId,
    ...
    trace_id: deliveryId,
    idempotency_key: deliveryId,
```
```ts
  const job = await queue.add(envelope.type, envelope, {
    attempts: 1,
    removeOnComplete: true,
    ...opts,
  });
```
- **Why it's wrong:** There is no `X-GitHub-Delivery` store and no timestamp/freshness check —
  I grepped the whole of `services/core/src`; `deliveryId` is only ever copied into the envelope,
  never recorded. Replay defence is therefore entirely downstream, and it is thin:
  - **BullMQ (`ownership`):** `publishOwnership` passes `{ jobId: envelope.idempotency_key }`, but
    `enqueue` defaults `removeOnComplete: true`. Once the job completes the record is gone, so the
    same `jobId` is accepted again. The dedupe only holds for the seconds the job is in flight.
  - **SQS FIFO (`ingestion`):** `MessageDeduplicationId` gives a fixed 5-minute window, nothing more.
  - **`installation` lifecycle path:** no idempotency key at all. `githubWebhookService.ts:139-149`
    routes straight to `applyInstallationLifecycleEvent`, which mutates
    `github_app_installations` unconditionally.

  Concretely: anyone who captures one valid `installation` delivery body + its
  `X-Hub-Signature-256` (a proxy log, a staging smee.io relay, a CI artifact) can replay
  `action: "unsuspend"` at any later time to silently re-activate an installation an admin
  suspended — the signature stays valid forever because it is over the body only.
- **Fix:** Persist `X-GitHub-Delivery` with a TTL (a unique index on `delivery_id` and an
  `ON CONFLICT DO NOTHING` insert before step (d)) and short-circuit a duplicate to a 200 ignore.
  Separately, stop relying on `removeOnComplete: true` for idempotency — use
  `removeOnComplete: { age: <window> }` so the `jobId` record outlives the job.

---

### [SEVERITY: MEDIUM] Ownership sync has `attempts: 1` and no DLQ, so any transient failure permanently drops the update — and GitHub will never retry, because the webhook already answered 202

- **File:** `services/core/src/queue/bullmq.ts:180-184`, `services/core/src/integrations/git/worker.ts:26-32`
- **Code:**
```ts
  const worker = await createWorker(
    'github-sync',
    async (envelope) => {
      await syncGitMetadata(envelope, resolved);
    },
    { concurrency: 4 },
  );
```
- **Why it's wrong:** `enqueue` defaults to `attempts: 1` and `publishOwnership` does not override
  it. `syncGitMetadata` touches Postgres (`repositoryResolver.ts`) and Neo4j
  (`graphOwnershipStore.ts`) — both of which can blip. On any such blip the job fails once, lands
  in the `failed` set, and is never retried or alerted on. The HTTP request already returned 202
  (`routes/githubWebhook.ts:23`), so GitHub considers the delivery successful and will not resend.
  The result is silently missing OWNS/AUTHORED/MODIFIED edges — the exact data the Onboarding and
  Product views are built on — with nothing surfacing the loss. This also contradicts the
  "consumers require DLQs" posture the Python fleet already implements.
- **Fix:** Pass `{ attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnFail: false }`
  on the ownership enqueue, and add a failed-job drain/alert for `github-sync`.

---

### [SEVERITY: MEDIUM] `installation_repositories` `added` makes unbounded sequential GitHub API calls inside the webhook request — guaranteed delivery timeout and retry storm on a bulk repo selection

- **File:** `services/core/src/services/githubInstallationRepositoriesService.ts:62-69`
- **Code:**
```ts
  const resolved: InstalledRepo[] = [];
  for (const repo of added) {
    const installedRepo = await deps.githubClient.getInstallationRepo(installationId, repo.fullName);
    if (installedRepo === null) continue;
    resolved.push(installedRepo);
  }
```
- **Why it's wrong:** `parseRepoArray` (`webhooks/parseInstallationRepositoriesEvent.ts:40-52`)
  applies no cap to `repositories_added`. Each iteration is *two* sequential network round-trips —
  `getInstallationRepo` does `GET /repos/{owner}/{repo}` and then `resolveDefaultBranchHead`
  (`github/appClient.ts:500-512`), each with `REQUEST_TIMEOUT_MS = 10_000`. GitHub's own webhook
  delivery timeout is 10 seconds, so a user flipping the Configure page to "All repositories" on a
  200-repo org produces 400 serial calls in one request: the delivery is marked failed, GitHub
  retries, and each retry restarts the whole scan concurrently with the still-running original.
  The install callback got this right — `githubAppInstallService.ts:137` caps at
  `MAX_REPOS_PER_CALLBACK = 25` — but the webhook path never got the same treatment.
- **Fix:** Acknowledge the webhook immediately and move the repo resolution onto the existing
  `initial_parse` outbox / a BullMQ job, or at minimum apply the same 25-repo cap and reuse
  `DEFAULT_BRANCH_LOOKUP_CONCURRENCY`-style parallelism instead of a serial loop.

---

### [SEVERITY: MEDIUM] `oauthClient.ts` has no request timeout, no `redirect: 'manual'`, and unbounded JSON reads — none of the hardening its sibling `appClient.ts` has

- **File:** `services/core/src/github/oauthClient.ts:94-101` and `129-139`
- **Code:**
```ts
    response = await fetch(`${webBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
```
```ts
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...
```
- **Why it's wrong:** Compare `appClient.ts:122-142`, which sets `redirect: 'manual'` and
  `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`, and reads bodies through `readBoundedJson` with
  `MAX_JSON_RESPONSE_BYTES`. The OAuth login client does none of that: `response.json()` at
  `oauthClient.ts:114`, `:155` and `:181` is unbounded, and a stalled upstream connection hangs the
  login request forever, pinning an Express handler and its socket. This is the *unauthenticated*
  `/auth/github/callback` path, so it is the cheapest thing on the box to hold open. (Authorization
  header stripping on cross-origin redirect is handled by undici, so the missing
  `redirect: 'manual'` is a hardening gap rather than a token leak — but it should still match the
  sibling.)
- **Fix:** Route all three calls through an `appClient`-style helper: `AbortSignal.timeout(...)`,
  `redirect: 'manual'`, and a bounded body reader.

---

### [SEVERITY: MEDIUM] `listPullRequestFiles` has an unbounded pagination loop with no request timeout, on a worker with concurrency 4

- **File:** `services/core/src/integrations/git/providers/github.ts:107-128`
- **Code:**
```ts
  for (let page = 1; ; page += 1) {
    const response = await fetcher(
      `${getConfig('GITHUB_API_BASE_URL')}/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      { headers: { ... } },
    );
    ...
    if (body.length < 100) break;
  }
```
  The default fetcher is `(input, init) => fetch(input, init)` (`github.ts:138`) — no signal.
- **Why it's wrong:** Two compounding problems. (1) The only loop exit is a short page; a
  misbehaving or proxied upstream that keeps returning 100 entries loops forever. (2) No timeout
  means one stalled connection permanently consumes one of the 4 `github-sync` worker slots
  (`integrations/git/worker.ts:31`). Four merged PRs against a stalled endpoint deadlocks all
  ownership sync for the whole deployment. `response.json()` at `:121` is also unbounded, unlike
  `appClient`'s `readBoundedJson`.
- **Fix:** Cap the loop (GitHub itself truncates this endpoint at 3000 files → 30 pages), pass an
  `AbortSignal.timeout()` on each request, and bound the response read.

---

### [SEVERITY: MEDIUM] Ownership graph silently truncates at GitHub's 20-commit push cap and ignores the `forced` flag it already parses

- **File:** `services/core/src/integrations/git/providers/github.ts:57-79`
- **Code:**
```ts
function resolvePush(event: ProviderRepoEvent, occurredAt: string): ProviderChangeSet {
  const commits = Array.isArray(event.payload.commits) ? event.payload.commits : [];
  const edits: ProviderFileEdit[] = [];
  for (const rawCommit of commits) {
    ...
```
- **Why it's wrong:** GitHub's push payload includes **at most 20 commits**; larger pushes are
  truncated and the API expects the consumer to page the Commits API for the rest. `resolvePush`
  treats the array as complete, so on any push of 21+ commits the files touched only by the
  remaining commits get no `OWNS`/`AUTHORED`/`MODIFIED` edges. Ownership data is quietly wrong on
  exactly the large merges that matter most.

  Separately, `normalizeGithubEvent.ts:96` faithfully carries `forced: parsed.forced ?? false`
  through to the payload, and `resolvePush` never reads it. The ingestion side handles force-push
  correctly (`ingestion/service.py:82` — `elif current is None or job.kind == "initial" or job.forced:`
  → `full_rebuild = True`, with a non-fast-forward fallback at `:93-95`), so the CLAUDE.md rule is
  satisfied for head projection. But the ownership graph applies a pure MERGE delta
  (`graphOwnershipStore.ts:22-71`), so after a force-push that rewrites history the `OWNS` and
  `MODIFIED` edges from the abandoned commits stay in the graph forever, attributing files to
  authors whose commits no longer exist.
- **Fix:** On `forced === true`, fall back to the Compare/Commits API for the real commit range (or
  flag the ref for an ownership rebuild) rather than trusting the truncated inline array. Apply the
  same paging fix for >20-commit pushes.

---

### [SEVERITY: LOW] `full_name` shape is validated in `appClient` but not in the git provider adapter

- **File:** `services/core/src/integrations/git/providers/github.ts:102-105`
- **Code:**
```ts
  const repository = event.repo.full_name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
```
- **Why it's wrong:** `extractRepo` (`normalizeGithubEvent.ts:57-71`) only checks that `full_name`
  is a non-empty string — it never checks it is `owner/name`. This helper then splits on every `/`
  with no arity check and `encodeURIComponent`, which does **not** escape `.`, so `..` path segments
  survive into the request URL and the WHATWG URL parser collapses them, letting the constructed
  path escape `/repos/{owner}/{repo}/`. `appClient.ts:225-231` does exactly the right check:
```ts
  const parts = fullName.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new GithubAppApiError('GitHub returned a malformed repository full_name.');
  }
```
  Not exploitable today — the body is HMAC-verified so `full_name` is GitHub-attested, and GitHub
  will not mint a repo or owner named `..` — which is why this is LOW and not higher. It is an
  inconsistency that will bite when a second provider adapter reuses the pattern.
- **Fix:** Extract `encodedRepositoryPath` from `appClient.ts` into a shared helper and use it here.

---

### [SEVERITY: LOW] Installation id accepted as any `number`, turning a malformed payload into a 500 + GitHub retries instead of a 2xx ignore

- **File:** `services/core/src/webhooks/normalizeGithubEvent.ts:50-55`, `services/core/src/services/githubWebhookService.ts:142`
- **Code:**
```ts
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
```
```ts
    const installationId = typeof installation?.id === 'number' ? installation.id : null;
```
- **Why it's wrong:** `Number.isFinite` admits negatives and fractions, and the `installation`
  branch at `:142` does not even check finiteness, so `NaN` passes. All three flow into
  `resolveInstallationOrg`, which rejects them:
  `db/installations.ts:32-34` throws `InstallationResolutionInputError`. That error is **not**
  mapped in `http/express.ts`, so it falls through to the generic `res.status(500)` at
  `express.ts:233`. GitHub treats 500 as a failed delivery and retries three times. The stated
  intent (`githubWebhookService.ts:136-138`: "installation.id ... malformed is treated the same as
  `no_installation` (2xx ignored, never throws)") is not what the code does.
- **Fix:** Use `Number.isSafeInteger(id) && id > 0` in all three places.

---

### [SEVERITY: LOW] Push ref is not constrained to `refs/heads/`, so tag pushes create bogus ref-head projections

- **File:** `services/core/src/webhooks/normalizeGithubEvent.ts:175-181`
- **Code:**
```ts
      const pushRef = nonEmptyString(parsed.ref);
      if (!pushRef) return { ignored: 'no_ref' };
      type = 'push';
      ref = pushRef;
```
- **Why it's wrong:** The `create`/`delete` case ten lines below deliberately filters
  `if (parsed.ref_type !== 'branch') return { ignored: 'unsupported_ref_type' };` — the push case
  has no equivalent. A tag push arrives with `ref: "refs/tags/v1.2.3"`, passes
  `ref_name.startswith("refs/")` in `ingestion/repository.py:570`, and gets a full ref-head
  projection + FIFO message group of its own. Every release tag therefore creates a parallel,
  permanently-stale projection of the whole repo alongside the real branch.
- **Fix:** `if (!pushRef.startsWith('refs/heads/')) return { ignored: 'unsupported_ref_type' };`

---

### [SEVERITY: LOW] 5 MB raw-body cap can permanently reject legitimate large deliveries

- **File:** `services/core/src/app.ts:27`
- **Code:**
```ts
  app.use('/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter);
```
- **Why it's wrong:** GitHub sends payloads up to 25 MB. Anything between 5 MB and 25 MB is
  rejected by `raw-body` before any handler runs, surfaces as the 413 at `http/express.ts:153-156`,
  and GitHub retries it three times before giving up — the event is then lost with no trace beyond
  a failed delivery in GitHub's UI. Most likely trigger is an `installation_repositories` event on
  a very large org.
- **Fix:** Raise the limit to match GitHub's 25 MB ceiling, or log/alert on the 413 so a dropped
  delivery is at least observable.

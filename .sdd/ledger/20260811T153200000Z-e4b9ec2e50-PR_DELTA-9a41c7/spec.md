# W1-02 — GitHub webhook receiver (gapfill: GAP-4 … GAP-9)

Gap-mode run (`/pipeline-gapfill`). `.pipeline/gaps.json` verdict is `GAPFILL`, overlays
`[base, spot-check]`, `security_required: true`, `audit_first: false`.

**Audit-Rebuild framing (cheat-sheet base template, `docs/product/Audit-Rebuild-Cheat-Sheet.md` §1):**
this ticket shipped during the Wave 0–4 MVP crunch. The existing implementation is *not* the
source of truth — the ticket's Acceptance line is. Every criterion below is a re-derivation
against a sentence of the original ticket, not a "does the feature generally work" pass.
**Spot-check overlay (§2, `.sdd/mvp-overlays.yml`):** "verify that X-Hub-Signature-256 validation
actually rejects tampered payloads, and that no secret/credential is read outside the W0-07
`getSecret()` loader." gap-scout verified both directly (GAP-1, GAP-2 — see Scope → out); this
spec therefore adds no new criterion for them, and Dev must not regress them.

---

## Ticket Check

**What I'm about to build**
Six repairs to the GitHub webhook receiver — the endpoint GitHub calls when someone pushes code
or opens a pull request. It already refuses forged messages; these changes stop it accepting
*re-sent copies* of a genuine message as if they were new, stop it reacting to things it was
never meant to react to (tag pushes, oddly-shaped repository names, nonsense installation
numbers), make one bad case answer "no thanks" instead of "something broke on our side", and add
the missing test that proves messages actually land on the second of the two internal queues.

**What I'm explicitly not doing**
Not changing how signature checking works, not changing where the webhook secret comes from, and
not changing the shape of the messages the rest of the system consumes. Not building a new
database table to remember every delivery forever, and not touching the separate "app was
installed / suspended / unsuspended" handling that belongs to a different ticket. Not raising the
5 MB limit on how large an incoming webhook may be — see the last item.

**How you'll know it worked**
Push a commit to a connected repo and the repo still updates as before. Push a *tag* (e.g. `v1.0`)
and nothing happens — no phantom copy of the repo appears alongside the real branch. If someone
captures a genuine webhook and sends it again with a fresh delivery id, the work is recognised as
a duplicate rather than being redone. Sending a malformed installation number gets a clean
rejection instead of an "internal server error" that makes GitHub keep retrying.

**What I had to guess**
Three judgement calls the ticket didn't settle:
1. **Duplicate detection.** I made the system identify a delivery by *the exact bytes GitHub
   signed* instead of the delivery-id header, because that header isn't covered by the signature
   and anyone can change it. Trade-off: two genuinely different events that happen to have
   byte-identical bodies would now be treated as one. In practice GitHub bodies always differ
   (commit SHAs, timestamps), so I judged this safe.
2. **The 5 MB size limit** (gap-scout explicitly asked for a decision, not a silent fix). I kept
   5 MB rather than raising it to GitHub's 25 MB ceiling. This endpoint is unauthenticated: every
   byte is held in memory *before* we can tell whether the caller is really GitHub, so a bigger
   limit is a bigger free denial-of-service lever for a stranger. 5 MB is still more than ten
   times the largest payload the event types we handle can realistically produce. I also made the
   rejection visible in the logs so a genuine oversized delivery can't be lost silently, and
   wrote down the reasoning where the limit lives. If a real dropped delivery is ever observed,
   raising it is a one-line follow-up.
3. **Rejecting odd repository names with a 400** (a hard "bad request") rather than quietly
   ignoring them, to match how the receiver already treats other malformed bodies.

---

## Goal

Close the six real defects gap-scout narrowed on the already-shipped W1-02 receiver: bind
replay/dedup identity to the signed bytes rather than an unsigned header, constrain `push` to
branch refs, make a malformed `installation.id` a clean 2xx-ignore/400 instead of a 500 +
GitHub retry storm, validate `repository.full_name` to a real `owner/name` shape before anything
is published, actually assert the BullMQ half of "replayed fixtures produce correct queue
messages", and resolve the 5 MB body-cap tradeoff explicitly and observably.

## Scope

### In
- **GAP-4** — derive the envelope's `idempotency_key` (and therefore the SQS
  `MessageDeduplicationId` and BullMQ `jobId`) from a SHA-256 digest of the raw, HMAC-signed body,
  not from the unsigned `X-GitHub-Delivery` header. The delivery id stays as `trace_id` /
  `payload.delivery_id` for attribution only — nothing security-relevant may depend on it.
- **GAP-5** — `push` events are constrained to `refs/heads/*`, mirroring the `ref_type === 'branch'`
  filter `create`/`delete` already have.
- **GAP-6** — `installation.id` must be a positive safe integer in *both* places that read it;
  `InstallationResolutionInputError` gets mapped in `http/express.ts` so it can never surface as a 500.
- **GAP-7** — `repository.full_name` must be a real two-segment `owner/name` before normalization
  succeeds, via a shared validator (the same shape `github/appClient.ts:225-231` already enforces).
- **GAP-8** — test-only: assert the ownership publish binds queue `'github-sync'`, the exact
  envelope, and `{ jobId: envelope.idempotency_key }`; replace the inert
  `githubWebhook.fixtures.test.ts:147-148` destructure that asserts nothing.
- **GAP-9** — explicit, documented decision on the raw-body cap (**keep 5 MB**), expressed as a
  named exported constant plus an observable rejection.

### Out (already satisfied — do NOT re-implement, do NOT regress)
Dev must not expand into these without a new gap id.

- **GAP-1 (`OK`)** — X-Hub-Signature-256 validation itself: present, constant-time, over the raw
  bytes, runs before parse/DB/publish, tampered payload → 401 and never reaches a queue. Evidence:
  `services/core/src/webhooks/githubSignature.ts`, `services/core/src/services/githubWebhookService.ts`,
  `services/core/src/app.ts`, `services/core/src/http/express.ts`,
  `services/core/src/routes/githubWebhook.fixtures.test.ts`, `services/core/src/routes/githubWebhook.test.ts`.
- **GAP-2 (`OK`)** — the webhook secret is read exclusively through the W0-07 loader
  (`getSecret('env://GITHUB_WEBHOOK_SECRET')`); `githubSignature.ts` never touches
  `getSecret`/`getConfig`/`process.env`. Evidence: `services/core/src/services/githubWebhookService.ts`,
  `services/core/src/webhooks/githubSignature.ts`, `packages/config/src/secrets.ts`,
  `services/core/src/routes/githubWebhook.test.ts`, `infra/.env.example`.
- **GAP-3 (`OK`)** — the SQS/ingestion half of "replayed fixtures produce correct queue messages":
  fixtures replay end-to-end and deep-compare against the committed envelope fixtures, cross-checked
  on the Python side. Evidence: `services/core/src/routes/githubWebhook.fixtures.test.ts`,
  `services/core/src/webhooks/__fixtures__`, `services/core/src/queue/__fixtures__/repo_push.envelope.json`,
  `services/workers/tests/test_push_wire_fixture.py`, `services/core/src/webhooks/normalizeGithubEvent.ts`,
  `services/workers/sayre_workers/ingestion/models.py`.
  *Consequence of AC-1, not an expansion:* the committed envelope fixtures' `idempotency_key` value
  changes (the comparison mechanism GAP-3 credits stays exactly as it is).

### Also out (deliberately, with reasons — see Open questions)
- A durable receiver-side delivery log (a `webhook_deliveries` table + migration + TTL sweep) and
  changing BullMQ's `removeOnComplete: true`. Real audit findings, **not** filed as gaps by
  gap-scout; they widen the diff into a new migration and a queue-wide behavior change.
- The `installation` lifecycle path's total absence of an idempotency key (W1-06 surface).
- Refactoring `github/appClient.ts`'s existing `encodedRepositoryPath` check onto the new shared
  validator (its rules differ slightly and it is already safe).
- `integrations/git/providers/github.ts`'s unchecked `full_name.split('/')` — it becomes
  unreachable-with-bad-input once AC-4 lands upstream of it.

## Affected files

**New**
- `services/core/src/webhooks/githubDeliveryIdentity.ts` — signed-body-derived idempotency key (AC-1).
- `services/core/src/github/repoFullName.ts` — shared `owner/name` validator (AC-4).
- `services/core/src/webhooks/__fixtures__/push.tag.json` — a validly-shaped `push` with
  `ref: "refs/tags/v1.0.0"` (AC-2). Same `{ headers, body }` shape as the sibling fixtures.
- `services/core/src/webhooks/__fixtures__/push.malformed-full-name.json` — a `push` whose
  `repository.full_name` is `"../../evil"` (AC-4).

**Modified**
- `services/core/src/services/githubWebhookService.ts` — AC-1 (idempotency key source), AC-3
  (installation-branch id guard).
- `services/core/src/webhooks/normalizeGithubEvent.ts` — AC-2 (`refs/heads/` guard), AC-3
  (`extractInstallationId`), AC-4 (`extractRepo` full_name shape).
- `services/core/src/http/express.ts` — AC-3 (`InstallationResolutionInputError` → 400), AC-6
  (fixed-string warning on the `entity.too.large` branch).
- `services/core/src/app.ts` — AC-6 (named body-cap constant + rationale comment).
- `services/core/src/routes/githubWebhook.ts` — AC-6 (`GITHUB_WEBHOOK_MAX_BODY_BYTES` export).
- `services/core/src/queue/__fixtures__/repo_push.envelope.json` and
  `services/core/src/queue/__fixtures__/repo_push.branch-deletion.envelope.json` — AC-1: the
  `idempotency_key` value only (`trace_id`, `payload.delivery_id`, and every other field unchanged).

**Existing tests that encode the current (defective) behavior and must be updated, not worked around**
- `services/core/src/services/githubWebhookService.test.ts:491-505` — asserts
  `idempotency_key === 'replay-1'` (the delivery id). Update to the AC-1 identity; keep the
  same-delivery-replay intent.
- `services/core/src/routes/githubWebhook.fixtures.test.ts:575-590` — asserts
  `idempotency_key === headers['x-github-delivery']`; and `:147-148` — the inert destructure (AC-5).
- `services/core/src/routes/githubWebhook.test.ts` — any assertion tying `idempotency_key` to the
  delivery header.
- `services/core/src/webhooks/normalizeGithubEvent.test.ts` — push-ref, installation-id, and
  full_name cases.

## Interfaces / signatures

```ts
// services/core/src/webhooks/githubDeliveryIdentity.ts (new)
export const GITHUB_WEBHOOK_IDEMPOTENCY_PREFIX = 'github:webhook:';

/**
 * Dedup identity for a GitHub delivery, derived ONLY from the bytes covered by
 * X-Hub-Signature-256. Never mixes in X-GitHub-Delivery or any other unsigned header:
 * an attacker who captures a valid (body, signature) pair must not be able to mint a
 * fresh dedup identity by editing a header. Returns
 * `github:webhook:<sha256(rawBody) hex>`.
 */
export function githubWebhookIdempotencyKey(rawBody: Buffer): string;
```

```ts
// services/core/src/github/repoFullName.ts (new)
/** One `owner` or `name` segment: GitHub's own charset, 1..100 chars, no '/'. */
export const REPO_FULL_NAME_SEGMENT_RE: RegExp; // /^[A-Za-z0-9._-]{1,100}$/

/**
 * True iff `value` is a clean two-segment `owner/name`: exactly one '/', both
 * segments matching REPO_FULL_NAME_SEGMENT_RE, and neither segment '.' or '..'.
 * Rejects '../../evil', 'a/b/c', 'owner/', '/name', 'owner//name', and any segment
 * containing whitespace or a percent-escape.
 */
export function isValidRepoFullName(value: unknown): value is string;
```

```ts
// services/core/src/routes/githubWebhook.ts (modified — new export)
/**
 * Raw-body cap for the UNAUTHENTICATED webhook ingress. Deliberately below GitHub's
 * 25 MB ceiling (see spec AC-6 / app.ts comment): every byte is buffered before the
 * HMAC can be checked, so the cap is a pre-authentication DoS bound first and a
 * compatibility limit second.
 */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES: number; // 5 * 1024 * 1024
```

Unchanged signatures (do not alter): `handleGithubWebhook(input, deps)`,
`normalizeGithubEvent(input)`, `verifyGithubSignature(rawBody, header, secret)`,
`publishIngestionEvent(envelope)`, `enqueue(name, envelope, opts)`, `MessageEnvelope<T>`,
`NormalizedRepoEvent`.

Envelope shape after AC-1 (only the one field changes):

```ts
makeEnvelope<NormalizedRepoEvent>({
  org_id: resolved.orgId,                                // unchanged (server-resolved)
  type: `repo.${event.type}`,                            // unchanged
  source: 'github-webhook',                              // unchanged
  trace_id: deliveryId,                                  // unchanged (attribution only)
  idempotency_key: githubWebhookIdempotencyKey(input.rawBody), // CHANGED (was deliveryId)
  payload: event,                                        // unchanged (payload.delivery_id kept)
});
```

## Approach

Build in this order — each step is independently verifiable.

1. **AC-1 / GAP-4.** Add `webhooks/githubDeliveryIdentity.ts`. In `githubWebhookService.ts` step (h),
   replace `idempotency_key: deliveryId` with `githubWebhookIdempotencyKey(input.rawBody)`. Leave
   `trace_id`, the required-header check, and `payload.delivery_id` alone. Then regenerate the two
   committed envelope fixtures' `idempotency_key` (compute once over
   `Buffer.from(JSON.stringify(fixture.body))` — the same bytes `__fixtures__/loadFixture.ts`
   reconstructs — since `githubWebhook.fixtures.test.ts` deep-compares every non-volatile field).
   Add a comment stating the invariant: dedup identity comes from signed bytes only.
2. **AC-2 / GAP-5.** In `normalizeGithubEvent`'s `push` case, after the existing `no_ref` check:
   `if (!pushRef.startsWith('refs/heads/') || pushRef.length <= 'refs/heads/'.length) return { ignored: 'unsupported_ref_type' };`
   Reuse the existing `IgnoreReason` — no new reason value, no new HTTP status. Add `push.tag.json`.
3. **AC-3 / GAP-6.** Tighten `extractInstallationId` to `Number.isSafeInteger(id) && id > 0`; apply
   the identical guard in `githubWebhookService.ts`'s `installation` branch (currently
   `typeof installation?.id === 'number'`, which admits `NaN`). Then map
   `InstallationResolutionInputError` → `400 { error: 'bad request' }` in `http/express.ts` as
   defence-in-depth for every other caller of `resolveInstallationOrg`. This makes the code match
   its own comment at `githubWebhookService.ts:136-138`.
4. **AC-4 / GAP-7.** Add `github/repoFullName.ts`; call `isValidRepoFullName` in `extractRepo`, so a
   bad shape throws the existing `MalformedGithubPayloadError` → existing 400 mapping → no publish.
   Note the deliberate ordering: ignore-classification (ping/unsupported/tag/no_installation) still
   happens *before* `extractRepo`, so an ignored event with a bad `full_name` stays a 200 ignore.
   Add `push.malformed-full-name.json`.
5. **AC-6 / GAP-9.** Export `GITHUB_WEBHOOK_MAX_BODY_BYTES` from `routes/githubWebhook.ts`, use it in
   `app.ts`'s `express.raw({ type: '*/*', limit: GITHUB_WEBHOOK_MAX_BODY_BYTES })`, and record the
   decision in a comment there (kept at 5 MB; unauthenticated pre-HMAC buffering; >10x the largest
   plausible supported payload; raise only if a real 413 is observed). In `http/express.ts`'s
   existing `entity.too.large` branch add exactly one fixed-string `console.warn` — no headers, no
   body, no signature, no secret — so a dropped delivery is observable.
6. **AC-5 / GAP-8** is test-only and lands with `red`'s suite; Dev's obligation is limited to not
   changing the `defaultDeps.publishOwnership` binding
   (`enqueue('github-sync', envelope, { jobId: envelope.idempotency_key })`) while doing steps 1-5.
7. Run the verification order from `CLAUDE.md`: `npx tsc --noEmit`, then `npm run test`, then
   `npm run lint`. `services/workers` is untouched by design — but re-run
   `poetry run pytest tests/test_push_wire_fixture.py` once, since step 1 edits a fixture that suite
   loads (it asserts structure/type, not the `idempotency_key` value, so it must stay green).

## Acceptance criteria

- **AC-1 (GAP-4):** The envelope's `idempotency_key` — and therefore the SQS
  `MessageDeduplicationId` and the BullMQ `jobId` — is `github:webhook:<sha256 hex of the raw
  signed body>`, computed only from bytes covered by `X-Hub-Signature-256`. Two deliveries carrying
  identical bytes but different `X-GitHub-Delivery` headers produce the **same** `idempotency_key`
  and the same BullMQ `jobId`; the delivery id remains visible as `trace_id` and
  `payload.delivery_id` for attribution only.
- **AC-2 (GAP-5):** A validly-signed `push` whose `ref` is not under `refs/heads/` (e.g.
  `refs/tags/v1.0.0`, `refs/pull/7/head`, a bare `main`, or exactly `refs/heads/`) is classified
  `{ ignored: 'unsupported_ref_type' }` → HTTP 200 `{ ok: true, ignored: 'unsupported_ref_type' }`,
  with zero calls to `publishIngestionEvent` and zero calls to `enqueue`. A `push` under
  `refs/heads/` (including nested names like `refs/heads/feat/a/b`) is unaffected.
- **AC-3 (GAP-6):** `installation.id` is accepted only when `Number.isSafeInteger(id) && id > 0`, in
  both `extractInstallationId` and `githubWebhookService`'s `installation` branch. `-1`, `1.5`,
  `0`, `Infinity`, `NaN`, and a non-safe integer resolve to a 200 `no_installation` ignore with
  `resolveOrg`/`applyInstallationLifecycle` never called — never a 500. Independently,
  `InstallationResolutionInputError` is mapped in `http/express.ts` to
  `400 { error: 'bad request' }`, so it cannot reach the generic 500 fallback from any route.
- **AC-4 (GAP-7):** `repository.full_name` is accepted only as a clean two-segment `owner/name`
  (each segment matching `/^[A-Za-z0-9._-]{1,100}$/`, neither `.` nor `..`). `../../evil`,
  `a/b/c`, `owner/`, `/name`, and `owner//name` throw `MalformedGithubPayloadError` → HTTP 400 with
  no publish to either queue; ordinary names such as `acme-corp/widgets` are unaffected.
- **AC-5 (GAP-8):** The BullMQ half of "replayed fixtures produce correct queue messages" is
  measured: replaying `push.json` asserts `enqueue` was called with queue name exactly
  `'github-sync'`, the same envelope object handed to `publishIngestionEvent`, and options exactly
  `{ jobId: envelope.idempotency_key }`. The inert
  `githubWebhook.fixtures.test.ts:147-148` destructure (queue-name string mistyped as the envelope,
  asserting nothing) no longer exists.
- **AC-6 (GAP-9):** The raw-body cap decision is explicit: it **stays at 5 MB**, expressed as the
  exported constant `GITHUB_WEBHOOK_MAX_BODY_BYTES` used by `app.ts`, with the rationale recorded in
  code (unauthenticated endpoint, whole body buffered before the HMAC can run, >10x the largest
  plausible payload for the supported event types; GitHub's 25 MB ceiling is knowingly not matched).
  An over-cap request returns 413 `{ error: 'payload too large' }` **before** the secret loader,
  signature check, or any queue call runs, and emits exactly one fixed-string warning containing no
  header, body, signature, or secret material.

## Edge cases

- **EC-1:** Same bytes, same `X-GitHub-Delivery`, replayed twice (GitHub's own retry) → two
  publishes with an identical `idempotency_key`; envelopes differ only in `message_id`/`occurred_at`.
- **EC-2:** Same bytes, *different* `X-GitHub-Delivery` (the GAP-4 attack) → identical
  `idempotency_key` and identical BullMQ `jobId`, while `trace_id`/`payload.delivery_id` still
  reflect each delivery's own header.
- **EC-3:** Different bytes, same `X-GitHub-Delivery` → different `idempotency_key`s (no accidental
  collapse of two real events).
- **EC-4:** A body tampered after signing is still 401 with no digest published and no queue call —
  GAP-1 regression guard; AC-1 must not move any work ahead of the signature check.
- **EC-5:** `push` with `ref: "refs/tags/v1.0.0"` → 200 `unsupported_ref_type`, no publish to either
  queue (previously published as `repo.push`).
- **EC-6:** `push` with `ref` exactly `"refs/heads/"`, or a near-miss like `"refs/headsfoo"` /
  `"refs/head/main"` → 200 `unsupported_ref_type`.
- **EC-7:** `push` with `ref: "refs/heads/feat/a/b"` → still normalized and published to both
  destinations (slashes inside a branch name are legal).
- **EC-8:** `push` with a missing/blank `ref` → still 200 `no_ref` (unchanged classification, and
  ordered before the new `refs/heads/` guard).
- **EC-9:** `create`/`delete` are untouched: `ref_type: 'branch'` still yields
  `refs/heads/<name>` to ownership only; `ref_type: 'tag'` still yields `unsupported_ref_type`.
- **EC-10:** `push` with `installation.id` of `-1`, `1.5`, `0`, `Infinity`, `NaN`, `"555"` (string),
  or `2 ** 53` → 200 `no_installation`, `resolveOrg` never called, nothing published.
- **EC-11:** An `installation` event with those same malformed ids → 200 `no_installation` with
  `applyInstallationLifecycle` never called (today `NaN` slips through this branch).
- **EC-12:** `InstallationResolutionInputError` raised on any route → 400 `{ error: 'bad request' }`,
  never 500 and never leaking the error message beyond that fixed body.
- **EC-13:** `installation.id === Number.MAX_SAFE_INTEGER` → accepted; `resolveOrg` is called with it.
- **EC-14:** `repository.full_name` of `../../evil`, `a/b/c`, `owner/`, `/name`, `owner//name`,
  `..`, `owner/na me`, or a 300-character segment → 400, no publish to either queue.
- **EC-15:** `repository.full_name` of `acme-corp/widgets`, `a.b/c_d-e.f`, `A_1/x.y-z` → published
  normally (no false rejection of legal GitHub names).
- **EC-16:** `repository.full_name` missing, empty, or a non-string → still 400 (unchanged).
- **EC-17:** A `push` fixture's ownership publish binds exactly `('github-sync', envelope,
  { jobId: envelope.idempotency_key })` — queue name, envelope identity, and options all asserted.
- **EC-18:** `pull_request` → exactly one `enqueue` on `'github-sync'` and zero
  `publishIngestionEvent` calls (destination routing unchanged by this work).
- **EC-19:** `enqueue` rejecting while `publishIngestionEvent` succeeds (and vice versa) still
  produces a 500 with no partial 2xx — unchanged `Promise.allSettled` behavior under the new `jobId`.
- **EC-20:** A body just under `GITHUB_WEBHOOK_MAX_BODY_BYTES` with a valid signature is processed
  normally; a body over it returns 413 with `getWebhookSecret` never invoked and no queue call.
- **EC-21:** The 413 response body is exactly `{ error: 'payload too large' }` — no echo of the
  submitted payload — and the accompanying warning line contains no header/body/secret material.
- **EC-22:** `ping`, `unsupported.star`, `installation_repositories.added/removed`, and the
  unknown/revoked-installation paths keep their existing statuses and ignore reasons after all six
  changes land.
- **EC-23:** Concurrent duplicate deliveries (same bytes, different delivery ids) arriving in
  parallel both return 2xx; the queue-side dedup, not the receiver, is what collapses them — the
  receiver makes no claim of exactly-once (see Open questions).

## Open questions

1. **Durable receiver-side replay protection.** AC-1 makes the dedup *identity* untamperable, but the
   windows that consume it are still bounded: SQS FIFO dedup is 5 minutes (the Python fleet's durable
   `(consumer_id, idempotency_key)` delivery store in `services/workers/messaging/idempotency.py`
   extends this to a real, persistent no-op for the ingestion side), and BullMQ's `jobId` record is
   erased by `enqueue`'s `removeOnComplete: true`. A persisted delivery log plus
   `removeOnComplete: { age }` is the audit's recommended fix
   (`docs/audits/deep-audit-2026-07-31/audit-04-webhooks-git.md`, MEDIUM) but was **not** filed as a
   gap; it needs a migration and a queue-wide behavior change. Confirm it is a separate ticket.
2. **`installation` lifecycle replay.** The `installation` branch (`deleted`/`suspend`/`unsuspend`)
   has no idempotency key at all, so a captured `unsuspend` delivery replays unbounded. Out of this
   gap list (W1-06 surface) — confirm where it lands.
3. **Body-digest identity vs. genuinely-identical bodies.** Two distinct deliveries with byte-identical
   bodies would now share one identity. GitHub bodies always carry distinguishing content (SHAs,
   `updated_at`), so the risk is judged negligible — flagging it because it is the one behavior this
   spec knowingly trades away.
4. **GAP-9 revisit trigger.** The 5 MB cap stays. If the warning added in AC-6 ever fires in a real
   environment, that is the signal to raise the limit toward GitHub's 25 MB (and to pair it with a
   streaming HMAC so the DoS profile doesn't move with it).

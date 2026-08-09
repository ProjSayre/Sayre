# Audit 08 — Realtime WebSocket Gateway (`services/gateway/`)

## VERDICT ON THE PUSH-TIME RE-FILTERING RULE: **ENFORCED**

> "Every WebSocket push is re-filtered through the receiving client's RBAC scope before delivery — don't assume a subscription-time check is sufficient for later pushes."

This rule is genuinely implemented, not just claimed. Evidence:

1. **Every fan-out does a per-connection, per-event authority call.**
   `services/gateway/src/fanout/fanout.ts:44-60` — `pushToConnection` is invoked once per
   matching connection per envelope and unconditionally calls `deps.fetchDelta(...)` before
   any `send`. There is no cached-delta path and no "authorized at subscribe time" shortcut.

2. **The gateway never asserts `org_id` itself; Core re-derives it from the forwarded token.**
   `services/gateway/src/coreClient.ts:41-58` sends only `repoId/changedPaths/fullRebuild/graphVersion`
   plus `Authorization: Bearer <conn.token>`. `services/core/src/routes/realtimeInternal.ts:31-44`
   re-runs `authenticate()` + `authorize('member')` and passes `requireAuthContext(req)` into
   `getRealtimeGraphDelta`, which delegates node visibility to the Graph Query Service
   (`services/core/src/services/realtimeDeltaService.ts:52`).

3. **Mid-session revocation/expiry is caught.** `verifySessionToken` verifies `exp`
   (`services/core/src/auth/sessionToken.ts:74`), so an expired token 401s on the *next push*,
   which surfaces as `CoreUnauthorizedError` and closes the socket
   (`fanout.ts:78-81` → `server.ts:46`).

4. **The gateway's own `registry.matching()` (`ws/connection.ts:60-64`) is a narrowing pre-filter
   only** (authenticated && org match && repo subscribed) — it never widens what Core authorized.
   No graph data reaches a socket without a Core round-trip; the only gateway-authored frames are
   `ready` / `subscribed` / `error` (`ws/connection.ts:100, 115, 198`), which carry no graph content.

5. Regression-tested end to end at `services/gateway/src/e2e.test.ts:199-234` (AC3: N events →
   N authority calls; a mid-stream `CoreUnauthorizedError` closes the socket without delivering).

**Caveat (not a rule violation, see MEDIUM-4 and MEDIUM-6):** when the gateway takes the
dev/test auto-accept branch (`ws/connection.ts:180-182`), `conn.token === ''`
(`ws/auth.ts:74`), so `coreClient.ts:55` omits the `Authorization` header entirely and Core's
`authenticate()` falls back to `devSessionContext()` with role `owner`
(`services/core/src/http/authenticate.ts:57-60`). The re-filter still *runs*, but against a
synthetic `owner` identity. Both sides are `NODE_ENV`-gated and fail closed, so this is a
correct-but-fragile design, not a live hole.

The real defects below are availability, resource-exhaustion, and durability bugs — not
authorization bugs.

---

### [SEVERITY: CRITICAL] No `'error'` listener on any WebSocket — one malformed frame from any client kills the whole gateway process
- **File:** `services/gateway/src/ws/connection.ts:191-227` (and `services/gateway/src/server.ts:59-62`)
- **Code:**
```ts
  socket.on('message', (raw: unknown) => { ... });

  socket.on('close', () => {
    clearAuthTimer();
    registry.remove(conn.id);
  });
}   // <-- no socket.on('error', ...) anywhere in the service
```
  and the only place a socket is ever wired up:
```ts
  wss.on('connection', (socket, req) => {
    const conn = createPendingConnection(randomUUID(), socket);
    attachConnectionLifecycle(conn, req, registry);   // registers 'message' + 'close' only
  });
```
  A repo-wide grep for `on('error'` across `services/gateway/src/**` returns **zero** matches.
- **Why it's wrong:** `ws`'s `WebSocket` is an `EventEmitter`, and it emits `'error'` on the
  socket for *client-controlled* protocol faults. `node_modules/ws/lib/websocket.js:1216-1220`
  (`receiverOnError`) and `:1297-1301` (`socketOnError`):
```js
  if (!websocket._errorEmitted) {
    websocket._errorEmitted = true;
    websocket.emit('error', err);
  }
```
  Node's `EventEmitter` **throws** an unhandled `'error'` event. Thrown from inside a socket
  data callback, that is an uncaught exception → process exit → **every connected client of
  every tenant is dropped, and the SQS consumer dies with it.**

  Trigger requires no authentication at all — the socket is live from the moment of upgrade and
  `registry.add(conn)` happens before any auth (`connection.ts:161`). Any of these does it:
  a frame with an RSV bit set, an invalid opcode, invalid UTF-8 in a text frame, an invalid
  close code, a payload exceeding `maxPayload`, or a plain TCP RST mid-frame. That is a
  one-packet, unauthenticated, whole-service DoS reachable from any host that can open the port.
- **Fix:** In `attachConnectionLifecycle`, add
  `socket.on('error', (err) => { console.error('[gateway] socket error', { connectionId: conn.id }, err); registry.remove(conn.id); socket.terminate(); });`
  (do **not** log `conn.token`). Also add `wss.on('error', ...)`, `server.on('clientError', ...)`,
  and a `process.on('uncaughtException')` / `process.on('unhandledRejection')` last-resort logger
  in `src/index.ts` so a single bad socket can never take the box down.

---

### [SEVERITY: HIGH] `isDevOrTestEnvironment()` throws when `NODE_ENV` is unset, synchronously inside the connection handler — crash on the first header-less connect
- **File:** `services/gateway/src/ws/connection.ts:180` → `services/gateway/src/ws/auth.ts:34-37`
- **Code:**
```ts
  } else if (isDevOrTest()) {                 // connection.ts:180
    applyIdentity(conn, devIdentity());
```
```ts
export function isDevOrTestEnvironment(): boolean {   // auth.ts:34
  const environment = getConfig('NODE_ENV');          // throws ConfigError if unset
  return environment === 'development' || environment === 'test';
}
```
- **Why it's wrong:** `NODE_ENV` has **no entry** in `DEFAULTS`
  (`packages/config/src/config.ts:64-130` — every other gateway setting has one), so
  `getConfig('NODE_ENV')` throws `ConfigError('Configuration NODE_ENV is missing.')`
  (`config.ts:158/178`). This call is synchronous, inside `attachConnectionLifecycle`, which
  `server.ts:59-62` calls synchronously from `wss.on('connection')`. The throw propagates out of
  the emit → uncaught exception → process exit.

  Concrete scenario: a container image shipped without an explicit `NODE_ENV` (very common —
  `infra/` sets it per compose file, a bare `node dist/index.js` does not). The gateway boots
  fine, passes `/health`, and dies on the first client that connects without an
  `Authorization` upgrade header — i.e. **every browser client**, since browsers cannot set
  that header on a WebSocket (`apps/web/app/workspace/state.tsx:838` uses the `auth` frame path).
  Crash-loop.
- **Fix:** Make the check total and fail closed:
  `const environment = getOptionalConfig('NODE_ENV'); return environment === 'development' || environment === 'test';`
  Better, resolve it **once at boot** in `startGateway()` and pass the boolean down, so a
  config fault is a startup failure rather than a per-connection crash.

---

### [SEVERITY: HIGH] Unbounded, unvalidated subscription set + no `maxPayload`, no rate limit, no connection cap — single-client OOM
- **File:** `services/gateway/src/ws/connection.ts:114`, `services/gateway/src/ws/protocol.ts:60-64`, `services/gateway/src/server.ts:57`
- **Code:**
```ts
  conn.repoSubscriptions.add(repoId); // Set -- duplicate subscribe is idempotent
```
```ts
    case 'subscribe':
      if (!nonEmptyString(candidate.repoId)) {
        throw new ProtocolError('subscribe frame requires a non-empty "repoId".');
      }
      return { type: 'subscribe', repoId: candidate.repoId };
```
```ts
  const wss = new WebSocketServer({ server });   // no maxPayload, no clientTracking limit
```
- **Why it's wrong:** `repoId` is an arbitrary client-supplied string with **no length bound, no
  format validation (not even a UUID check), no cap on set cardinality, and no check that the
  repo belongs to the caller's org.** There is no per-connection message rate limit, no
  per-user/per-IP connection cap, and no global connection cap.

  `ws`'s default `maxPayload` is 100 MiB (`node_modules/ws/lib/websocket-server.js:74`,
  `maxPayload: 100 * 1024 * 1024`) and `server.ts:57` does not override it. So one authenticated
  socket can send `{"type":"subscribe","repoId":"<100MB of A>"}` repeatedly and each accepted
  string is retained in `conn.repoSubscriptions` for the life of the connection. Alternatively,
  millions of small unique random `repoId`s achieve the same growth. Heap exhaustion → OOM kill
  → realtime down for every tenant. Note `subscribe` is also *echoed back*
  (`connection.ts:115`), so the attacker pays no cost.

  The org-ownership gap is not currently a data leak (fan-out re-checks `org_id` and Core
  re-filters), but it means the key space of that Set is entirely attacker-controlled.
- **Fix:** `new WebSocketServer({ server, maxPayload: 64 * 1024 })`. Validate `repoId` against
  `UUID_RE` in `protocol.ts` (the same regex `services/core/src/auth/sessionToken.ts:21` uses).
  Cap `repoSubscriptions.size` (e.g. 100) and return an `error` frame past the cap. Add a
  token-bucket inbound-frame limiter per connection and a per-user/per-IP connection cap
  enforced at upgrade.

---

### [SEVERITY: HIGH] No ping/pong heartbeat or idle timeout — half-open sockets leak forever and multiply Core load per event
- **File:** `services/gateway/src/ws/connection.ts:224-227`, `services/gateway/src/server.ts:57-62`
- **Code:**
```ts
  socket.on('close', () => {
    clearAuthTimer();
    registry.remove(conn.id);      // the ONLY path that ever removes a connection
  });
```
  A grep for `ping|pong|heartbeat` across `services/gateway/src/**` returns zero matches.
- **Why it's wrong:** A half-open TCP connection (laptop sleeps, NAT/LB idle-reaps the flow,
  network partition) never delivers a FIN, so `'close'` never fires and `registry.remove` never
  runs. `ws` does **not** detect this on its own — the documented mitigation is an application-level
  `ping`/`pong` liveness sweep, which does not exist here.

  Two compounding failures:
  1. **Memory + credential leak.** The `GatewayConnection` stays in the `Map` indefinitely,
     holding a live bearer token (`connection.ts:26 token: string`) with no TTL. Over days of
     mobile/flaky clients the registry only grows.
  2. **Core load amplification.** `registry.matching()` (`connection.ts:60-64`) keeps selecting
     these zombies, so `pushToConnection` (`fanout.ts:51`) issues a full Core HTTP round-trip —
     which runs a Graph Query Service RBAC traversal — for **every zombie on every
     `graph.updated` event, forever**, writing the result into a socket that will never drain.
     With `maxConcurrency: 16` (`fanout.ts:33`), a few hundred zombies serialize real clients'
     pushes behind dead ones and blow the 15s delivery target.
- **Fix:** Add a `setInterval` sweep in `startGateway()`: mark `conn.isAlive = false` and
  `socket.ping()` on every tick; `socket.on('pong', () => { conn.isAlive = true; })`; on the next
  tick `socket.terminate()` + `registry.remove(conn.id)` for anything still `false`. Clear the
  interval in `wss.on('close')`. Also add an absolute idle timeout so a socket that never
  subscribes is reaped.

---

### [SEVERITY: HIGH] SQS message is deleted after the Redis *publish*, not after fan-out — silent event loss, and two code comments assert the opposite guarantee
- **File:** `services/gateway/src/server.ts:50-53` + `services/gateway/src/sqs/consumer.ts:143-158`
- **Code:**
```ts
  const consumer = createRealtimeSqsConsumer({
    queueName: getRealtimeQueueName(),
    onEnvelope: (envelope) => bus.publish(envelope),   // resolves as soon as PUBLISH returns
  });
```
```ts
    try {
      await opts.onEnvelope(envelope);
    } catch (err) { ... return; }

    try {
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
```
- **Why it's wrong:** Redis pub/sub is fire-and-forget with **zero persistence and zero delivery
  guarantee** — `PUBLISH` returns the count of subscribers reached (which may be `0`) and that
  return value is discarded (`redis/pubsub.ts:83`). The SQS message is then deleted. If no
  gateway instance is subscribed at that instant — a rolling deploy, all pods restarting, or a
  subscriber connection dropped mid-reconnect (`pubsub.ts:67`, `maxRetriesPerRequest: null`
  means it retries silently and the resubscribe window is a real gap) — the `graph.updated`
  event is **gone from the system**. Same outcome if fan-out itself throws: `fanout.ts:89`
  rethrows, and `pubsub.ts:76-78` merely logs it — the SQS message is already deleted.

  Every connected client's canvas silently goes stale with no resync signal, and the graph-is-
  source-of-truth invariant is violated from the user's perspective until they hard-reload.

  Worse, two comments state the opposite as a guarantee:
  - `server.ts:73-75`: *"No SQS message is deleted without having been fanned out (see sqs/consumer.ts's stop())."*
  - `consumer.ts:22-23`: *"A successfully fanned-out message is deleted exactly once."*

  Neither is true. This is the kind of false invariant that a later reader will build on.
- **Fix:** Either (a) make `onEnvelope` await actual fan-out on this instance and accept that
  multi-instance delivery is best-effort, or (b) keep Redis for cross-instance fan-out but stop
  claiming durability: check the `PUBLISH` subscriber count, treat `0` as a failure (leave the
  message for redrive), and correct both comments. Longer term, an ack-per-instance design or
  a Redis Stream (consumer groups, persisted) is the right shape. At minimum, fix the comments
  now — they are actively misleading.

---

### [SEVERITY: MEDIUM] No Origin check on the WebSocket upgrade
- **File:** `services/gateway/src/server.ts:57`
- **Code:**
```ts
  const wss = new WebSocketServer({ server });
```
  No `verifyClient`, no origin allowlist, no `GATEWAY_ALLOWED_ORIGINS` config entry
  (`packages/config/src/config.ts:2-59` has `MCP_ALLOWED_ORIGINS` for the MCP surface —
  the gateway has no analogue).
- **Why it's wrong:** Any page on the internet can open a socket to the gateway. The full
  cross-site-WebSocket-hijacking impact is limited because auth is bearer-token based rather
  than cookie-based (`ws/auth.ts:27-32` reads only the `Authorization` header;
  `apps/web/app/workspace/state.tsx:838` sends an explicit `auth` frame), so an attacker page
  cannot inherit an identity. Two residual impacts remain:
  1. **In any `NODE_ENV=development`/`test` deployment**, `connection.ts:180-182` auto-accepts a
     header-less socket as `DEV_ORG_ID` with role `owner` (`ws/auth.ts:65-75`). A malicious page
     opened by anyone on that network reads that org's realtime graph deltas cross-origin with
     no credential at all.
  2. **In production**, it is free unauthenticated socket squatting, which is the delivery
     vehicle for the CRITICAL crash above and the HIGH exhaustion findings — no origin gate means
     no cheap chokepoint in front of either.
- **Fix:** Add `GATEWAY_ALLOWED_ORIGINS` (JSON array, defaulting to `[]` = reject browser
  origins, mirroring `MCP_ALLOWED_ORIGINS`'s fail-closed posture at `config.ts:127-129`) and
  enforce it in a `verifyClient`/`server.on('upgrade')` handler before the handshake completes.

---

### [SEVERITY: MEDIUM] Re-authentication overwrites the connection identity in place but leaves the previous org's subscriptions attached
- **File:** `services/gateway/src/ws/connection.ts:71-77` and `:204-213`
- **Code:**
```ts
function applyIdentity(conn: GatewayConnection, identity: ConnectionIdentity): void {
  conn.orgId = identity.orgId;
  conn.roles = identity.roles;
  conn.userId = identity.userId;
  conn.token = identity.token;
  conn.authenticated = true;
}                                  // conn.repoSubscriptions is NOT touched
```
```ts
      if (message.type === 'auth') {
        const reply = await handleAuthFrame(conn, message.token, deps);   // accepted at ANY time
```
- **Why it's wrong:** An `auth` frame is accepted at any point in the connection's life, not just
  first. A client that authenticates as org A, subscribes to org A's repos, then re-authenticates
  with a valid org B token ends up with `conn.orgId = B` while `repoSubscriptions` still holds
  org A's repo IDs. It does not currently leak — `registry.matching()` requires *both* an org
  match and a repo match, and Core re-filters regardless — but this is exactly the stale
  per-connection authorization state the security rule exists to prevent, and it is one repo-ID
  collision (or one future relaxation of the coarse match) away from being a cross-tenant leak.
  `conn.roles` is likewise frozen at first-auth and never refreshed; it is unused today, which
  makes it a trap for the next person who reaches for it.
- **Fix:** In `applyIdentity`, `conn.repoSubscriptions.clear()` whenever
  `identity.orgId !== conn.orgId || identity.userId !== conn.userId`. Better, reject a second
  `auth` frame outright on an already-authenticated connection and require a reconnect — the web
  client (`apps/web/app/workspace/state.tsx:838`) only ever auths once.

---

### [SEVERITY: MEDIUM] SQS consumer loop dies permanently on a startup-path error, and `/health` still reports `ok`
- **File:** `services/gateway/src/sqs/consumer.ts:181-196`, `services/gateway/src/health.ts:4-6`
- **Code:**
```ts
  async function pollLoop(): Promise<void> {
    const client = await getClient();        // outside the while -- one shot
    const url = await getQueueUrl(client);   // outside the while -- one shot
    while (!stopped) {
      await pollOnce(client, url);
    }
  }
  ...
    start(): void {
      if (!stopped) return;
      stopped = false;
      loopPromise = pollLoop().catch((err) => {
        console.error('[gateway] realtime SQS consumer loop crashed', err);   // log and give up
      });
    },
```
```ts
export function getGatewayHealth(): HealthStatus {
  return { status: 'ok', service: 'gateway', version: '0.1.0', timestamp: new Date().toISOString() };
}
```
- **Why it's wrong:** `getClient()` and `getQueueUrl()` run once, outside the retry loop. Any
  transient failure there — LocalStack/AWS not reachable yet at boot (a near-certain race in
  `docker compose up`), a not-yet-created queue, a credential blip — rejects `pollLoop()`. The
  `.catch` logs one line and the consumer is **dead for the entire lifetime of the process**:
  no retry, no restart, no crash. `pollOnce` has its own try/catch + backoff (`:172-176`), so
  once the loop is running it is resilient; getting into the loop is not.

  Because `getGatewayHealth()` is a hard-coded `status: 'ok'` that dials nothing, no orchestrator
  liveness/readiness probe will ever notice. The gateway happily accepts WebSocket connections,
  answers `auth`/`subscribe`, and silently never delivers a single `graph.delta`. Debugging this
  from the frontend means chasing "realtime just doesn't work" with a green health check.
- **Fix:** Move `getClient()`/`getQueueUrl()` inside the `while (!stopped)` loop with the same
  1s backoff `pollOnce` uses, and null out `queueUrl`/`clientPromise` on failure so they are
  re-resolved. Track a `consumerHealthy` flag plus a `lastSuccessfulPollAt` timestamp and surface
  both from `getGatewayHealth()` (a readiness signal, not liveness — keep the `/health` liveness
  posture but add `/ready` or a `details` block).

---

### [SEVERITY: MEDIUM] Neither ioredis connection has an `'error'` listener — a dead Redis subscriber is invisible (and is the same unhandled-`'error'` crash class as the CRITICAL)
- **File:** `services/gateway/src/redis/pubsub.ts:67-79`
- **Code:**
```ts
  const subscriber = await createRedisConnection(factory);
  const publisher = await createRedisConnection(factory);

  let handler: ... = null;

  subscriber.on('message', (receivedChannel, message) => {   // the ONLY listener attached
```
- **Why it's wrong:** Both clients are created with `maxRetriesPerRequest: null`
  (`pubsub.ts:48`), meaning they retry connection failures indefinitely and emit `'error'` while
  doing so. No `'error'` listener is attached to either. Depending on ioredis's internal
  `silentEmit` path, this is either (a) an unhandled `'error'` on an `EventEmitter` → uncaught
  exception → same whole-process crash as the CRITICAL finding, or (b) silently swallowed. **Both
  outcomes are bugs**, and (b) is arguably the worse one operationally: the module header
  (`pubsub.ts:8-13`) relies on ioredis auto-resubscribing after a reconnect, but nothing observes
  whether that ever happened. Combined with the static `/health` (see previous finding), a
  permanently disconnected subscriber is completely invisible — the gateway serves WebSocket
  clients and delivers nothing.
- **Fix:** Attach `subscriber.on('error', ...)` and `publisher.on('error', ...)` with structured
  logging (never log `password`). Track `subscriber.status` and expose it via health/readiness.
  Add `subscriber.on('end', ...)` / `on('reconnecting', ...)` counters so a resubscribe gap is
  measurable rather than assumed.

---

### [SEVERITY: MEDIUM] Unhandled promise rejection in the inbound-message handler
- **File:** `services/gateway/src/ws/connection.ts:191-221` and `:173-179`
- **Code:**
```ts
  socket.on('message', (raw: unknown) => {
    void (async () => {                       // no .catch()
      ...
      } catch (err) {
        if (err instanceof ProtocolError) { ...; return; }
        throw err;                            // -> unhandled rejection
      }
```
```ts
  if (headerToken) {
    void handleAuthFrame(conn, headerToken, deps).then((reply) => {   // no .catch()
```
- **Why it's wrong:** `void (async () => {...})()` discards the promise, so any throw inside it
  becomes an unhandled rejection. Node 20 (`package.json:34 "node": ">=20 <21"`) defaults to
  `--unhandled-rejections=throw`, which means **process exit**. The explicit `throw err` at
  `:201` is the intended non-`ProtocolError` escape hatch; `protocol.ts` is currently careful
  enough that it should not fire, but the safety of the entire process rests on that being true
  forever. The `:173` chain has the same shape — a throw inside the `.then` callback
  (`sendSafe`, `socket.close`) is unhandled. `src/index.ts:29-32` catches only the *startup*
  rejection; there is no `process.on('unhandledRejection')` guard.
- **Fix:** Attach `.catch((err) => { console.error('[gateway] message handler failed', { connectionId: conn.id }, err); socket.close(1011, 'internal error'); })` to both, replace the
  bare `throw err` with the same close-with-1011 handling, and add process-level
  `unhandledRejection` / `uncaughtException` logging in `src/index.ts`.

---

### [SEVERITY: LOW] `unsubscribe` (and any future message type) is dispatched without an authentication check
- **File:** `services/gateway/src/ws/connection.ts:215-220`, `:119-121`
- **Code:**
```ts
      if (message.type === 'subscribe') {
        sendSafe(socket, handleSubscribe(conn, message.repoId));   // gated inside handleSubscribe
        return;
      }

      handleUnsubscribe(conn, message.repoId);   // fall-through: NO auth check, no type check
```
```ts
export function handleUnsubscribe(conn: GatewayConnection, repoId: string): void {
  conn.repoSubscriptions.delete(repoId);
}
```
- **Why it's wrong:** Only `subscribe` is gated (inside `handleSubscribe`, `:107-113`). The final
  statement is an unguarded fall-through, so an unauthenticated socket has a reachable
  state-mutating path. Harmless today (it deletes from its own empty Set), but the fall-through
  will silently accept — with an authenticated-caller's privileges implied — any new member added
  to `ClientToGatewayMessage` that someone forgets to guard.
- **Fix:** Make the dispatch an exhaustive `switch (message.type)` with a `default: never` arm,
  and move the `conn.authenticated` check to the top of the handler for every type except `auth`.

---

### [SEVERITY: LOW] Inbound frames are processed concurrently and can complete out of order
- **File:** `services/gateway/src/ws/connection.ts:191-221`
- **Code:**
```ts
  socket.on('message', (raw: unknown) => {
    void (async () => {
      ...
      if (message.type === 'auth') {
        const reply = await handleAuthFrame(conn, message.token, deps);   // async gap
```
- **Why it's wrong:** Each frame gets an independent async IIFE with no serialization. A client
  that pipelines `auth` then `subscribe` without waiting for `ready` gets a spurious
  `{type:'error', code:'unauthenticated'}` because `handleAuthFrame`'s `await` (which does a
  `getSecret` + `jwt.verify`) has not resolved when the `subscribe` frame is dispatched. The
  e2e test (`e2e.test.ts:81-93`) round-trips each frame, so this is invisible to the suite.
  Two concurrent `auth` frames also race on `applyIdentity` with last-writer-wins on
  `conn.orgId`/`conn.token`, which interacts badly with the stale-subscriptions finding above.
- **Fix:** Serialize per connection — chain each handler onto a `conn.pending` promise, or set an
  `authInFlight` flag and queue/reject frames received while auth is resolving.

---

### [SEVERITY: LOW] Redis channel is global rather than org-scoped — tenant isolation is procedural, not structural
- **File:** `packages/config/src/config.ts:98`, `services/gateway/src/redis/pubsub.ts:89`
- **Code:**
```ts
  GATEWAY_REDIS_CHANNEL: 'sayre:graph.updated',
```
```ts
      handler = next;
      await subscriber.subscribe(channel);   // one channel, all orgs, all instances
```
- **Why it's wrong:** Every gateway instance in the fleet receives every tenant's
  `graph.updated` envelope, and the *only* thing keeping org A's event off org B's socket is the
  in-process string comparison at `ws/connection.ts:62` (`conn.orgId === orgId`). That comparison
  is correct today, and Core re-filters behind it, so this is not a live leak. But
  `.claude/rules/security-multitenancy.md` opens with "Tenant isolation is **structural**" — here
  it is one `if` away from a cross-tenant broadcast, with no second layer inside the gateway.
  It also means every instance decodes and discards N-1 tenants' traffic.
- **Fix:** Publish to `sayre:graph.updated:<org_id>` and have each instance maintain
  `SUBSCRIBE`s only for the orgs it currently holds connections for (subscribe on first
  connection for an org, unsubscribe when the last one for that org closes). Cross-tenant
  delivery then becomes impossible at the transport layer, not merely filtered.

---

### [SEVERITY: LOW] Core's delta response is cast without validation; a malformed response aborts fan-out for a slice of connections
- **File:** `services/gateway/src/coreClient.ts:72`, `services/gateway/src/fanout/fanout.ts:63, 110-116`
- **Code:**
```ts
  return (await response.json()) as RealtimeGraphDelta;   // blind cast, no runtime guard
```
```ts
    if (delta.resyncRequired || delta.removals.length > 0) {
```
- **Why it's wrong:** Every other trust boundary in this service has a runtime guard
  (`assertValidEnvelope` for SQS and Redis, `decodeClientMessage` for client frames) — the Core
  HTTP boundary has none. If Core ever returns a body without `removals` (a partial response, an
  HTML error page served with a 200 by a proxy, a contract drift), `delta.removals.length`
  throws `TypeError`. That is neither `CoreUnauthorizedError` nor `CoreUnavailableError`, so
  `fanout.ts:89` rethrows, which kills that worker's `while` loop (`:110-116`) — **every
  connection still queued behind that worker silently gets no push for this event**, while the
  other 15 workers continue. The rejection is swallowed by `pubsub.ts:76-78` with a single log
  line, so the partial delivery is invisible.
- **Fix:** Add an `assertValidGraphDelta(parsed)` guard in `coreClient.ts` (same shape as
  `assertValidEnvelope`) that throws `CoreUnavailableError` on a shape mismatch, so it lands in
  the existing skip-this-push branch. Separately, wrap the `await pushToConnection(...)` in
  `worker()` in a try/catch so one connection's failure never truncates the rest of that
  worker's queue.

---

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 1 |
| HIGH | 4 |
| MEDIUM | 5 |
| LOW | 4 |

**The authorization model is the strongest part of this service** — per-push, per-connection
re-filtering through Core is correctly implemented, correctly documented, and correctly tested,
and the gateway never asserts `org_id` on its own behalf. The defects are concentrated in
operational robustness: the process has no error listeners on either its WebSockets or its Redis
clients, no liveness sweep, no resource bounds, and a health check that cannot report any of the
ways the service silently stops working.

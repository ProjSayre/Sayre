# CH-05 — Gateway realtime chat events

## Ticket Check

**What I'm about to build**
When you ask Sayre a question in the chat sidebar, the answer currently only appears if you
reload the page. This makes the progress updates ("Preparing…", "looking up this file…") and the
final answer arrive live, as they happen, for the person who asked — and only that person.

**What I'm explicitly not doing**
No chat sidebar UI (that is a separate, parallel piece of work), no word-by-word typing effect,
and no history/replay — if you close the tab mid-answer, reopening it re-reads the saved
conversation from the normal chat screen rather than replaying the live feed. I am also not
changing anything about the existing live-updating codebase map.

**How you'll know it worked**
Ask a question in a conversation you own and watch the answer arrive without touching the page:
first the small progress lines, then the answer with its list of cited files. Then have a
teammate (same company, different account) try to listen in on your conversation — they get a
flat refusal and never see a single line of it. Finally, if someone's access to part of the
codebase is taken away, any file references they are no longer allowed to see stop appearing in
answers that get delivered to them from that moment on, even for a conversation they were
already watching.

**What I had to guess**
1. A cited file has two identifiers on it: the thing being cited, and an optional "click here to
   see this on the map" pointer. The ticket says to strip citations the reader isn't allowed to
   see. I chose the strict reading: if *either* identifier is off-limits, the whole citation is
   removed rather than half-shown. That is safer but it means an occasional citation disappears
   because its map-pointer, not the file itself, was off-limits.
2. The answer text itself is written prose and can mention a filename in a sentence. I do not
   rewrite or censor that prose — only the structured citation list is filtered. The prose was
   generated under the asker's own access at the time they asked.
3. The "who owns this conversation / what are they allowed to see" question cannot be answered by
   the realtime relay itself, so I am adding one narrow, internal-only question the relay asks the
   main API before every single delivery. That is a small addition to the main API, not just the
   relay.

## Goal

Relay CH-04's `chat.turn.progress` / `chat.turn.completed` / `chat.turn.error` Redis pub/sub
events to the owning client's live WebSocket connection, under a per-push RBAC re-filter, using
the pinned client-facing frame shapes that CH-06 builds against.

## Scope

**In**

- A per-conversation client subscribe/unsubscribe protocol (`{ type:'subscribe', channel:'chat',
  conversationId }`) layered onto the gateway's existing `decodeClientMessage` /
  `attachConnectionLifecycle` handshake, with server-side owner verification.
- A per-conversation Redis `SUBSCRIBE` on `sayre:chat.events:{orgId}:{conversationId}`,
  reference-counted across connections, with balanced `UNSUBSCRIBE` on unsubscribe/disconnect.
- Strict envelope/payload/channel validation and drop-with-log of anything that fails it.
- A per-push RBAC re-filter: every single delivery (progress, completed and error alike) re-asks
  Core, over the connection's own forwarded bearer token, whether this subject still owns the
  conversation and which of the event's citation node ids they may currently see.
- Fan-out to matching connections with the pinned client frames, built field-by-field so the wire
  shape is exactly the pinned key set.
- The one Core-side addition that makes the above possible: an internal-only
  `POST /internal/realtime/chat-authorization` endpoint, its service function, and one narrow
  Graph Query Service method behind it.

**Out**

- `apps/web` — the chat panel UI is CH-06's, running in parallel. **No file under `apps/web/`
  may be touched by this ticket.**
- Event persistence / replay / catch-up. CH-03's `GET /chat/conversations/:conversationId` REST
  read is the catch-up path; the gateway keeps no buffer and replays nothing after a reconnect.
- Token-level streaming of the answer.
- Redacting the free-text `answer` markdown. Only the structured `citations` array is filtered.
  The markdown was generated under the asker's own MCP scope at generation time (CH-01/CH-04);
  attempting to redact prose server-side is not a solvable filter and is explicitly not attempted
  here. Documented as a known boundary, same posture as `fanout/fanout.ts`'s O-3 note.
- Any change to the existing `graph.updated` fan-out behaviour, `GraphUpdatedBus`,
  `fanOutGraphUpdated`, the SQS consumer, or the existing repo-scoped `subscribe`/`unsubscribe`
  frames. Those are strictly additive-compatible; every existing gateway test must pass unchanged.
- Any new config/env name. The chat channel prefix is a **code constant on both sides** (see
  `sayre_workers/chat/models.py`'s `CHAT_EVENT_CHANNEL_PREFIX` and the `infra/.env.example`
  comment block that documents this exact convention). No `packages/config` `CONFIG_NAMES` entry,
  no `.env.example` change.

## Affected files

### New

| Path | Purpose |
| --- | --- |
| `services/gateway/src/ws/chatEvents.ts` | Pure (no I/O) channel-name, envelope and payload decoding + citation filtering for the three chat event types. |
| `services/gateway/src/ws/chatEvents.test.ts` | Unit tests for the above. |
| `services/gateway/src/redis/chatPubsub.ts` | `ChatEventBus`: one dedicated ioredis subscriber connection with refcounted per-conversation `SUBSCRIBE`/`UNSUBSCRIBE` and per-channel ordered handler dispatch. |
| `services/gateway/src/redis/chatPubsub.test.ts` | Unit tests for the above (uses the existing `FakeRedis` convention). |
| `services/gateway/src/fanout/chatFanout.ts` | `relayChatEvent`: per-connection, per-push RBAC re-filter + send. Sibling of `fanout/fanout.ts`. |
| `services/gateway/src/fanout/chatFanout.test.ts` | Unit tests for the above. |
| `services/gateway/src/chatE2e.test.ts` | In-process real-`ws`-client end-to-end test, mirroring `src/e2e.test.ts`'s structure. |
| `services/core/src/services/realtimeChatService.ts` | Core service function: owner check + citation-node authorization. |
| `services/core/src/services/realtimeChatService.test.ts` | Unit tests for the above. |

### Modified

| Path | Change |
| --- | --- |
| `packages/shared-types/src/index.ts` | Add the CH-05 wire contracts; extend `ClientToGatewayMessage` / `GatewayToClientMessage`. |
| `services/gateway/src/ws/protocol.ts` | Accept the `channel:'chat'` subscribe/unsubscribe variants; add `isChatChannelMessage`. |
| `services/gateway/src/ws/protocol.test.ts` | Add cases for the new frames; existing cases unchanged. |
| `services/gateway/src/ws/connection.ts` | `chatSubscriptions` on `GatewayConnection`; `matchingChat` on `ConnectionRegistry`; `handleChatSubscribe`/`handleChatUnsubscribe`/`releaseChatSubscriptions`; dispatch + close wiring. |
| `services/gateway/src/ws/connection.test.ts` | Add cases; all existing cases must pass unchanged. |
| `services/gateway/src/coreClient.ts` | Add `CoreForbiddenError` + `fetchChatPushAuthorization`. |
| `services/gateway/src/coreClient.test.ts` | Add cases; existing cases unchanged. |
| `services/gateway/src/redis/pubsub.ts` | Export the existing module-private `createRedisConnection` so `chatPubsub.ts` reuses it verbatim rather than copying the `REDIS_PORT`/`getSecret` logic. **No other change.** |
| `services/gateway/src/server.ts` | Construct the chat bus; pass the chat deps to `attachConnectionLifecycle`; wire `bus.onEvent -> relayChatEvent`; close the bus in `close()`. |
| `services/core/src/graph-query/types.ts` | Add the `ChatCitationGraphQueryService` narrow interface. |
| `services/core/src/graph-query/index.ts` | Add `GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER`, `CHAT_CITATION_NODE_ID_LIMIT`, `RbacGraphQueryService.getAuthorizedNodeIds`, and the interface on the class + `graphQueryService` type union. |
| `services/core/src/graph-query/index.test.ts` | Add cases for the new query/mapper. |
| `services/core/src/services/chatService.ts` | Change `function requireConversationId` to `export function requireConversationId` — **export-only change, no behaviour change** — so the new service reuses the exact same UUID/existence-non-disclosure check. |
| `services/core/src/http/realtimeDeltaRequest.ts` | Add `parseRealtimeChatAuthorizationRequest`, reusing the existing `RealtimeDeltaParseError` (already mapped to HTTP 400 in `http/express.ts`, so `express.ts` needs no change). |
| `services/core/src/routes/realtimeInternal.ts` | Add the `POST /internal/realtime/chat-authorization` route (3 statements — within the `src/routes/**` `max-statements: 10` lint gate). |
| `services/core/src/routes/realtimeInternal.test.ts` | Add cases; existing cases unchanged. |

`services/core/src/app.ts` needs **no** change: `realtimeInternalRouter` is already mounted.
`services/gateway/src/config.ts` needs **no** change (see Scope → out).

## Interfaces / signatures

### `packages/shared-types/src/index.ts` (additions)

```ts
// --- CH-05: realtime "Ask Sayre" chat events (gateway <-> browser) ---

/** Mirrors sayre_workers/chat/models.py's CitationKind. */
export type ChatCitationKind = 'file' | 'folder' | 'feature' | 'ticket';

export interface ChatCitation {
  nodeId: string;
  label: string;
  kind: ChatCitationKind;
  resolvedNodeId: string | null;
}

export interface ChatTurnMetrics {
  contextNodes: number;
  tokensUsed: number;
  baselineTokens: number;
  ratio: number;
}

/** PINNED (CH-06 builds against these three verbatim). Key set is the contract. */
export interface ChatTurnProgressPush {
  type: 'chat.turn.progress';
  conversationId: string;
  turnId: string;
  seq: number;
  kind: 'status' | 'tool_call';
  tool: string | null;
  detail: string | null;
  ts: string; // ISO 8601, relayed verbatim from the worker
}

export interface ChatTurnCompletedPush {
  type: 'chat.turn.completed';
  conversationId: string;
  turnId: string;
  answer: string; // markdown
  citations: ChatCitation[];
  metrics: ChatTurnMetrics; // counts as reported by the worker; never recomputed
  ts: string;
}

export interface ChatTurnErrorPush {
  type: 'chat.turn.error';
  conversationId: string;
  turnId: string;
  code: string;
  message: string;
  ts: string;
}

export type ChatTurnPush = ChatTurnProgressPush | ChatTurnCompletedPush | ChatTurnErrorPush;

/** Core internal request body (data plane only — NEVER carries org_id or userId;
 *  Core re-derives both server-side from the forwarded session token). */
export interface RealtimeChatAuthorizationRequest {
  conversationId: string;
  nodeIds: string[];
}

export interface RealtimeChatAuthorization {
  conversationId: string;
  /** The subset of the requested nodeIds this ctx may currently read. Order/dedup unspecified. */
  authorizedNodeIds: string[];
}
```

and the two existing unions become:

```ts
export type ClientToGatewayMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; repoId: string }
  | { type: 'unsubscribe'; repoId: string }
  | { type: 'subscribe'; channel: 'chat'; conversationId: string }
  | { type: 'unsubscribe'; channel: 'chat'; conversationId: string };

export type GatewayToClientMessage =
  | { type: 'ready' }
  | { type: 'subscribed'; repoId: string }
  | { type: 'graph.delta'; repoId: string; graphVersion: number; upserts: CanvasNode[]; removals: string[] }
  | { type: 'graph.resync'; repoId: string; graphVersion: number }
  | { type: 'subscribed'; channel: 'chat'; conversationId: string }
  | ChatTurnPush
  | { type: 'error'; code: string; message: string };
```

### `services/gateway/src/ws/chatEvents.ts` (new)

```ts
/** Code constant on BOTH sides — mirrors sayre_workers/chat/models.py's
 *  CHAT_EVENT_CHANNEL_PREFIX. Deliberately not a packages/config name. */
export const CHAT_EVENT_CHANNEL_PREFIX = 'sayre:chat.events';

/** Mirrors the `source` every CH-04 chat event carries (sayre_workers/chat/events.py). */
export const CHAT_EVENT_SOURCE = 'sayre-chat-worker';

/** Mirrors sayre_workers/chat/models.py's CHAT_MAX_CITATIONS. */
export const CHAT_MAX_CITATIONS = 24;

/** Mirrors sayre_workers/chat/events.py's chat_event_channel(). */
export function chatEventChannel(orgId: string, conversationId: string): string;

export interface ChatChannelCoordinates {
  orgId: string;
  conversationId: string;
}

/** Strict parse of `sayre:chat.events:{orgId}:{conversationId}`; null when it does not match. */
export function parseChatEventChannel(channel: string): ChatChannelCoordinates | null;

export interface DecodedChatEvent {
  /** ALWAYS envelope.org_id (cross-checked against the channel) — never a body field. */
  orgId: string;
  conversationId: string;
  turnId: string;
  push: ChatTurnPush;
}

/**
 * The single validation gate for anything arriving on a chat channel. Returns
 * null (never throws) for: a non-JSON / assertValidEnvelope-failing envelope; an
 * unparsable channel; envelope.org_id !== the channel's org segment;
 * envelope.source !== CHAT_EVENT_SOURCE; an envelope.type outside the three
 * pinned types; payload.conversationId !== the channel's conversation segment; or
 * any structurally invalid payload for its type. Logs the channel name and a
 * fixed reason ONLY — never payload content.
 */
export function decodeChatEvent(channel: string, rawMessage: string): DecodedChatEvent | null;

/** De-duplicated nodeId + non-null resolvedNodeId ids, first-appearance order. `[]` for progress/error. */
export function citationNodeIds(push: ChatTurnPush): string[];

/**
 * Returns a NEW completed push whose `citations` keeps only entries where
 * `nodeId` is authorized AND (`resolvedNodeId` is null OR also authorized).
 * `metrics` is copied through unchanged (counts stay as reported).
 */
export function filterCitations(
  push: ChatTurnCompletedPush,
  authorizedNodeIds: ReadonlySet<string>,
): ChatTurnCompletedPush;
```

### `services/gateway/src/ws/protocol.ts` (modified)

`decodeClientMessage`'s `'subscribe'` / `'unsubscribe'` cases gain a channel branch **before** the
existing `repoId` check, so the existing frames decode byte-identically:

```ts
// case 'subscribe' / 'unsubscribe':
//   if (candidate.channel === undefined) -> existing repoId path, UNCHANGED
//   if (candidate.channel === 'chat')    -> require non-empty string conversationId
//   otherwise                            -> throw new ProtocolError('Unknown "channel".')
```

plus:

```ts
export function isChatChannelMessage(
  message: ClientToGatewayMessage,
): message is Extract<ClientToGatewayMessage, { channel: 'chat' }>;
```

### `services/gateway/src/ws/connection.ts` (modified)

```ts
export interface GatewayConnection {
  // ...unchanged fields...
  repoSubscriptions: Set<string>;
  chatSubscriptions: Set<string>; // NEW — conversation ids, owner-verified at subscribe time
  authenticated: boolean;
}

export class ConnectionRegistry {
  // ...unchanged...
  /** authenticated && orgId match && conversationId is in the connection's chat subscriptions. */
  matchingChat(orgId: string, conversationId: string): GatewayConnection[];
}

/** The error code the client sees for ANY rejected/revoked chat subscription. One code for
 *  "not yours" and "does not exist" alike — CH-03's existence-non-disclosure posture. */
export const CHAT_FORBIDDEN_CODE = 'chat_forbidden';
export const CHAT_FORBIDDEN_MESSAGE = 'Conversation not found.';

export interface ChatSubscriptionDeps {
  /** true iff Core confirms this connection's subject currently owns the conversation. */
  authorizeChatSubscription: (conn: GatewayConnection, conversationId: string) => Promise<boolean>;
  acquireChatChannel: (orgId: string, conversationId: string) => Promise<void>;
  releaseChatChannel: (orgId: string, conversationId: string) => Promise<void>;
}

export async function handleChatSubscribe(
  conn: GatewayConnection,
  conversationId: string,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<GatewayToClientMessage>;

export async function handleChatUnsubscribe(
  conn: GatewayConnection,
  conversationId: string,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<void>;

/** Releases every chat channel this connection holds and clears the set. Idempotent. */
export async function releaseChatSubscriptions(
  conn: GatewayConnection,
  deps: Partial<ChatSubscriptionDeps>,
): Promise<void>;

export interface AttachConnectionDeps
  extends Partial<HandleAuthDeps>, Partial<ChatSubscriptionDeps> {
  isDevOrTest?: () => boolean;
  devIdentity?: () => ConnectionIdentity;
  authTimeoutMs?: number;
}
```

### `services/gateway/src/coreClient.ts` (modified)

```ts
/** Core says this subject is not (or is no longer) the conversation's owner — 403 or 404.
 *  404 and 403 map to the SAME error: Core never distinguishes absent from unowned. */
export class CoreForbiddenError extends Error {
  constructor(message?: string); // name = 'CoreForbiddenError'
}

export interface FetchChatPushAuthorizationArgs {
  baseUrl: string;
  token: string; // forwarded client bearer token; NEVER logged
  conversationId: string;
  nodeIds: readonly string[]; // [] for progress/error pushes and for subscribe-time checks
}

/**
 * POSTs a RealtimeChatAuthorizationRequest to
 * `${baseUrl}/internal/realtime/chat-authorization` with `Authorization: Bearer <token>`
 * (only when `token` is non-empty — same dev/test rule as fetchAuthorizedDelta).
 * Sends conversationId/nodeIds ONLY — NEVER an org id or user id.
 * 401 -> CoreUnauthorizedError; 403/404 -> CoreForbiddenError; any other non-2xx or a
 * network error -> CoreUnavailableError.
 */
export async function fetchChatPushAuthorization(
  args: FetchChatPushAuthorizationArgs,
): Promise<RealtimeChatAuthorization>;
```

### `services/gateway/src/redis/chatPubsub.ts` (new)

```ts
export interface ChatEventBus {
  /** Refcounted. Issues a real Redis SUBSCRIBE only on the 0 -> 1 transition. */
  subscribe(channel: string): Promise<void>;
  /** Refcounted. Issues a real Redis UNSUBSCRIBE only on the 1 -> 0 transition. No-op at 0. */
  unsubscribe(channel: string): Promise<void>;
  onEvent(handler: (event: DecodedChatEvent) => Promise<void>): void;
  /** Channels with a live refcount > 0. Exists so AC-5's no-leak assertion is real. */
  subscribedChannels(): string[];
  close(): Promise<void>;
}

/** Reuses redis/pubsub.ts's createRedisConnection (same REDIS_HOST/PORT/PASSWORD
 *  resolution, same maxRetriesPerRequest: null). Subscriber-only — the gateway never
 *  publishes a chat event, so no publisher connection is created. */
export async function createChatEventBus(
  factory?: RedisConnectionFactory, // imported type from ./pubsub
): Promise<ChatEventBus>;
```

### `services/gateway/src/fanout/chatFanout.ts` (new)

```ts
export interface ChatFanOutDeps {
  authorizePush: typeof fetchChatPushAuthorization;
  coreBaseUrl: string;
  onUnauthorized: (conn: GatewayConnection) => void; // close the connection, force re-auth
  onSubscriptionRevoked: (conn: GatewayConnection, conversationId: string) => Promise<void> | void;
  maxConcurrency?: number; // default 16, mirroring fanout/fanout.ts
}

/**
 * Selects registry.matchingChat(event.orgId, event.conversationId) and, for EACH
 * matching connection on EVERY event, re-asks Core over that connection's own
 * token before sending anything.
 */
export async function relayChatEvent(
  event: DecodedChatEvent,
  registry: ConnectionRegistry,
  deps: ChatFanOutDeps,
): Promise<void>;
```

### `services/core/src/graph-query/types.ts` (addition)

```ts
/**
 * Kept separate from GraphQueryService so existing canvas/realtime/retrieval test
 * doubles do not need a citation method. Folder/File are authorized by the usual
 * path-prefix rules; Feature/Ticket carry no `path` and are authorized ONLY by a
 * repository-root-level grant (`path_prefix IS NULL`) for their own
 * (repo_id, ref_name) — the same fail-closed rule TicketReadinessPrerequisite
 * already documents.
 */
export interface ChatCitationGraphQueryService {
  /** The subset of `nodeIds` this ctx may currently read. Never throws for an unknown id. */
  getAuthorizedNodeIds(nodeIds: readonly string[], ctx: AuthContext): Promise<string[]>;
}
```

### `services/core/src/graph-query/index.ts` (additions)

```ts
/** >= CH-04's CHAT_MAX_CITATIONS (24) x 2 ids each. Ids beyond this are not queried. */
export const CHAT_CITATION_NODE_ID_LIMIT = 64;

export const GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER = `
MATCH (node)
WHERE node.org_id = $org_id
  AND node.uid IN $node_ids
  AND node.repo_id IS NOT NULL
  AND node.ref_name IS NOT NULL
  AND (
    ((node:Folder OR node:File)
      AND ${'${canonicalGraphPathPredicate(\'node\')}'}
      AND ANY(rule IN $allow_rules WHERE
        (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
        (rule.branch IS NULL OR rule.branch = node.ref_name) AND
        (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
          node.path STARTS WITH rule.path_prefix + '/'))
      AND NOT ANY(rule IN $deny_rules WHERE
        (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
        (rule.branch IS NULL OR rule.branch = node.ref_name) AND
        (rule.path_prefix IS NULL OR node.path = rule.path_prefix OR
          node.path STARTS WITH rule.path_prefix + '/')))
    OR
    ((node:Feature OR node:Ticket)
      AND ANY(rule IN $allow_rules WHERE
        (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
        (rule.branch IS NULL OR rule.branch = node.ref_name) AND
        rule.path_prefix IS NULL)
      AND NOT ANY(rule IN $deny_rules WHERE
        (rule.repo_id IS NULL OR rule.repo_id = node.repo_id) AND
        (rule.branch IS NULL OR rule.branch = node.ref_name) AND
        rule.path_prefix IS NULL))
  )
RETURN DISTINCT node.uid AS id,
       node.org_id AS org_id,
       node.repo_id AS repo_id,
       node.ref_name AS ref_name,
       node.path AS path,
       CASE WHEN node:Folder THEN 'Folder'
            WHEN node:File THEN 'File'
            WHEN node:Feature THEN 'Feature'
            ELSE 'Ticket' END AS label
ORDER BY id
LIMIT ${'${CHAT_CITATION_NODE_ID_LIMIT}'}
`;
```

(the two `${...}` above are literal template interpolations of the existing
`canonicalGraphPathPredicate` helper and the new limit constant, exactly as the sibling queries
in this file already do)

```ts
// on RbacGraphQueryService (which gains `ChatCitationGraphQueryService` in its implements list):
async getAuthorizedNodeIds(nodeIds: readonly string[], ctx: AuthContext): Promise<string[]>;
```

Implementation shape, mirroring `getAffectedNodes` exactly:

- de-duplicate, drop non-string/blank/over-512-char ids, then `.slice(0, CHAT_CITATION_NODE_ID_LIMIT)`;
  empty → `return []` without touching the graph
- `const scope = await this.permissions.getReadScope(ctx)`; `scope.allows.length === 0` → `return []`
- `this.graph.run(ctx.orgId, 'traversal', GET_AUTHORIZED_CITATION_NODE_IDS_CYPHER, { org_id: ctx.orgId, node_ids: ids, ...scopeParameters(scope) })`
- TypeScript defense-in-depth mirror before returning any id (same posture as every other mapper
  in this file): row `org_id` must equal `ctx.orgId`; for `Folder`/`File`,
  `canReadResource(scope, { repoId, refName, path })` must be true; for `Feature`/`Ticket`,
  `canReadResource(scope, { repoId, refName, path: '' })` must be true — the identical root-grant
  call `mapTicketReadiness` already makes for a prerequisite's visibility.

### `services/core/src/services/realtimeChatService.ts` (new)

```ts
/**
 * Business logic for the internal realtime chat authorization call
 * (.claude/rules/service-layer.md). `ctx` is resolved server-side by the caller —
 * org_id/user_id are NEVER read from the request body.
 */
export async function authorizeRealtimeChatPush(
  input: { conversationId: string; nodeIds: readonly string[] },
  ctx: AuthContext,
  store: ChatStore = chatStore,
  graph: ChatCitationGraphQueryService = graphQueryService,
): Promise<RealtimeChatAuthorization>;
```

- non-`user` ctx (agent key) → throw `ChatForbiddenError` (reused from `chatService.ts`; already
  mapped to 403 in `http/express.ts`)
- `requireConversationId(input.conversationId)` (reused, now-exported, from `chatService.ts`) —
  a malformed id throws `ChatNotFoundError` before Postgres is touched
- `await store.getConversation({ orgId: ctx.orgId, userId: ctx.userId }, conversationId, 0)`;
  `null` → throw `ChatNotFoundError` (404 — never distinguishes absent from unowned)
- `input.nodeIds.length === 0` → return `{ conversationId, authorizedNodeIds: [] }` without a
  graph call
- otherwise return `{ conversationId, authorizedNodeIds: await graph.getAuthorizedNodeIds(input.nodeIds, ctx) }`

### `services/core/src/http/realtimeDeltaRequest.ts` (addition)

```ts
export interface ParsedRealtimeChatAuthorizationRequest {
  conversationId: string;
  nodeIds: string[];
}

/** Reuses RealtimeDeltaParseError (already -> HTTP 400 in http/express.ts).
 *  Deliberately never reads org_id/orgId/userId from the body even if present. */
export function parseRealtimeChatAuthorizationRequest(
  body: unknown,
): ParsedRealtimeChatAuthorizationRequest;
```

Rejects: non-object body; missing/blank `conversationId`; `nodeIds` not an array of non-blank
strings; `nodeIds.length > 64`.

### `services/core/src/routes/realtimeInternal.ts` (addition)

```ts
realtimeInternalRouter.post(
  '/internal/realtime/chat-authorization',
  authenticate(),
  authorize('member'),
  asyncHandler(async (req, res) => {
    const input = parseRealtimeChatAuthorizationRequest(req.body);
    const authorization = await authorizeRealtimeChatPush(input, requireAuthContext(req));
    res.json(authorization);
  }),
);
```

## Approach

Build in this order. Each step is independently testable.

1. **`packages/shared-types`** — add the CH-05 block and extend the two unions. `ChatTurnPush` is
   the single source of truth for the pinned key sets; everything downstream constructs these
   types field-by-field, never by spreading a decoded payload.

2. **`ws/chatEvents.ts`** — the pure validation gate.
   - `parseChatEventChannel` uses `/^sayre:chat\.events:([^:]+):([^:]+)$/` (org ids and
     conversation ids are UUIDs, so a colon-free segment split is exact).
   - `decodeChatEvent(channel, rawMessage)`:
     a. `JSON.parse` + `assertValidEnvelope` (imported from `@sayre/core`, the **same** call
        `redis/pubsub.ts` already makes) inside a try/catch → `null` on throw.
     b. `parseChatEventChannel(channel)` → `null` if unparsable.
     c. `envelope.org_id === coords.orgId`, else `null`. **The envelope's `org_id` is the
        trustworthy value; the channel segment only has to agree with it.**
     d. `envelope.source === CHAT_EVENT_SOURCE`, else `null`.
     e. `envelope.type` ∈ the three pinned types, else `null`.
     f. payload is a non-array object; `payload.conversationId === coords.conversationId`;
        `payload.turnId` a non-blank string; `payload.ts` a non-empty string (relayed verbatim,
        never re-formatted).
     g. per-type field validation:
        - progress: `seq` an integer ≥ 1; `kind` ∈ `{'status','tool_call'}`; `tool` and `detail`
          each `string | null`.
        - completed: `answer` a string; `citations` an array of length ≤ `CHAT_MAX_CITATIONS`
          whose every entry is `{ nodeId: non-blank string, label: string, kind ∈ the four kinds,
          resolvedNodeId: string | null }`; `metrics` an object whose four fields are all finite
          numbers. Any extra key on the payload or on a citation is **ignored, not rejected** —
          the outbound frame is rebuilt field-by-field, so a stray `seq` on a terminal event can
          never reach the client.
        - error: `code` and `message` non-blank strings.
     h. build the `ChatTurnPush` literal field-by-field and return
        `{ orgId: envelope.org_id, conversationId, turnId, push }`.
     Every `null` return logs `console.error('[gateway] discarding chat event', { channel, reason })`
     with a fixed reason string — never payload content (mirrors CH-04's "channel name only,
     never payload" publish-failure log).
   - `citationNodeIds` / `filterCitations` as specified above.

3. **`redis/pubsub.ts`** — add `export` to `createRedisConnection`. Nothing else changes.

4. **`redis/chatPubsub.ts`** — one subscriber connection via that reused factory.
   - `refcounts: Map<string, number>`; `subscribe`/`unsubscribe` as specified.
   - `subscriber.on('message', (receivedChannel, message) => { ... })`: ignore a channel with no
     live refcount; `decodeChatEvent` → ignore `null`; otherwise **enqueue on a per-channel
     promise chain** so handler invocations for one conversation run strictly in arrival order
     even though each awaits a Core round-trip. This is what makes AC-1's "progress seq monotonic"
     true end-to-end; the graph bus's fire-and-forget `void handler(...)` is deliberately not
     copied here because chat events are order-significant and `graph.updated` events are not.
   - Handler rejections are caught and logged, never allowed to break the chain.
   - `close()` quits the subscriber.

5. **`coreClient.ts`** — `CoreForbiddenError` + `fetchChatPushAuthorization`, structurally a copy
   of `fetchAuthorizedDelta` (same `baseUrl` join, same conditional Authorization header, same
   "never log the token, never send an org id" invariants), with the extra 403/404 branch.

6. **`ws/protocol.ts`** — the channel branch and `isChatChannelMessage`.

7. **`ws/connection.ts`**:
   - `chatSubscriptions` added to `GatewayConnection` and initialized in `createPendingConnection`.
   - `matchingChat(orgId, conversationId)` — the chat sibling of `matching(orgId, repoId)`.
     `conn.orgId` here is the value derived at connect from the verified token; combined with the
     channel/envelope org agreement in step 2c this is the second, independent structural barrier
     that makes AC-2's cross-org case impossible.
   - `handleChatSubscribe(conn, conversationId, deps)`:
     1. not `conn.authenticated` → return the existing `{ type:'error', code:'unauthenticated',
        message:'Authenticate before subscribing.' }` frame, record nothing.
     2. `deps.authorizeChatSubscription` absent → return the `chat_forbidden` frame (**fail
        closed**: a gateway wired without chat deps refuses chat subscriptions rather than
        accepting them unverified). This is what keeps every existing `connection.test.ts` case
        passing untouched.
     3. `await deps.authorizeChatSubscription(conn, conversationId)`; `false` → `chat_forbidden`
        frame, record nothing, acquire nothing.
     4. **Synchronously** (no `await` between the two lines):
        `const isNew = !conn.chatSubscriptions.has(conversationId);
         conn.chatSubscriptions.add(conversationId);`
        then `if (isNew) await deps.acquireChatChannel(conn.orgId, conversationId);`
        This is what makes duplicate and concurrently-racing subscribes acquire exactly once
        (EC-9, EC-22).
     5. return `{ type:'subscribed', channel:'chat', conversationId }`.
   - `handleChatUnsubscribe`: `if (!conn.chatSubscriptions.delete(conversationId)) return;` then
     `await deps.releaseChatChannel?.(conn.orgId, conversationId)`. Never-subscribed → no-op, no
     Redis call (EC-10).
   - `releaseChatSubscriptions(conn, deps)`: snapshot the set, clear it, then release each
     channel; every release is individually `catch`-and-logged so one failure cannot strand the
     others.
   - dispatch inside `attachConnectionLifecycle`'s `message` handler: after the `auth` branch,
     `if (isChatChannelMessage(message)) { if (message.type === 'subscribe')
     { sendSafe(socket, await handleChatSubscribe(conn, message.conversationId, deps)); }
     else { await handleChatUnsubscribe(conn, message.conversationId, deps); } return; }`
     — placed **before** the existing repo `subscribe`/`unsubscribe` branches so their
     `message.repoId` accesses stay type-valid on the narrowed union.
   - `close` handler: `clearAuthTimer(); registry.remove(conn.id); void releaseChatSubscriptions(conn, deps);`

8. **`fanout/chatFanout.ts`** — sibling of `fanout/fanout.ts`, same local `sendSafe`, same bounded
   worker-pool loop, same `maxConcurrency` default of 16. Per connection:
   1. `const nodeIds = citationNodeIds(event.push)` (`[]` for progress/error — the Core call still
      happens, because the ownership half of the re-filter applies to every push).
   2. `const auth = await deps.authorizePush({ baseUrl: deps.coreBaseUrl, token: conn.token,
      conversationId: event.conversationId, nodeIds })`.
   3. `if (auth.conversationId !== event.conversationId) { log; return; }` (defensive; a
      mismatched response is never trusted).
   4. `const push = event.push.type === 'chat.turn.completed'
        ? filterCitations(event.push, new Set(auth.authorizedNodeIds))
        : event.push;`
   5. `sendSafe(conn, push)`.
   Catch order: `CoreUnauthorizedError` → `deps.onUnauthorized(conn)`, send nothing;
   `CoreForbiddenError` → send the single `{ type:'error', code: CHAT_FORBIDDEN_CODE, message:
   CHAT_FORBIDDEN_MESSAGE }` frame, then `await deps.onSubscriptionRevoked(conn, conversationId)`,
   send no event data; `CoreUnavailableError` → log `{ conversationId, connectionId }` and skip
   this push, leaving the subscription in place (transient); anything else → rethrow (matching
   `fanout.ts`).
   **Fail closed, concretely:** on any of those failures the connection receives *zero* event
   frames for that push — never the unfiltered event, never a partially-filtered one, never a
   fallback to a previously-resolved scope.

9. **Core: graph-query** — the new Cypher, limit constant, interface, method and TS mirror.

10. **Core: service + parser + route** — `realtimeChatService.ts`,
    `parseRealtimeChatAuthorizationRequest`, and the 3-statement route.

11. **`server.ts` wiring**:
    ```ts
    const chatBus = await createChatEventBus();
    const chatDeps = {
      authorizeChatSubscription: async (conn, conversationId) => {
        try {
          await fetchChatPushAuthorization({ baseUrl: coreBaseUrl, token: conn.token, conversationId, nodeIds: [] });
          return true;
        } catch { return false; } // fail closed on forbidden AND on unavailable
      },
      acquireChatChannel: (orgId, conversationId) => chatBus.subscribe(chatEventChannel(orgId, conversationId)),
      releaseChatChannel: (orgId, conversationId) => chatBus.unsubscribe(chatEventChannel(orgId, conversationId)),
    };
    chatBus.onEvent((event) =>
      relayChatEvent(event, registry, {
        authorizePush: fetchChatPushAuthorization,
        coreBaseUrl,
        onUnauthorized: (conn) => conn.socket.close(UNAUTHENTICATED_CLOSE_CODE, 'core rejected token'),
        onSubscriptionRevoked: async (conn, conversationId) => {
          conn.chatSubscriptions.delete(conversationId);
          await chatBus.unsubscribe(chatEventChannel(conn.orgId, conversationId));
        },
      }),
    );
    // wss.on('connection'): attachConnectionLifecycle(conn, req, registry, chatDeps)
    // close(): ... await bus.close(); await chatBus.close(); ...
    ```

### Subscribe-strategy decision (recorded, not deviated from)

Per-conversation `SUBSCRIBE` on the exact channel, as the orchestrator directed. The gateway's
existing Redis machinery is **not** pattern-based (`redis/pubsub.ts` does a plain
`subscriber.subscribe(channel)` on one fixed channel), so per-conversation `SUBSCRIBE` conforms to
existing convention rather than deviating from it. No `PSUBSCRIBE` is introduced anywhere.

### Testing conventions to reuse (no live Redis / Postgres / Core anywhere)

- **Redis**: the `class FakeRedis extends EventEmitter` fixture already in
  `src/redis/pubsub.test.ts` (with `subscribedChannels`/`published`/`quit`), injected via the
  existing exported `RedisConnectionFactory` type, plus
  `setConfigOverrideForTests('REDIS_HOST'|'REDIS_PORT', ...)` / `resetConfigForTests()` from
  `@sayre/config`. `chatPubsub.test.ts` extends it with an `unsubscribe(channel)` spy.
- **Core HTTP**: `globalThis.fetch = vi.fn(...)` with a restore in `afterEach`, exactly as
  `src/coreClient.test.ts` does.
- **Sockets**: the `class FakeSocket` fixtures in `src/fanout/fanout.test.ts` (plain) and
  `src/ws/connection.test.ts` (`extends EventEmitter`).
- **End-to-end**: `src/chatE2e.test.ts` copies `src/e2e.test.ts`'s `startTestServer` /
  `connectAndAuth` / `waitForMessage` helpers with a real in-process `ws` client+server, an
  injected `fakeAuthenticate`, an in-memory fake chat bus, and a `vi.fn()` `authorizePush` — no
  Redis, no SQS, no Core process.
- **Core-side**: `services/core/src/routes/realtimeInternal.test.ts`'s existing
  `vi.mock('../graph-query', ...)` + `createApp()` + `app.listen(0)` pattern; the service test
  injects a plain-object `ChatStore` / `ChatCitationGraphQueryService` double.

## Acceptance criteria

- **AC-1** For a turn processed while the owner is subscribed, the owner's socket receives the
  `chat.turn.progress` frames followed by the `chat.turn.completed` frame, in publish order, with
  `seq` strictly increasing from 1 — proven with a Core stub whose first authorization call
  resolves more slowly than the second (i.e. ordering survives the async re-filter).
- **AC-2** A user in the same org who is not the conversation's owner is refused at subscribe with
  the generic `chat_forbidden` error frame, records no subscription, triggers no Redis
  `SUBSCRIBE`, and receives nothing when events subsequently flow on that conversation's channel.
  A connection authenticated under a different org can never match, because `matchingChat`
  compares the connection's token-derived `orgId` against the envelope's `org_id`.
- **AC-3** A `chat.turn.completed` event whose citation list contains a node id outside the
  receiving client's current scope is delivered with that citation absent, with the remaining
  citations intact and `metrics` byte-identical to the worker's report.
- **AC-4** When a connection's scope is reduced *after* it subscribed, the very next push is
  filtered under the new scope: with two successive events and an authorization stub that returns
  a narrower `authorizedNodeIds` on the second call, the first frame carries the citation and the
  second does not — and Core was called once per event per connection, not once at subscribe.
- **AC-5** `{ type:'unsubscribe', channel:'chat', conversationId }` and socket close both release
  the conversation's Redis subscription; after the last subscriber for a channel goes away,
  `chatBus.subscribedChannels()` no longer contains it and a real `UNSUBSCRIBE` was issued exactly
  once. No connection close leaves a subscription behind.
- **AC-6** Contract conformance: for each of the three push types, the frame the client receives
  has exactly the pinned key set — `['conversationId','detail','kind','seq','tool','ts','turnId','type']`,
  `['answer','citations','conversationId','metrics','ts','turnId','type']`,
  `['code','conversationId','message','ts','turnId','type']` — with each citation carrying exactly
  `['kind','label','nodeId','resolvedNodeId']` and each metrics object exactly
  `['baselineTokens','contextNodes','ratio','tokensUsed']`. Extra keys present on the incoming
  worker payload never appear on the wire.
- **AC-7** Each of these is dropped with a log and never forwarded to any client: a non-JSON or
  `assertValidEnvelope`-failing message; an envelope whose `org_id` disagrees with the channel's
  org segment; a payload whose `conversationId` disagrees with the channel's conversation segment;
  an envelope whose `type` is not one of the three pinned types.
- **AC-8** The gateway never accepts an org id from client input or trusts one from a message
  body: the subscribe frame carries no org field, `conn.orgId` comes only from the verified
  connection identity, the relay's org comes only from `envelope.org_id`, and the request body
  `fetchChatPushAuthorization` sends contains exactly `{ conversationId, nodeIds }` — no `org_id`,
  `orgId`, `userId` or `token` field.
- **AC-9** The per-push re-filter is real, not a subscribe-time cache: N events to one subscribed
  connection produce N authorization calls to Core, each carrying that connection's own bearer
  token, and the gateway itself performs no scope computation (it only set-intersects against the
  ids Core returned).
- **AC-10** Back-compatibility: every existing test in `services/gateway/src/**/*.test.ts` passes
  unchanged, the existing `{type:'subscribe', repoId}` / `{type:'unsubscribe', repoId}` frames
  decode and behave identically, and `fanOutGraphUpdated` / `createGraphUpdatedBus` behaviour is
  untouched.
- **AC-11** `POST /internal/realtime/chat-authorization` returns `{ conversationId,
  authorizedNodeIds }` for the conversation's owner, returns 404 for both a nonexistent
  conversation and one owned by another user (indistinguishable), returns 403 for an agent-key
  subject, and derives org/user solely from the authenticated context — client-supplied `org_id`
  / `orgId` / `userId` body fields have no effect.
- **AC-12** Fail-closed on authorization failure: when the Core authorization call errors
  (unavailable, non-2xx, or network), that connection receives zero frames for that push — never
  the unfiltered event and never a partially filtered one — and the subscription is retained for
  the next event.
- **AC-13** `chatEventChannel(orgId, conversationId)` produces exactly the string CH-04's
  `sayre_workers.chat.events.chat_event_channel` produces, and `CHAT_EVENT_CHANNEL_PREFIX` is
  `'sayre:chat.events'` — pinned by an explicit test so the two sides cannot drift.

## Edge cases

- **EC-1** Malformed envelope on a chat channel: non-JSON text, a JSON array, or an object missing
  a required envelope field (`assertValidEnvelope` throws) → dropped, logged, handler never
  invoked, connection unaffected.
- **EC-2** `envelope.org_id` differs from the channel's org segment → dropped, logged, never
  forwarded (even to a connection whose `orgId` matches one of the two values).
- **EC-3** `payload.conversationId` differs from the channel's conversation segment → dropped,
  logged, never forwarded.
- **EC-4** `envelope.type` is `graph.updated`, `chat.turn.request`, or any other unrecognized
  value → dropped, logged.
- **EC-5** `envelope.source` is not `'sayre-chat-worker'` → dropped, logged.
- **EC-6** The received channel string does not match
  `sayre:chat.events:{orgId}:{conversationId}` (wrong prefix, too few/many colon segments, blank
  segment) → dropped, logged.
- **EC-7** Structurally invalid payload for its declared type: progress with `seq: 0`, `seq: 1.5`,
  a missing `seq`, or `kind: 'other'`; completed with a non-array `citations`, a citation missing
  `nodeId`, a citation with `kind: 'function'`, a non-numeric `metrics.ratio`, or more than
  `CHAT_MAX_CITATIONS` (24) citations; error with a blank `code` → each dropped, logged.
- **EC-8** Subscribe to a conversation id that does not exist → the *identical* `chat_forbidden`
  frame and message a non-owner gets; nothing in the reply distinguishes absent from unowned.
- **EC-9** Duplicate subscribe to the same conversation on one connection → both replies are
  `{ type:'subscribed', channel:'chat', conversationId }`, `chatSubscriptions.size` stays 1, and
  `acquireChatChannel` fired exactly once (one real Redis `SUBSCRIBE`).
- **EC-10** Unsubscribe for a conversation never subscribed on that connection → no throw, no
  reply frame, `releaseChatChannel` never called, refcount untouched.
- **EC-11** Disconnect mid-turn: the socket closes between two events → `releaseChatSubscriptions`
  releases every held channel, the connection is deregistered, and an in-flight `relayChatEvent`
  targeting the now-closed socket is a silent no-op (`sendSafe`'s `readyState !== OPEN` guard),
  not a crash.
- **EC-12** Scope lookup failure at push time — Core returns 500, or `fetch` rejects → this push
  delivers nothing to that connection (fail closed), the error is logged **without the bearer
  token**, the subscription is retained, and the next event is attempted normally.
- **EC-13** Core returns 401 at push time (session expired mid-turn) → `onUnauthorized(conn)`
  fires (production wiring closes the socket with `UNAUTHENTICATED_CLOSE_CODE`) and no event frame
  is delivered.
- **EC-14** Core returns 403 or 404 at push time (ownership revoked or conversation deleted
  mid-turn) → exactly one `{type:'error', code:'chat_forbidden'}` frame, no event data,
  `onSubscriptionRevoked` fires, the conversation leaves `chatSubscriptions`, and the Redis
  refcount is released.
- **EC-15** A citation with `resolvedNodeId: null` whose `nodeId` is authorized → delivered
  unchanged, `resolvedNodeId` still `null`. A `null` `resolvedNodeId` is never itself a reason to
  drop a citation.
- **EC-16** A citation whose `nodeId` is not in `authorizedNodeIds` → the whole citation is
  dropped; `metrics.contextNodes` and the other three counts are **not** recomputed.
- **EC-17** A citation whose `nodeId` is authorized but whose non-null `resolvedNodeId` is not →
  the whole citation is dropped (the strict reading recorded in Ticket Check item 1), not
  half-delivered with a nulled pointer.
- **EC-18** Every citation stripped → the `chat.turn.completed` frame is still delivered, with
  `citations: []`, the full `answer`, and unchanged `metrics`.
- **EC-19** A chat subscribe frame before authentication → the existing generic
  `{code:'unauthenticated'}` frame, no subscription recorded, no Core call, no Redis `SUBSCRIBE`.
- **EC-20** A chat subscribe frame on a gateway constructed **without** the chat deps → the
  generic `chat_forbidden` refusal (fail closed), never a silently-accepted unverified
  subscription.
- **EC-21** Two connections owned by the same user subscribe to the same conversation (two browser
  tabs) → exactly one real Redis `SUBSCRIBE`; both receive every push; each gets its own
  authorization call per push; when one disconnects the channel stays subscribed; when the second
  disconnects a single `UNSUBSCRIBE` is issued.
- **EC-22** Two `subscribe` frames for the same conversation arriving before the first
  authorization resolves → `acquireChatChannel` still fires exactly once and the refcount stays
  balanced against the single close-time release.
- **EC-23** `sendSafe` on a socket whose `readyState` is `CLOSED`, or whose `send` throws →
  swallowed and logged, `relayChatEvent` still resolves.
- **EC-24** Redis subscriber reconnect: ioredis re-issues `SUBSCRIBE` for its tracked channels on
  its own, so the gateway adds no reconnect logic; events published during the gap are **not**
  replayed (chat pub/sub is at-most-once) and CH-03's REST read is the documented catch-up path.
  Covered by an explicit comment + a test asserting the bus does not attempt its own replay/buffer.
- **EC-25** An event arrives for a conversation with no matching connection (nobody subscribed on
  this gateway instance, or only a wrong-org connection exists) → short-circuits with **zero**
  Core authorization calls and zero frames.
- **EC-26** A malformed chat frame from the client — `{type:'subscribe', channel:'chat'}` with no
  `conversationId`, a blank/non-string `conversationId`, or `channel:'graph'` → the existing
  generic `{code:'bad_frame'}` reply, connection stays open, nothing recorded.
- **EC-27** Progress events with a gap or a repeat in `seq` (e.g. 1, 3, 3) are relayed verbatim in
  arrival order — the gateway never reorders, renumbers, de-duplicates or buffers; `seq`
  interpretation belongs to CH-06.
- **EC-28** `nodeIds` is `[]` (every progress and error push, and every subscribe-time check) →
  Core is still called for the ownership half of the re-filter, `authorizedNodeIds` is ignored,
  and Core skips the graph query entirely.

## Open questions

None blocking. Three points the ticket left open were resolved against the existing code and are
recorded above rather than deferred:

1. **Citation strip granularity** — resolved to the strict reading: a citation is delivered only
   if its `nodeId` and its non-null `resolvedNodeId` are both authorized (EC-16/EC-17). This
   matches the ticket's literal wording ("citations whose nodeId/resolvedNodeId the client is not
   authorized to see") and `fanout/fanout.ts`'s established existence-leak posture. Reversing it
   later means changing `filterCitations` and EC-17 only.
2. **Where the owner check lives** — resolved to a new internal-only Core endpoint rather than a
   Postgres read from the gateway, because `.claude/rules/service-layer.md` covers
   `services/gateway/**/*.ts` and the gateway already reaches all RBAC exclusively through
   `coreClient.ts`. This is why CH-05 touches `services/core` at all.
3. **Redis subscribe strategy** — per-conversation `SUBSCRIBE`, as directed; no deviation, and the
   existing machinery is channel-based rather than pattern-based, so this conforms to convention.
   Recorded under "Subscribe-strategy decision".

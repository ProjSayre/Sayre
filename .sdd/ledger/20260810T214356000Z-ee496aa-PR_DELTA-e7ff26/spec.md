# CH-03 — Chat conversation persistence, turn API, and `chat-turns` queue

## Ticket Check

**What I'm about to build**
The memory and the mailbox behind "Ask Sayre". When someone asks a question in the chat sidebar,
their question is saved, a blank answer slot is saved next to it marked "waiting", and one work
order is dropped into a queue for the part of the system that actually does the thinking (built in a
later ticket). Their past conversations are saved and can be listed and reopened.

**What I'm explicitly not doing**
No chat window, no buttons, no visible screen of any kind. Nothing that reads the queue or writes an
answer. No streaming text. Nobody can share a conversation with a teammate yet — in this version a
conversation belongs only to the person who started it. This ticket ends the moment the work order
is in the queue.

**How you'll know it worked**
Ask the same question twice by accident (a double-click, a flaky network retry) and you get one
question and one work order, not two. Sign in as a different teammate and you cannot open or add to
someone else's conversation — it looks like it doesn't exist. A conversation "remembers" only the
last twelve finished back-and-forths when it hands work to the thinking step, so an hour-long
conversation doesn't balloon. And the queue that carries this work has a dead-letter safety net and
keeps each conversation's questions in the order they were asked, like every other queue we run.

**What I had to guess**
Five things, and the fifth is the one that most needs your judgment:
1. The ticket calls the queue `chat-turns`; Amazon requires ordered queues to be named with a
   `.fifo` ending, so it is physically `chat-turns.fifo`.
2. The work order carries an id so the thinking step knows which answer slot to fill. I assumed
   that is the id of the *answer* slot, not of the question. If the next ticket assumes otherwise,
   they won't line up.
3. I added a few bookkeeping columns the ticket didn't list (a turn number, the idempotency key, a
   link from answer back to question, a "handed to the queue at" timestamp, and the saved
   view/anchor context). Each exists to make "exactly once" actually true and to let a retry rebuild
   the identical work order.
4. Trying to open someone else's conversation returns "not found" rather than "not allowed", so we
   never confirm that a stranger's conversation exists.
5. The ticket says these endpoints should be reachable through the web app's existing pass-through
   without touching the web app. That isn't true today: the pass-through only forwards a fixed list
   of addresses, and it silently drops the body of any submitted form. So I've included the smallest
   possible change there (four address entries plus forwarding the body). If you'd rather this
   ticket touch nothing in the web app at all, say so and that piece moves to the sidebar ticket —
   but until someone does it, the sidebar cannot reach these endpoints at all.

---

## Goal

Give "Ask Sayre" its durable spine: Postgres tables for conversations and turns, a `chatService`
that atomically records a user turn plus a `pending` assistant turn and enqueues exactly one job
onto a new `chat-turns.fifo` SQS FIFO queue, and four thin REST routes over that service. No worker,
no realtime, no UI.

## Scope

**In**

- Migration `0019` creating `chat_conversations` and `chat_turns` with RLS, tenant-consistent
  composite FKs, uniqueness/idempotency constraints, `updated_at` triggers, and least-privilege
  grants; matching Drizzle table definitions in `src/db/schema.ts`.
- `services/core/src/db/chatStore.ts` — the persistence boundary (the `PostgresAgentSkillMdStore`
  idiom: an interface, an injectable-deps Postgres implementation, a module-level singleton).
- `services/core/src/services/chatService.ts` — `createConversation`, `listConversations`,
  `getConversation`, `postTurn`, plus validation, owner-only enforcement, and the pinned payload
  construction.
- `services/core/src/queue/sqs.ts` — `CHAT_TURNS_QUEUE`, the `ChatTurnRequestPayload` type, and
  `publishChatTurnRequest`.
- `services/core/src/routes/chat.ts` — four thin handlers, mounted in `app.ts`; new error classes
  mapped in `http/express.ts`.
- Queue declaration: LocalStack init hook (`chat-turns.fifo` + `chat-turns-dlq.fifo`, same redrive/
  retention as every other lane), `infra/.env.example` entry, `CHAT_TURNS_QUEUE` added to the Python
  `sqs_client` constants and `_PRODUCTION_QUEUES`.
- `docs/wave0-foundation-contracts.md` — the queue's entry in the approved topology.
- The minimal `apps/web/app/api/core/[...path]/route.ts` change needed for the routes to be
  reachable (see OQ-1 — this is the one item an approver may strike).

**Out**

- Any SQS *consumer*, agent loop, retrieval, tool calling, or LLM call (CH-04).
- Any Redis/WebSocket publication or `graph.updated`-style fan-out for chat (CH-05). The
  `chat-turns.fifo` queue is deliberately **not** subscribed to the `graph-updated` SNS topic.
- Any React component, hook, page, or styling (CH-06).
- Token streaming, partial-content updates, or any write to `chat_turns.content` after insert
  (CH-04 owns the `pending → running → completed|error` transitions).
- Minting the MCP credential (CH-01/CH-04). `mcpCredential` is pinned as literal `null` here.
- Sharing a conversation with another user, renaming, archiving, or deleting a conversation. The
  runtime role is deliberately granted no `DELETE` on either new table.
- A background dispatcher, lease/sweeper loop, or second transactional outbox (see OQ-7).
- `docs/architecture.md` — untouched.

## Affected files

**Created**

| Path | Purpose |
|---|---|
| `services/core/drizzle/0019_ch03_chat_conversations_and_turns.sql` | Hand-authored migration (the `0016_jira_connections.sql` idiom: table + FKs + indexes + RLS + trigger + grants in one file). |
| `services/core/src/db/chatStore.ts` | Persistence boundary for both tables. |
| `services/core/src/db/chatMigration.test.ts` | CI-safe migration-content assertions (mirrors `src/db/agentSkillMdMigration.test.ts`). Runs under vitest. |
| `services/core/src/db/chatStore.rls.test.ts` | Real-Postgres RLS/ownership integration test (`node:test`, throwaway DB off `DATABASE_ADMIN_URL`), mirroring `src/db/jiraConnectionStore.rls.test.ts`. Excluded from vitest by the existing `src/db/**/*rls*.test.ts` pattern. |
| `services/core/src/services/chatService.ts` | Business logic. |
| `services/core/src/services/chatService.test.ts` | Authored by `red`. |
| `services/core/src/routes/chat.ts` | Four thin route handlers. |
| `services/core/src/routes/chat.test.ts` | Authored by `red` (the `routes/nodeOverlay.test.ts` idiom: `vi.mock` the store, `createApp().listen(0)`, real `fetch`). |

**Modified**

| Path | Change |
|---|---|
| `services/core/drizzle/meta/_journal.json` | Append `idx: 19`, `tag: "0019_ch03_chat_conversations_and_turns"`, `version: "7"`, `breakpoints: true`, `when: 1785384300000`. |
| `services/core/src/db/schema.ts` | Add `chatConversations` / `chatTurns` `pgTable`s + `$inferSelect`/`$inferInsert` type exports; add `unique("users_org_id_id_unique").on(table.orgId, table.id)` to `users`. |
| `services/core/src/queue/sqs.ts` | Add `CHAT_TURNS_QUEUE`, `ChatTurnRequestPayload`, `publishChatTurnRequest`; extend the header comment's fleet-split exception note to name this third produce-only queue. |
| `services/core/src/queue/sqs.test.ts` | Extended by `red` with `publishChatTurnRequest` cases. |
| `services/core/src/http/express.ts` | Import and map `ChatValidationError` (400), `ChatForbiddenError` (403), `ChatNotFoundError` (404), `ChatEnqueueError` (502). |
| `services/core/src/app.ts` | `import { chatRouter } from './routes/chat'` and `app.use(chatRouter)` after `express.json()`, alongside the other session-authenticated routers. |
| `services/core/package.json` | Add `"test:rls:chat"` and `"test:rls:chat:ci"` scripts mirroring the existing `test:rls:jira*` pair. |
| `infra/localstack/init/ready.d/01-create-sqs-queues.sh` | Create `chat-turns-dlq.fifo` (in the DLQ block + retention loop) and `chat-turns.fifo`, then `configure_source`. Do **not** call `allow_topic`/`ensure_raw_subscription` on it. |
| `infra/.env.example` | Add `SQS_CHAT_TURNS_QUEUE=chat-turns.fifo` in the AWS/SQS block (documentation parity with the other queue names — no `packages/config` `CONFIG_NAMES` change; the name is a code constant, exactly like `SQS_EMBEDDING_UPSERTS_QUEUE`). |
| `services/workers/messaging/sqs_client.py` | Add `CHAT_TURNS_QUEUE = "chat-turns.fifo"` to the canonical constants and to `_PRODUCTION_QUEUES`. No consumer. |
| `services/workers/tests/test_messaging_topology.py` | Add `CHAT_TURNS_QUEUE: "chat-turns-dlq.fifo"` to the `pairs` map in `test_topology_has_typed_dlqs_restricted_fanout_and_distinct_queues`, and extend the final "not fanned out" assertion to include it. |
| `services/workers/tests/test_sqs_delivery.py` | Broker-free assertions that `CHAT_TURNS_QUEUE` ends in `.fifo` and is in `_PRODUCTION_QUEUES` (so `consume_once` refuses it without a durable `delivery_store`). |
| `docs/wave0-foundation-contracts.md` | One bullet under "Ingestion, events, and background work". |
| `apps/web/app/api/core/[...path]/route.ts` | Four allowlist entries + POST body forwarding (OQ-1). |
| `apps/web/app/api/core/[...path]/route.test.ts` | Extended by `red`. |

## Interfaces / signatures

### Migration `0019_ch03_chat_conversations_and_turns.sql`

Statements separated by `--> statement-breakpoint`, exactly as `0016`/`0012` do.

```sql
CREATE TABLE "chat_conversations" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"     uuid NOT NULL,
  "user_id"    uuid NOT NULL,
  "title"      text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT chat_conversations_title_check
    CHECK (title IS NULL OR (length(btrim(title)) > 0 AND length(title) <= 200))
);

-- Enables the tenant-consistent composite FK below. Mirrors
-- `repositories_org_id_id_unique` (schema.ts), added for the same reason.
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_id_unique" UNIQUE ("org_id","id");

ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_user_fk"
  FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE cascade;
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_org_id_id_unique"
  UNIQUE ("org_id","id");

CREATE INDEX "chat_conversations_owner_recent_idx"
  ON "chat_conversations" ("org_id","user_id","updated_at" DESC);

CREATE TABLE "chat_turns" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id"          uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "seq"             integer NOT NULL,
  "role"            text NOT NULL,
  "content"         text NOT NULL,
  "status"          text NOT NULL,
  "citations"       jsonb,
  "metrics"         jsonb,
  "error"           jsonb,
  "scope"           jsonb,
  "idempotency_key" text,
  "request_turn_id" uuid,
  "dispatched_at"   timestamp with time zone,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT chat_turns_role_check   CHECK (role IN ('user','assistant')),
  CONSTRAINT chat_turns_status_check CHECK (status IN ('pending','running','completed','error')),
  CONSTRAINT chat_turns_seq_check    CHECK (seq >= 1),
  CONSTRAINT chat_turns_user_shape_check CHECK (
    role <> 'user' OR (
      idempotency_key IS NOT NULL AND request_turn_id IS NULL
      AND status = 'completed' AND length(btrim(content)) > 0
      AND dispatched_at IS NULL
    )
  ),
  CONSTRAINT chat_turns_assistant_shape_check CHECK (
    role <> 'assistant' OR (idempotency_key IS NULL AND request_turn_id IS NOT NULL)
  ),
  CONSTRAINT chat_turns_error_status_check CHECK (error IS NULL OR status = 'error'),
  CONSTRAINT chat_turns_citations_check CHECK (citations IS NULL OR jsonb_typeof(citations) = 'array'),
  CONSTRAINT chat_turns_metrics_check  CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object'),
  CONSTRAINT chat_turns_error_object_check CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT chat_turns_scope_check CHECK (
    scope IS NULL OR (
      jsonb_typeof(scope) = 'object'
      AND (scope->'view' = 'null'::jsonb
           OR scope->>'view' IN ('technical','product','onboarding'))
      AND (scope->'anchorNodeId' = 'null'::jsonb
           OR jsonb_typeof(scope->'anchorNodeId') = 'string')
    )
  )
);

ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_org_conversation_fk"
  FOREIGN KEY ("org_id","conversation_id")
  REFERENCES "public"."chat_conversations"("org_id","id") ON DELETE cascade;
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_request_turn_id_fk"
  FOREIGN KEY ("request_turn_id") REFERENCES "public"."chat_turns"("id") ON DELETE cascade;
ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_org_conversation_seq_unique"
  UNIQUE ("org_id","conversation_id","seq");

-- The AC-2 idempotency guard. Partial because only user turns carry a key.
CREATE UNIQUE INDEX "chat_turns_idempotency_unique"
  ON "chat_turns" ("org_id","conversation_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
-- At most one assistant turn per user turn — makes a double-insert of the
-- pending answer structurally impossible, not merely unlikely.
CREATE UNIQUE INDEX "chat_turns_request_turn_unique"
  ON "chat_turns" ("org_id","request_turn_id")
  WHERE "request_turn_id" IS NOT NULL;
```

RLS, triggers, grants — the same idiom as `0016`, applied to **both** tables:

```sql
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON chat_conversations
  USING      (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- ...identical block for chat_turns...

DROP TRIGGER IF EXISTS set_updated_at ON chat_conversations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON chat_conversations
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
-- ...identical trigger for chat_turns...

-- No DELETE: v1 has no delete operation on either table.
GRANT SELECT, INSERT, UPDATE ON chat_conversations TO sayre_app;
GRANT SELECT, INSERT, UPDATE ON chat_turns TO sayre_app;
```

`chat_turns` deliberately gets **no** standalone `org_id` index: the leading `org_id` of
`chat_turns_org_conversation_seq_unique` already provides the btree RLS needs (the same note as
`model_provider_configs` / `repository_refs` in `schema.ts`).

### `services/core/src/db/chatStore.ts`

```ts
export interface ChatOwnerScope { orgId: string; userId: string }

export type ChatTurnRole = 'user' | 'assistant';
export type ChatTurnStatus = 'pending' | 'running' | 'completed' | 'error';
export type ChatTreeView = 'technical' | 'product' | 'onboarding';

export interface ChatTurnScope {
  view: ChatTreeView | null;
  anchorNodeId: string | null;
}

export interface StoredChatConversation {
  id: string;
  title: string | null;
  createdAt: string;   // ISO-8601
  updatedAt: string;   // ISO-8601
}

export interface StoredChatTurn {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatTurnRole;
  content: string;
  status: ChatTurnStatus;
  citations: unknown[] | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  scope: ChatTurnScope | null;
  requestTurnId: string | null;
  dispatchedAt: string | null;
  createdAt: string;
}

export interface AppendTurnPairInput {
  owner: ChatOwnerScope;
  conversationId: string;
  idempotencyKey: string;
  question: string;
  scope: ChatTurnScope;
  historyLimit: number;
}

export interface AppendTurnPairResult {
  /** false when an existing (org, conversation, idempotency_key) row was found. */
  created: boolean;
  userTurn: StoredChatTurn;
  assistantTurn: StoredChatTurn;
  /** Ascending by seq, at most `historyLimit`, `{ role, content }` only. */
  history: Array<{ role: ChatTurnRole; content: string }>;
}

export interface ChatStore {
  createConversation(owner: ChatOwnerScope, title: string | null): Promise<StoredChatConversation>;
  listConversations(owner: ChatOwnerScope, limit: number): Promise<StoredChatConversation[]>;
  /** null = no such conversation for this (org, user) — never distinguishes absent from unowned. */
  getConversation(
    owner: ChatOwnerScope,
    conversationId: string,
    turnLimit: number,
  ): Promise<{ conversation: StoredChatConversation; turns: StoredChatTurn[] } | null>;
  /** null = no such conversation for this (org, user). */
  appendTurnPair(input: AppendTurnPairInput): Promise<AppendTurnPairResult | null>;
  markTurnDispatched(owner: ChatOwnerScope, assistantTurnId: string): Promise<void>;
}

export interface PostgresChatStoreDeps {
  getDb: () => Promise<Db>;
  withOrg: <T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
}

export function chatConversationLockKey(orgId: string, conversationId: string): string;

export class PostgresChatStore implements ChatStore {
  constructor(deps?: PostgresChatStoreDeps);
}

export const chatStore: ChatStore;
```

`chatConversationLockKey` returns `JSON.stringify([orgId, conversationId])`, used as
`pg_advisory_xact_lock(hashtextextended(<key>, 0))` — the exact `agentSkillMdLockKey` idiom.

### `services/core/src/queue/sqs.ts` (additions)

```ts
/** Matches `CHAT_TURNS_QUEUE` in services/workers/messaging/sqs_client.py. */
export const CHAT_TURNS_QUEUE = 'chat-turns.fifo';

/** PINNED WIRE CONTRACT — CH-04 consumes this verbatim. Key order is part of the contract. */
export interface ChatTurnRequestPayload {
  schema: 'chat.turn.request.v1';
  turnId: string;          // the ASSISTANT turn id — the row CH-04 writes into
  conversationId: string;
  orgId: string;
  userId: string;
  question: string;
  scope: { view: 'technical' | 'product' | 'onboarding' | null; anchorNodeId: string | null };
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  mcpCredential: string | null;   // always null until CH-04 wires minting
}

export async function publishChatTurnRequest(
  envelope: MessageEnvelope<ChatTurnRequestPayload>,
): Promise<string>;
```

`publishChatTurnRequest` rejects a blank `payload.conversationId`, then calls the existing
`publish()` with `{ messageGroupId: envelope.payload.conversationId, messageDeduplicationId:
envelope.idempotency_key }`. (`publish()` already SHA-256-hashes the semantic dedup key into the
128-char transport id.)

### `services/core/src/services/chatService.ts`

```ts
export const CHAT_QUESTION_MAX_CHARACTERS = 8_000;
export const CHAT_TITLE_MAX_CHARACTERS = 200;
export const CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS = 512;
export const CHAT_HISTORY_MAX_TURNS = 12;
export const CHAT_CONVERSATION_LIST_DEFAULT_LIMIT = 50;
export const CHAT_CONVERSATION_LIST_MAX_LIMIT = 100;
export const CHAT_CONVERSATION_TURNS_LIMIT = 200;

export class ChatValidationError extends Error { constructor(readonly issues: string[]) }
export class ChatForbiddenError extends Error {}   // non-`user` subject (e.g. agent_key)
export class ChatNotFoundError extends Error {}    // absent OR not owned — never distinguished
export class ChatEnqueueError extends Error {}     // committed, but the publish failed

export interface ChatConversationView {
  id: string; title: string | null; createdAt: string; updatedAt: string;
}
export interface ChatTurnView {
  id: string; conversationId: string; seq: number;
  role: ChatTurnRole; content: string; status: ChatTurnStatus;
  citations: unknown[] | null;
  metrics: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: string;
}
export interface ChatConversationDetail {
  conversation: ChatConversationView; turns: ChatTurnView[];
}
export interface PostTurnResult {
  conversationId: string; userTurn: ChatTurnView; assistantTurn: ChatTurnView;
}

export type ChatTurnPublisher =
  (envelope: MessageEnvelope<ChatTurnRequestPayload>) => Promise<string>;

export const defaultPublishChatTurn: ChatTurnPublisher;

export async function createConversation(
  input: unknown, ctx: AuthContext, store?: ChatStore,
): Promise<ChatConversationView>;

export async function listConversations(
  rawLimit: unknown, ctx: AuthContext, store?: ChatStore,
): Promise<ChatConversationView[]>;

export async function getConversation(
  conversationId: string, ctx: AuthContext, store?: ChatStore,
): Promise<ChatConversationDetail>;

export async function postTurn(
  conversationId: string,
  input: unknown,
  ctx: AuthContext,
  store?: ChatStore,
  publish?: ChatTurnPublisher,
): Promise<PostTurnResult>;
```

Dependency injection is the trailing-default-parameter idiom used by `agentSkillMdService.ts`, not a
deps object.

**Request bodies**

- `POST /chat/conversations` → `{ "title"?: string | null }`
- `POST /chat/conversations/:conversationId/turns` →
  `{ "idempotencyKey": string, "question": string, "scope"?: { "view"?: ..., "anchorNodeId"?: ... } }`

The idempotency key travels in the **body**, not an `Idempotency-Key` header — the web proxy
constructs a fresh `Headers` containing only `accept`/`authorization`/`content-type`, so any custom
header would be silently dropped in the browser path.

**Response bodies**

- `POST /chat/conversations` → `201 { "conversation": ChatConversationView }`
- `GET  /chat/conversations` → `200 { "conversations": ChatConversationView[] }`
- `GET  /chat/conversations/:id` → `200 { "conversation": ..., "turns": ChatTurnView[] }`
- `POST /chat/conversations/:id/turns` → `202 { "conversationId", "userTurn", "assistantTurn" }`

### `services/core/src/routes/chat.ts`

```ts
export const chatRouter: Router;

chatRouter.post('/chat/conversations',                    authenticate(), authorize('member'), asyncHandler(...));
chatRouter.get ('/chat/conversations',                    authenticate(), authorize('member'), asyncHandler(...));
chatRouter.get ('/chat/conversations/:conversationId',    authenticate(), authorize('member'), asyncHandler(...));
chatRouter.post('/chat/conversations/:conversationId/turns', authenticate(), authorize('member'), asyncHandler(...));
```

Each handler body is at most three statements: call the service with
`requireAuthContext(req)`, set the status, `res.json(...)`. No parsing, no defaulting, no branching.

### `http/express.ts` mappings

| Error | Status | Body |
|---|---|---|
| `ChatValidationError` | 400 | `{ error: 'invalid chat request', issues: err.issues }` |
| `ChatForbiddenError` | 403 | `{ error: 'forbidden' }` |
| `ChatNotFoundError` | 404 | `{ error: 'not found' }` |
| `ChatEnqueueError` | 502 | `{ error: 'chat turn could not be queued' }` |

`ChatEnqueueError`'s body is a fixed string — never the underlying SQS message, queue URL, region,
or AWS error code.

### `apps/web/app/api/core/[...path]/route.ts`

Four `coreRoute()` entries, in the existing style:

| segments | method | path | query |
|---|---|---|---|
| `['chat','conversations']` | `POST` | `/chat/conversations` | `NO_QUERY` |
| `['chat','conversations']` | `GET` | `/chat/conversations` | `new Set(['limit'])` |
| `['chat','conversations',<id>]` | `GET` | `/chat/conversations/${encodeURIComponent(id)}` | `NO_QUERY` |
| `['chat','conversations',<id>,'turns']` | `POST` | `/chat/conversations/${encodeURIComponent(id)}/turns` | `NO_QUERY` |

Plus, in `proxy()`, change `if (method === 'PUT')` to `if (method === 'PUT' || method === 'POST')`,
and set `content-type: application/json` **only when the parsed body is non-empty** — so
`POST /integrations/jira/disconnect` (no body today) keeps forwarding byte-identically.

### Python queue declaration

```python
CHAT_TURNS_QUEUE = "chat-turns.fifo"   # CH-03 declares; CH-04 consumes.
```
…added to `_PRODUCTION_QUEUES`, which is what makes `consume_once` refuse a consumer that supplies
no durable `delivery_store` and forces the existing visibility-heartbeat path.

### `docs/wave0-foundation-contracts.md`

One bullet appended to "Ingestion, events, and background work":

> - Ask Sayre conversation turns use a separate physical `chat-turns.fifo` SQS FIFO queue with its
>   own `chat-turns-dlq.fifo` dead-letter queue on the same five-receive redrive policy and 14-day
>   retention. Its message-group identity is the conversation id, so turns within one conversation
>   are processed in order while unrelated conversations progress concurrently. The core service
>   commits the user turn and its pending assistant turn before publishing; the consumer supplies
>   durable idempotency keyed on the envelope, and this queue is never subscribed to the
>   `graph.updated` topic.

## Approach

Build in this order:

1. **Migration + schema.** Write `0019_*.sql`, append the `_journal.json` entry, mirror both tables
   in `schema.ts` (plus `users_org_id_id_unique`), export the four `$infer*` types. Verify with
   `npm --prefix services/core run db:migrate` against a local Postgres.
2. **`chatStore.ts`.** All four operations run inside `withOrgContext(db, owner.orgId, …)`. Every
   query additionally filters `chat_conversations.user_id = owner.userId` — RLS gives org isolation,
   the explicit predicate gives owner-only. `appendTurnPair` is one transaction:
   1. `pg_advisory_xact_lock(hashtextextended(chatConversationLockKey(orgId, conversationId), 0))`
      — serializes concurrent posts to the same conversation, exactly as
      `PostgresAgentSkillMdStore.append` serializes version allocation.
   2. `select id from chat_conversations where id = $conversationId and user_id = $userId` — return
      `null` if absent (RLS has already excluded other orgs).
   3. `select * from chat_turns where org_id = … and conversation_id = … and idempotency_key = …` —
      if found, load its paired assistant turn (`request_turn_id = <found>.id`), recompute history
      against `<found>.seq`, and return `{ created: false, … }`.
   4. Otherwise: `seq := coalesce(max(seq), 0) + 1` for the user turn; insert the user turn
      (`role 'user'`, `status 'completed'`, `idempotency_key`, `scope`), then the assistant turn
      (`seq + 1`, `role 'assistant'`, `status 'pending'`, `content ''`, `request_turn_id` = user
      turn id).
   5. `update chat_conversations set updated_at = now() where id = …` so `listConversations` orders
      by real recency.
   6. Compute `history`: `select role, content from chat_turns where org_id = … and
      conversation_id = … and status = 'completed' and seq < <userTurn.seq> order by seq desc limit
      $historyLimit`, then reverse to ascending.
   7. Return `{ created: true, userTurn, assistantTurn, history }`.
3. **`sqs.ts`.** Add the constant, the pinned payload interface, and `publishChatTurnRequest`.
   Update the module header: this is a third, produce-only exception to the fleet-split consume
   direction, not a new queue system.
4. **`chatService.ts`.**
   - Every entry point first requires `ctx.subjectType === 'user'`, else `ChatForbiddenError`.
   - `orgId`/`userId` come only from `ctx`. Nothing reads `orgId`/`userId` from input.
   - Validate, then delegate. A `null` from the store becomes `ChatNotFoundError`.
   - `postTurn` after `appendTurnPair`:
     - If `result.assistantTurn.dispatchedAt !== null` → return without publishing (the duplicate,
       already-dispatched path).
     - Otherwise build the payload **with its keys written in the pinned order**, wrap it with
       `makeEnvelope({ org_id, type: 'chat.turn.request', source: 'sayre-core-chat', schema_version:
       1, idempotency_key: \`chat.turn:${assistantTurn.id}\`, payload })`, `await publish(envelope)`,
       then `await store.markTurnDispatched(owner, assistantTurn.id)`.
     - If the publish rejects (or `markTurnDispatched` rejects), throw `ChatEnqueueError`. Do not
       attempt to roll back the committed rows.
   - `history` is `result.history` verbatim (already bounded to `CHAT_HISTORY_MAX_TURNS` and
     ordered by the store).
5. **`routes/chat.ts` + `app.ts` + `http/express.ts`.** Keep every handler under the `max-statements:
   10` override; import nothing from `../db`, `../graph-query`, `pg`, `drizzle-orm`, `bullmq`,
   `ioredis`, or `neo4j-driver`.
6. **Queue provisioning.** LocalStack init hook, `.env.example`, Python constants + tests.
7. **Docs.** The `wave0-foundation-contracts.md` bullet.
8. **Web proxy.** Allowlist entries + POST body forwarding (OQ-1).

**Validation rules (all raise `ChatValidationError` with one issue string per failure)**

| Field | Rule |
|---|---|
| body | must be a non-null, non-array JSON object |
| `title` | absent/`null` → stored `null`; otherwise a string whose trimmed form is `''` → `null`, else trimmed, `≤ CHAT_TITLE_MAX_CHARACTERS`, no NUL |
| `idempotencyKey` | required string, trimmed length 8–200, matches `/^[A-Za-z0-9._:-]+$/u` |
| `question` | required string; trimmed non-empty; `≤ CHAT_QUESTION_MAX_CHARACTERS`; no NUL; stored trimmed |
| `scope` | absent/`null` → `{ view: null, anchorNodeId: null }`; otherwise an object |
| `scope.view` | absent/`null` → `null`; else exactly `'technical' \| 'product' \| 'onboarding'` |
| `scope.anchorNodeId` | absent/`null` → `null`; else a string, trimmed non-empty, `≤ CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS`, no NUL |
| `conversationId` (path) | must match the UUID regex used by `withOrgContext`; a non-UUID raises `ChatNotFoundError` (never reaches Postgres) |
| `limit` (query) | absent → `CHAT_CONVERSATION_LIST_DEFAULT_LIMIT`; else `/^\d{1,3}$/u` and 1…`CHAT_CONVERSATION_LIST_MAX_LIMIT` |

## Acceptance criteria

- **AC-1** — A first `postTurn` on an owned conversation persists exactly two `chat_turns` rows in
  one transaction: the user turn (`role='user'`, `status='completed'`, `content` = the trimmed
  question, `idempotency_key` set, `request_turn_id` null) and its assistant turn
  (`role='assistant'`, `status='pending'`, `content=''`, `request_turn_id` = the user turn's id,
  `seq` = user turn's `seq` + 1), and publishes exactly one message to `chat-turns.fifo`.
- **AC-2** — Re-posting to the same conversation with the same `idempotencyKey` returns the same
  `userTurn.id`/`assistantTurn.id`, inserts no additional rows, and — when the first attempt already
  recorded `dispatched_at` — performs no second publish.
- **AC-3** — When a first attempt committed its rows but its publish failed (`dispatched_at` still
  null), a retry with the same `idempotencyKey` re-publishes with the byte-identical
  `MessageDeduplicationId` and then records `dispatched_at`; still no additional rows are inserted.
- **AC-4** — Owner-only: for a conversation created by user A, a request authenticated as user B in
  the **same org** receives 404 from `GET /chat/conversations/:id` and from
  `POST /chat/conversations/:id/turns`, and `GET /chat/conversations` as B never includes A's
  conversation.
- **AC-5** — `org_id` and `user_id` are taken only from `requireAuthContext(req)`; an `orgId`,
  `userId`, or `org_id` supplied in the query string or request body changes nothing about the
  result. Structurally: `chat_turns` carries a composite FK `(org_id, conversation_id)` →
  `chat_conversations(org_id, id)`, `chat_conversations` carries `(org_id, user_id)` →
  `users(org_id, id)`, and both tables have `org_isolation` RLS `ENABLE`d and `FORCE`d.
- **AC-6** — The published envelope's `payload` matches the pinned `chat.turn.request.v1` contract
  exactly: the same key set in the same order, `schema` equal to the literal `"chat.turn.request.v1"`,
  `turnId` equal to the assistant turn's id, `orgId`/`userId` equal to the auth context's, `question`
  equal to the trimmed question, `scope` an object with exactly `view` and `anchorNodeId`, and
  `mcpCredential` equal to `null`.
- **AC-7** — `payload.history` contains at most `CHAT_HISTORY_MAX_TURNS` (12) entries: the most
  recent `status='completed'` turns strictly before the new user turn, in ascending `seq` order, each
  object having exactly the keys `role` and `content`.
- **AC-8** — The publish uses `MessageGroupId === conversationId` and a `MessageDeduplicationId`
  equal to the SHA-256 hex of `chat.turn:<assistantTurnId>`, so per-conversation ordering is
  preserved and a retry is transport-deduplicated.
- **AC-9** — `chat-turns.fifo` and `chat-turns-dlq.fifo` are created by the LocalStack init hook with
  the same 5-receive redrive policy and 14-day retention as every other lane, are physically distinct
  from every existing queue URL, and are not subscribed to the `graph-updated` SNS topic;
  `CHAT_TURNS_QUEUE` is present in the Python `_PRODUCTION_QUEUES` set, so `consume_once` refuses it
  without a durable `delivery_store`.
- **AC-10** — `docs/wave0-foundation-contracts.md`'s "Ingestion, events, and background work" section
  records `chat-turns.fifo`: FIFO, its DLQ, its conversation-id message group, and its durable-
  idempotency posture.
- **AC-11** — `services/core/src/routes/chat.ts` contains no business logic: `eslint . --ext .ts`
  passes with the `src/routes/**` override in force (each handler ≤ 10 statements, no import of
  `pg`/`drizzle-orm`/`bullmq`/`ioredis`/`neo4j-driver`/`**/db`/`**/graph-query`), and every handler
  is a call to `chatService` plus a response.
- **AC-12** — Error mapping: validation failure → 400 `{ error: 'invalid chat request', issues: [...] }`;
  a non-`user` subject → 403 `{ error: 'forbidden' }`; unknown or unowned conversation → 404
  `{ error: 'not found' }`; post-commit publish failure → 502 `{ error: 'chat turn could not be
  queued' }` with no SQS/AWS detail in the body.
- **AC-13** — The four routes are reachable through `apps/web/app/api/core/[...path]`: each maps to
  the intended core path, `limit` is the only forwarded query parameter, and a `POST` body arrives at
  core byte-identical to what the browser sent.

## Edge cases

- **EC-1** — `question` blank or whitespace-only → 400; no row inserted, no message published.
- **EC-2** — `question` longer than `CHAT_QUESTION_MAX_CHARACTERS` → 400; nothing persisted.
- **EC-3** — `idempotencyKey` missing, blank, shorter than 8, longer than 200, or containing a
  character outside `[A-Za-z0-9._:-]` → 400; nothing persisted.
- **EC-4** — `scope` omitted entirely → the payload still carries
  `scope: { view: null, anchorNodeId: null }` (never an omitted key, never `undefined`).
- **EC-5** — `scope.view` outside the three tree names, or `scope.anchorNodeId` non-string / blank /
  over `CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS` / containing a NUL → 400.
- **EC-6** — `conversationId` path parameter that is not a UUID → 404, raised before any SQL is
  issued (no Postgres `invalid input syntax for type uuid` reaching the 500 fallback).
- **EC-7** — A conversation belonging to a **different org** → 404 for both read and post; the row is
  invisible to the transaction because RLS filters it.
- **EC-8** — A conversation in the same org belonging to a **different user** → 404, not 403, for
  both read and post (existence non-disclosure).
- **EC-9** — Two concurrent `postTurn` calls with the **same** `idempotencyKey` on the same
  conversation → exactly one user/assistant pair exists afterward and exactly one message is
  published; the loser observes `created: false`.
- **EC-10** — Two concurrent `postTurn` calls with **different** `idempotencyKey`s on the same
  conversation → two pairs with distinct, contiguous `seq` values and no unique-constraint error.
- **EC-11** — First turn in a brand-new conversation → `history` is `[]`.
- **EC-12** — A conversation with more than 12 completed turns → exactly the newest 12, ascending.
  A prior assistant turn still `pending`/`running`, or one that ended in `error`, is excluded from
  history, while its (completed) user turn is still included — so a failed exchange appears as an
  unanswered question rather than being silently dropped.
- **EC-13** — The publish throws after the transaction committed → 502; both rows remain, the
  assistant turn stays `pending` with `dispatched_at` null, nothing is rolled back, and no queue URL,
  region, ARN, or AWS error code appears in the response body or a log line.
- **EC-14** — `listConversations` for a user with no conversations → `200 { "conversations": [] }`.
- **EC-15** — `limit` non-numeric, `0`, negative, or above `CHAT_CONVERSATION_LIST_MAX_LIMIT` → 400.
- **EC-16** — `getConversation` on a conversation with more than `CHAT_CONVERSATION_TURNS_LIMIT`
  turns → the newest 200, returned ascending by `seq`.
- **EC-17** — `title` omitted, `null`, or whitespace-only → stored as SQL `NULL`; `title` over
  `CHAT_TITLE_MAX_CHARACTERS` → 400.
- **EC-18** — Unauthenticated request in a non-dev environment → 401 from `authenticate()` before any
  `chatService` function runs.
- **EC-19** — Request body that is a JSON array, string, number, or `null` → 400 (never a 500 from
  property access on a non-object).
- **EC-20** — A `chat_turns` insert naming a `conversation_id` that belongs to a different `org_id`
  is rejected by the composite FK at the database layer, independent of any application check.
- **EC-21** — SQS accepts the send but returns no `MessageId` → treated as a publish failure (502);
  `dispatched_at` is not set, so the next retry with the same key re-publishes.
- **EC-22** — Web proxy: an unrecognised chat sub-path (e.g. `/api/core/chat/conversations/x/turns/y`)
  → 404 from the proxy without reaching core; a POST body over 64 KB → 413 from the proxy.
- **EC-23** — An `agent_key` auth context reaching any chat route → 403; no conversation is created,
  read, or posted to.

## Open questions

- **OQ-1 (the one that changes the diff).** The ticket says the routes "must be reachable through
  `apps/web/app/api/core/[...path]` **without web-side changes**." That is not true of the proxy as
  written: `coreRoute()` is a closed allowlist that 404s anything unlisted, and `proxy()` reads a
  request body only for `PUT`, so a `POST` currently arrives at core with **no body at all**. This
  spec therefore includes the minimal proxy change (four allowlist entries + POST body forwarding,
  content-type set only for a non-empty body so `jira/disconnect` is unaffected). It is not UI work
  and does not touch a component, hook, or page. **If the approver prefers a zero-`apps/web` diff for
  CH-03, strike AC-13 and EC-22 and hand both to CH-06** — but until someone does this, the sidebar
  cannot reach these endpoints at all, and a POST that silently loses its body is a nasty first bug
  for CH-06 to inherit.
- **OQ-2.** Ticket names the queue `chat-turns`; SQS requires a `.fifo` suffix on FIFO queues, and
  the existing topology test asserts a FIFO source has a FIFO DLQ. Resolved as `chat-turns.fifo` /
  `chat-turns-dlq.fifo`. Confirm the physical names with whoever writes CH-04.
- **OQ-3.** The pinned `chat.turn.request.v1` object is carried as the `payload` of the repo's
  standard snake_case `MessageEnvelope` (`type: 'chat.turn.request'`, `schema_version: 1`, `org_id`,
  `idempotency_key`), because the Python consumer's `consume_once` parses that envelope before a
  handler ever sees a payload — a bare payload on the queue would be rejected as malformed and never
  deleted. The payload object itself is byte-exact and key-ordered as pinned. Flagging because the
  ticket said "do not deviate", and this is the smallest faithful reading.
- **OQ-4.** `turnId` is the **assistant** turn's id (the row CH-04 must transition
  `pending → running → completed|error`, and the row CH-05 will key its events on). Confirm against
  CH-04's spec; if CH-04 expects the user turn id, this is a one-line change here and a large one
  there.
- **OQ-5.** Columns beyond the ticket's list: `seq` (Postgres `now()` is transaction-start time, so
  the user and assistant turns share a `created_at` to the microsecond and cannot be ordered by it),
  `idempotency_key` and `dispatched_at` (AC-1/AC-2/AC-3), `request_turn_id` (pairs the answer to its
  question; also what CH-05 needs), `scope` (so a repair republish rebuilds the identical payload),
  `updated_at` (every mutable table in `schema.ts` has it plus the `trigger_set_updated_at` trigger,
  and CH-04 mutates these rows). Confirm all six are acceptable.
- **OQ-6.** Unowned conversations return 404 rather than 403, so a member cannot enumerate which
  conversation ids exist in their org. Confirm that is the desired posture.
- **OQ-7.** There is deliberately **no** background dispatcher, lease loop, or second transactional
  outbox (W1-06's outbox in migration 0012 is documented as specific to `repo.initial_parse` and not
  a general event bus). The consequence: if a publish fails after commit, that turn stays `pending`
  until the client retries with the same idempotency key. If a server-side sweeper is wanted, it is a
  separate ticket, not a silent addition here.
- **OQ-8.** `CHAT_CONVERSATION_TURNS_LIMIT` (200), `CHAT_CONVERSATION_LIST_DEFAULT_LIMIT` (50),
  `CHAT_CONVERSATION_LIST_MAX_LIMIT` (100), `CHAT_QUESTION_MAX_CHARACTERS` (8 000) and
  `CHAT_ANCHOR_NODE_ID_MAX_CHARACTERS` (512) are invented bounds — the ticket pinned only the
  12-turn history bound. They exist so no response or payload is unbounded. Adjust freely; they are
  named constants, not literals.
- **OQ-9.** The ticket declared no lane (it was not filed through
  `.github/ISSUE_TEMPLATE/pipeline-ticket.yml`), so `spec.json.lane` is `null`. Note that the change
  set spans `services/core`, `services/workers`, `infra`, `docs`, and `apps/web` — i.e. it would need
  the `full` lane, not `frontend`, if one is assigned retroactively.

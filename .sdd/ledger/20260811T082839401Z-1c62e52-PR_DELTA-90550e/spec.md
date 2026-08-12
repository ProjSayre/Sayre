# CH-06 — Ask Sayre panel UI

## Ticket Check

**What I'm about to build**
A working "Ask Sayre" chat panel on the right-hand side of the workspace, in all three views (Technical, Product, Onboarding). Today that spot is a placeholder that says "not yet available" and does nothing. After this, a person can type a question about the repository they're looking at, watch Sayre report what it's doing while it works, and read the answer. The answer comes with little clickable source chips — clicking one jumps the map to the folder or file the answer came from. The whole panel can be collapsed to a thin strip when someone wants the full canvas.

**What I'm explicitly not doing**
- No word-by-word "typing" animation of the answer — the answer appears when it is finished.
- No chat history sidebar, no renaming, no switching between past conversations, no deleting. One conversation per workspace session; changing repository or branch starts fresh.
- Not making the panel something you can drag, resize, or rearrange in the workspace layout editor.
- Not touching the server. No change to the API, the realtime service, the Python workers, or the shared type package — this is entirely the browser app.

**How you'll know it worked**
Open a repository, expand the Ask Sayre panel on the right, and ask "what does this folder do?". You should see a chip above the box showing which view you're in and which file/folder is selected, then a running list of what Sayre is doing, then a written answer, then a row of source chips and a line like "12 context nodes · 4,300 tokens · 38× less than full repo". Click a source chip and the canvas should select and zoom to that file. Collapse the panel with the toggle and the whole thing should shrink to a strip; expand it again and it comes back. If nobody has set up an AI provider yet, the panel should say so and offer a button that takes you straight to that settings page instead of silently failing.

**What I had to guess**
- The realtime side of this (the piece that pushes progress updates to the browser) is being built in parallel as a separate ticket and isn't finished yet. I pinned the exact shape of the three messages the browser expects and built against that, with tests that simulate those messages. If the other ticket ships a different shape, the two have to be reconciled — that is the one real coordination risk here.
- The ticket didn't say how often to check for an answer when the live connection is unavailable, so I chose "every 3 seconds, up to 20 times (about a minute)", with a visible "Check again" button so a person is never stuck.
- The ticket didn't say what the panel should do in the demo/fixture workspace (the fake data mode). I chose: the panel appears but the question box is disabled with a stated reason, because there is no real backend there to answer.
- I chose to place the panel by mounting it directly in the workspace body rather than registering it as a rearrangeable layout region, because doing the latter properly would require changing a shared package this ticket is not allowed to touch.

## Goal

Turn the reserved inert AskSayre dock into a real, collapsible right-hand Ask Sayre chat panel mounted across the Technical, Product, and Onboarding views: it auto-attaches the current view + selected node as scope, posts questions through the existing core proxy to CH-03's chat routes, renders live progress and markdown answers driven by CH-05's pinned `chat.turn.*` WebSocket events, and lets a citation chip select and zoom the cited Folder/File node on the canvas. The entire diff is confined to `apps/web/`.

## Scope

### In
- A real, collapsible Ask Sayre dock replacing the inert placeholder in `apps/web/app/workspace/components/AskSayrePanel.tsx`, mounted once in the workspace body so it appears in all three views.
- A workspace-scoped chat provider that owns: lazy conversation creation, the transcript, a dedicated chat WebSocket, degraded REST polling, and REST reconciliation.
- A structurally-validating parser for the three pinned `chat.turn.*` gateway frames, plus parsers for citations, metrics, and the markdown answer.
- A REST client over the already-allowlisted core-proxy chat routes (`apps/web/app/api/core/[...path]/route.ts` already forwards all four CH-03 routes — no proxy change is needed or permitted).
- A pure transcript reducer implementing progress ordering/idempotency and terminal-event precedence.
- Citation-target resolution and dispatch through the existing `WorkspaceSelectionContextValue` mechanism.
- The scope chip, the composer, the per-view empty state, the provider-unconfigured notice, the inline error turn with retry, and the metrics footer.
- `apps/web/app/workspace/askSayreRegistry.ts` plus its dedicated renderer map.
- Workspace CSS for the dock/panel, and the one stale "not yet available" claim in `apps/web/app/mock/README.md`.

### Out (explicitly)
- **Token streaming.** The answer renders once, on `chat.turn.completed`. No partial-answer frame is parsed, rendered, or invented.
- **Conversation-management UI beyond one active conversation per workspace session.** No conversation list, no titling/renaming, no switching, no deletion, no history browser. `GET /chat/conversations` (the list route) is not called by this ticket.
- **Workspace edit-mode drag/drop integration.** The dock is not a `packages/workspace-packs` catalog component, is not placed in a layout region, and is not resizable/movable in `LayoutEditMode`.
- **Any diff outside `apps/web/`.** `services/gateway/` (CH-05's parallel lane), `services/core/`, `services/workers/`, and `packages/shared-types/` are out of bounds for this ticket. No gateway subscription verb is implemented here; no `GatewayToClientMessage` union member is added; no CH-03 route, service, or store is modified. `packages/workspace-packs/` is likewise untouched.
- Any client-side graph traversal, node-stripping, or permission predicate (see AC-15 and `.claude/rules/security-multitenancy.md`).
- Rendering Function or Class nodes on canvas in any form (see AC-6, EC-13, and `.claude/rules/graph-schema.md`).

## Affected files

### Created
| Path | Purpose |
| --- | --- |
| `apps/web/app/workspace/chat/chatContract.ts` | Constants, chat value types, `parseChatGatewayMessage`, `parseChatCitations`, `parseChatMetrics`, `formatChatMetrics`. |
| `apps/web/app/workspace/chat/answerMarkdown.ts` | `parseAnswerBlocks` — the safe markdown-to-blocks parser. |
| `apps/web/app/workspace/chat/citationTarget.ts` | `citationTarget` — the pure citation-to-canvas-action resolver. |
| `apps/web/app/workspace/chat/chatClient.ts` | REST client over the three chat routes this ticket uses, plus `ChatRequestError` and `newIdempotencyKey`. |
| `apps/web/app/workspace/chat/chatTranscript.ts` | Pure transcript reducer: `appendTurnPair`, `applyChatEvent`, `reconcileTranscript`, `hasActiveTurn`. |
| `apps/web/app/workspace/chat/ChatProvider.tsx` | `WorkspaceChatProvider` / `useWorkspaceChat` — conversation lifecycle, chat socket, degraded polling, scope, provider status, dispatch. |
| `apps/web/app/workspace/chat/AskSayrePanelBody.tsx` | Panel body: empty state, provider notice, degraded note, composer. |
| `apps/web/app/workspace/chat/ChatTranscriptList.tsx` | Transcript list: turn item, progress ticker, answer blocks, citation chips, metrics footer, error turn + retry. |
| `apps/web/app/workspace/chat/askSayreRenderers.tsx` | The dedicated renderer map for `askSayreRegistry`'s ids. |
| `apps/web/app/workspace/askSayreRegistry.ts` | The `'ask-sayre'` module definition, lookup, and per-view suggested prompts. |

### Modified
| Path | Change |
| --- | --- |
| `apps/web/app/workspace/components/AskSayrePanel.tsx` | `AskSayreDock` becomes the real collapsible dock (rail + panel) driven by the registry and the chat context. Its current `{ scopeLabel: string }` prop is removed — the dock derives scope from context, and there is no existing call site to break (the component is currently unmounted). |
| `apps/web/app/workspace/views/LegacyWorkspaceView.tsx` | Render `<AskSayreDock />` inside `WorkspaceBody`, after the `ReactFlowProvider`/`Workspace` block, so the dock is present in all three views and absent from the globally-blocked branch. |
| `apps/web/app/workspace/state/WorkspaceProvider.tsx` | Mount `WorkspaceChatProvider` inside `FocusedWorkspaceProviders`, innermost (inside `WorkspaceFixtureProvider`'s parent chain — it needs session, navigation, selection, and store). |
| `apps/web/app/workspace/workspace.css` | Replace the reserved `/* --- reserved "Ask Sayre" */` block (near line 2293) with the real dock/rail/panel/transcript/ticker/chip/footer styles. |
| `apps/web/app/mock/README.md` | Ask Sayre is no longer "reserved / not yet available" — correct the two lines that say so (lines ~33 and ~65). |

### Test files (authored by `red`, listed so paths are stable)
`apps/web/app/workspace/chat/chatContract.test.ts`, `chatTranscript.test.ts`, `citationTarget.test.ts`, `chatClient.test.ts`, `answerMarkdown.test.ts`, `AskSayrePanel.test.tsx`, and `apps/web/app/workspace/askSayreRegistry.test.ts`.

## Interfaces / signatures

### `apps/web/app/workspace/chat/chatContract.ts`

```ts
import type { ViewId } from '../types';

/** CH-03's own limit (services/core/src/services/chatService.ts). Mirrored, not imported — services/core is out of bounds. */
export const CHAT_QUESTION_MAX_CHARACTERS = 8_000;
export const CHAT_DEGRADED_POLL_INTERVAL_MS = 3_000;
export const CHAT_DEGRADED_POLL_MAX_ATTEMPTS = 20;
export const CHAT_PANEL_ELEMENT_ID = 'ask-sayre-panel';
export const CHAT_INPUT_ELEMENT_ID = 'ask-sayre-input';

export type ChatTurnRole = 'user' | 'assistant';
export type ChatTurnStatus = 'pending' | 'running' | 'completed' | 'error';
export type ChatProgressKind = 'status' | 'tool_call';

/** Closed presentational enum. 'unknown' is the client's own bucket for any kind it cannot draw. */
export type ChatCitationKind = 'file' | 'folder' | 'feature' | 'ticket' | 'unknown';
export const CHAT_DRAWABLE_CITATION_KINDS: readonly ChatCitationKind[] =
  Object.freeze(['file', 'folder', 'feature', 'ticket']);

export interface ChatScope {
  view: ViewId;
  anchorNodeId: string | null;
}

export interface ChatCitation {
  nodeId: string;
  label: string;
  kind: ChatCitationKind;
  resolvedNodeId: string | null;
}

export interface ChatMetrics {
  contextNodes: number;
  tokensUsed: number;
  baselineTokens: number;
  ratio: number;
}

export interface ChatTurnError {
  code: string;
  message: string;
}

export interface ChatProgressLine {
  seq: number;
  kind: ChatProgressKind;
  tool: string | null;
  detail: string | null;
  ts: string;
}

/**
 * PINNED WIRE CONTRACT — the three `chat.turn.*` frames CH-05 fans out, with the
 * worker envelope's `type` hoisted and its payload fields flattened (the same
 * shape `parseGatewayMessage` already uses for `graph.*`). Terminal frames carry
 * NO `seq` (see EC-7). Deliberately local to apps/web rather than added to
 * `@sayre/shared-types`'s `GatewayToClientMessage` — see Open questions OQ-1.
 */
export type ChatGatewayMessage =
  | ({ type: 'chat.turn.progress'; conversationId: string; turnId: string } & ChatProgressLine)
  | {
      type: 'chat.turn.completed';
      conversationId: string;
      turnId: string;
      answer: string;
      citations: ChatCitation[];
      metrics: ChatMetrics | null;
      ts: string;
    }
  | {
      type: 'chat.turn.error';
      conversationId: string;
      turnId: string;
      code: string;
      message: string;
      ts: string;
    };

/** Returns null for any non-JSON, non-object, or structurally invalid frame. Never throws. */
export function parseChatGatewayMessage(raw: unknown): ChatGatewayMessage | null;

/** Drops malformed entries; maps any kind outside CHAT_DRAWABLE_CITATION_KINDS to 'unknown'. */
export function parseChatCitations(value: unknown): ChatCitation[];

/** Returns null when metrics is missing, not an object, or has a non-numeric/non-finite field. */
export function parseChatMetrics(value: unknown): ChatMetrics | null;

/**
 * 'N context nodes · X tokens · R× less than full repo', or
 * 'N context nodes · X tokens' when baselineTokens is 0 or ratio is 0/negative/non-finite.
 * Never divides — it only formats the server-supplied ratio.
 */
export function formatChatMetrics(metrics: ChatMetrics): string;
```

### `apps/web/app/workspace/chat/answerMarkdown.ts`

```ts
export type AnswerBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string };

/**
 * Block-level only: ATX headings (#, ##, ###), fenced code (```), '-'/'*' bullets,
 * 'n.' ordered items, blank-line-separated paragraphs. Inline markup, raw HTML, and
 * URLs are NOT interpreted — every `text`/`items` value is emitted verbatim into a
 * React text node by the renderer. No anchor is ever constructed.
 */
export function parseAnswerBlocks(answer: string): AnswerBlock[];
```

### `apps/web/app/workspace/chat/citationTarget.ts`

```ts
import type { ChatCitation } from './chatContract';
import type { ViewId } from '../types';

export type CitationTarget =
  | { kind: 'select-node'; nodeId: string }
  | { kind: 'select-feature'; featureId: string }
  | { kind: 'none' };

export interface CitationTargetContext {
  view: ViewId;
  knownFeatureIds: ReadonlySet<string>;
}

/**
 * 'file' | 'folder'            -> select-node on resolvedNodeId ?? nodeId
 * 'feature', view 'product',
 *   id in knownFeatureIds      -> select-feature
 * 'feature' | 'ticket' with a
 *   non-null resolvedNodeId    -> select-node on resolvedNodeId
 * anything else ('unknown',
 *   unresolved feature/ticket) -> none
 */
export function citationTarget(
  citation: ChatCitation,
  context: CitationTargetContext,
): CitationTarget;
```

### `apps/web/app/workspace/chat/chatClient.ts`

```ts
import type { ChatCitation, ChatMetrics, ChatScope, ChatTurnError, ChatTurnRole, ChatTurnStatus } from './chatContract';

export interface ChatConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A server row, parsed. Client-local fields live on ChatTranscriptTurn, never here. */
export interface ChatTurnRecord {
  id: string;
  conversationId: string;
  seq: number;
  role: ChatTurnRole;
  content: string;
  status: ChatTurnStatus;
  citations: ChatCitation[] | null;
  metrics: ChatMetrics | null;
  error: ChatTurnError | null;
  createdAt: string;
}

export interface ChatConversationDetail {
  conversation: ChatConversation;
  turns: ChatTurnRecord[];
}

export interface PostTurnBody {
  question: string;
  scope: ChatScope;
  idempotencyKey: string;
}

export interface PostTurnResult {
  conversationId: string;
  userTurn: ChatTurnRecord;
  assistantTurn: ChatTurnRecord;
}

export class ChatRequestError extends Error {
  constructor(status: number | null, message: string);
  readonly status: number | null;
  /** true when status === 401 — EC-24's session-expiry signal. */
  readonly unauthenticated: boolean;
}

export interface ChatClient {
  /** POST /api/core/chat/conversations, body exactly `{}`. */
  createConversation(signal?: AbortSignal): Promise<ChatConversation>;
  /** GET /api/core/chat/conversations/:conversationId */
  getConversation(conversationId: string, signal?: AbortSignal): Promise<ChatConversationDetail>;
  /** POST /api/core/chat/conversations/:conversationId/turns, body exactly PostTurnBody. */
  postTurn(conversationId: string, body: PostTurnBody, signal?: AbortSignal): Promise<PostTurnResult>;
}

/** Concrete client over `coreFetch` (apps/web/app/lib/coreFetch.ts). Injectable for tests. */
export const chatClient: ChatClient;

/** Matches CH-03's /^[A-Za-z0-9._:-]{8,200}$/ — `crypto.randomUUID()` when available, random hex otherwise. */
export function newIdempotencyKey(): string;
```

Every non-2xx response, network failure, non-JSON body, or contract violation throws `ChatRequestError`; no chat response body is ever rendered raw except the sanitized `message` fields the contract defines.

### `apps/web/app/workspace/chat/chatTranscript.ts`

```ts
import type { ChatGatewayMessage, ChatProgressLine, ChatScope } from './chatContract';
import type { ChatConversationDetail, ChatTurnRecord } from './chatClient';

export interface ChatTranscriptTurn extends ChatTurnRecord {
  /** The scope this turn was posted with; null for turns first seen via reconcile. */
  scope: ChatScope | null;
  /** Locally accumulated, strictly increasing by seq. Survives reconcile (AC-12). */
  progress: ChatProgressLine[];
  lastProgressSeq: number | null;
}

export interface ChatTranscriptState {
  conversationId: string | null;
  /** Ascending by (seq, createdAt, id). No id appears twice. */
  turns: readonly ChatTranscriptTurn[];
}

export const emptyChatTranscript: ChatTranscriptState;

export function appendTurnPair(
  state: ChatTranscriptState,
  userTurn: ChatTurnRecord,
  assistantTurn: ChatTurnRecord,
  scope: ChatScope,
): ChatTranscriptState;

/**
 * Ignores: a message for another conversationId (EC-5); an unknown turnId (EC-6);
 * a duplicate or lower seq (EC-1, EC-2); progress after a terminal state (EC-4);
 * a second terminal event (EC-8). Never reads `seq` off a terminal frame (EC-7).
 * Pure — returns the same reference when nothing changed.
 */
export function applyChatEvent(
  state: ChatTranscriptState,
  message: ChatGatewayMessage,
): ChatTranscriptState;

/** Server row wins per field; no id duplicated, no known turn dropped, local progress preserved. */
export function reconcileTranscript(
  state: ChatTranscriptState,
  detail: ChatConversationDetail,
): ChatTranscriptState;

/** True when any assistant turn is 'pending' or 'running'. */
export function hasActiveTurn(state: ChatTranscriptState): boolean;
```

### `apps/web/app/workspace/askSayreRegistry.ts`

```ts
import type { ComponentType } from 'react';
import type { ViewId } from './types';

export type AskSayreModuleId = 'ask-sayre';

export interface AskSayreModuleDefinition {
  id: AskSayreModuleId;
  title: string;
  defaultOpen: boolean;
  capability: 'chat';
  availability: 'available' | 'reserved';
}

export const askSayreModules: readonly AskSayreModuleDefinition[] = Object.freeze([
  { id: 'ask-sayre', title: 'Ask Sayre', defaultOpen: true, capability: 'chat', availability: 'available' },
] satisfies AskSayreModuleDefinition[]);

export function askSayreModule(id: AskSayreModuleId): AskSayreModuleDefinition;

export const ASK_SAYRE_SUGGESTED_PROMPTS: Readonly<Record<ViewId, string>> = Object.freeze({
  technical: 'Explain this folder',
  product: 'What feature does this belong to?',
  onboarding: 'What should I start first?',
});

export interface AskSayreModuleRendererProps {
  definition: AskSayreModuleDefinition;
}

export type AskSayreModuleRenderer = ComponentType<AskSayreModuleRendererProps>;
```

`apps/web/app/workspace/chat/askSayreRenderers.tsx` holds the dedicated map (same split as `moduleRegistry.ts` / `drawer/nodeModuleRenderers.tsx`):

```ts
export const askSayreModuleRenderers: Readonly<Record<AskSayreModuleId, AskSayreModuleRenderer>>;
```

### `apps/web/app/workspace/chat/ChatProvider.tsx`

```ts
import type { ReactNode } from 'react';
import type { ProviderConfigurationStatus } from '../providerSettingsContract';
import type { ChatCitation, ChatScope } from './chatContract';
import type { ChatTranscriptTurn } from './chatTranscript';

export type ChatLiveStatus = 'connecting' | 'connected' | 'degraded';

export interface WorkspaceChatContextValue {
  expanded: boolean;
  turns: readonly ChatTranscriptTurn[];
  /** Byte-for-byte what postTurn will send (AC-8). */
  scope: ChatScope;
  /** Display label for scope.anchorNodeId, or null when no node is selected. */
  anchorLabel: string | null;
  /** True while any of this conversation's assistant turns is 'pending' or 'running'. */
  busy: boolean;
  live: ChatLiveStatus;
  /** 'unknown' whenever provider settings could not be read — never blocks the input (AC-10). */
  providerStatus: ProviderConfigurationStatus | 'unknown';
  /** Inline composer error text (EC-19), or null. */
  composerError: string | null;
  /** True when the workspace data source is not 'live' — composer disabled with a stated reason. */
  inert: boolean;
  setExpanded(expanded: boolean): void;
  /** Clears only scope.anchorNodeId; the view is untouched (AC-7). */
  dismissAnchor(): void;
  ask(question: string): void;
  /** Re-posts the stored question + stored scope of `turnId` under a NEW idempotency key (AC-11). */
  retry(turnId: string): void;
  /** Manual reconcile — the degraded path's 'Check again' (EC-9). */
  refresh(): void;
  activateCitation(citation: ChatCitation): void;
}

export function WorkspaceChatProvider({ children }: { children: ReactNode }): JSX.Element;

export function useWorkspaceChat(): WorkspaceChatContextValue;
```

Provider behaviour that is contract, not detail:
- Conversation id is created lazily on the first `ask` and held in a ref guarded so a second concurrent `ask` awaits the in-flight creation rather than issuing a second POST (AC-2).
- The chat socket is a **second, dedicated** `WebSocket` (the graph socket in `state/realtime.tsx` is not touched). URL from `browserRealtimeUrl(window.location, gatewayWsUrl ?? undefined, allowLocalGatewayFallback)`. On `open`: send `{ type: 'auth', token }` using `getStoredSessionToken()`. On a `ready` frame: send `{ type: 'subscribe', channel: 'chat', conversationId }` (CH-05's `ClientToGatewayMessage`, `@sayre/shared-types` — **amended round 2, re-gate fix**: this item previously pinned the non-existent `{ type: 'chat.subscribe', conversationId }`, which CH-05's real `decodeClientMessage` rejects outright; see review.md's C-1). On teardown: send `{ type: 'unsubscribe', channel: 'chat', conversationId }` (same amendment) when open, then close. Rendering never gates on a subscription ack.
- `null` URL, a constructor throw, or a close before `open` puts `live` at `'degraded'` (EC-9).
- Session expiry (`ChatRequestError.unauthenticated`, an `{ type: 'error', code: 'unauthenticated' }` frame, or close code `4401`) dispatches the store's existing `{ type: 'patch', patch: { session: 'session-expired' } }` and stops both the socket and polling (EC-24).
- Provider status comes from `providerConfigurationStatus(await source.providerSettings(signal).settings.generation)`; any rejection resolves to `'unknown'`.
- `knownFeatureIds` for `citationTarget` comes from the already-authorized `useWorkspaceQueries().graph.features` — a lookup over server-delivered data, not a traversal.

### React components

```ts
// apps/web/app/workspace/components/AskSayrePanel.tsx  (modified)
export function AskSayreDock(): JSX.Element;

// apps/web/app/workspace/chat/AskSayrePanelBody.tsx
export function AskSayrePanelBody({ definition }: AskSayreModuleRendererProps): JSX.Element;

// apps/web/app/workspace/chat/ChatTranscriptList.tsx
export function ChatTranscriptList({ turns }: { turns: readonly ChatTranscriptTurn[] }): JSX.Element;
export function ChatTurnItem({ turn }: { turn: ChatTranscriptTurn }): JSX.Element;
export function ChatProgressTicker({ lines }: { lines: readonly ChatProgressLine[] }): JSX.Element;
export function ChatCitationRow({ citations }: { citations: readonly ChatCitation[] }): JSX.Element;
export function ChatAnswer({ answer }: { answer: string }): JSX.Element;
export function ChatMetricsFooter({ metrics }: { metrics: ChatMetrics | null }): JSX.Element | null;
```

Required DOM contract:
- Dock expanded: a `<button type="button">` with an accessible name, `aria-expanded="true"`, `aria-controls="ask-sayre-panel"`, and a panel element with `id="ask-sayre-panel"`.
- Dock collapsed: a slim rail with exactly one labeled `<button type="button">` carrying `aria-expanded="false"`; `#ask-sayre-panel` is not in the DOM.
- Composer: `<form>` wrapping `<label for="ask-sayre-input">` + `<input id="ask-sayre-input" maxLength={CHAT_QUESTION_MAX_CHARACTERS}>` + a submit button.
- Progress ticker container: `role="status"` and `aria-live="polite"`.
- Empty/blank-question hint: an element with `role="status"`.
- Citation chip: `<button type="button">` when the target is not `'none'`, otherwise a non-interactive `<span>` carrying the "not on canvas" hint.

## Approach

Build in this order — each step is independently testable and the later steps only consume the earlier ones' exports.

1. **`chatContract.ts`** — constants, value types, and the four pure parsers/formatters. `parseChatGatewayMessage` validates every field of the three frames structurally and returns `null` on anything else; it never throws. Terminal frames deliberately do not read `seq`.
2. **`answerMarkdown.ts`** — `parseAnswerBlocks`. Block-level only; text passes through verbatim. No `dangerouslySetInnerHTML`, no URL/anchor construction anywhere in this directory.
3. **`citationTarget.ts`** — the pure resolver, exactly as specified in AC-5. No I/O, no React.
4. **`chatClient.ts`** — the three REST calls over `coreFetch`, `ChatRequestError`, `newIdempotencyKey`. Response bodies are validated into `ChatTurnRecord`/`ChatConversation` (reusing `parseChatCitations`/`parseChatMetrics`); a shape violation is a `ChatRequestError`, not a render-time throw.
5. **`chatTranscript.ts`** — the pure reducer. Get every ordering/idempotency/terminal-precedence rule (EC-1..EC-8, EC-10) right here, in pure functions, before any component exists.
6. **`ChatProvider.tsx`** — wire the pieces: lazy conversation, `ask`/`retry`, the dedicated chat socket, the degraded poller, mount-and-reconnect reconcile, scope + anchor dismissal, provider status, session-expiry handling, scope-change reset, and `activateCitation` dispatching through `useWorkspaceSelection()`.
7. **`askSayreRegistry.ts` + `chat/askSayreRenderers.tsx`** — the definition list, lookup, per-view prompts, and the one-renderer-per-id map.
8. **`AskSayrePanelBody.tsx` + `ChatTranscriptList.tsx`** — the panel body and transcript rendering against the DOM contract above.
9. **`components/AskSayrePanel.tsx`** — replace the inert dock with the collapsible rail/panel shell that reads the registry definition and renders the mapped renderer.
10. **Mount points** — `WorkspaceChatProvider` in `state/WorkspaceProvider.tsx`; `<AskSayreDock />` in `views/LegacyWorkspaceView.tsx`'s `WorkspaceBody`.
11. **`workspace.css`** — replace the reserved block with real styles (quiet mono for tool-call lines, chip row, footer).
12. **`apps/web/app/mock/README.md`** — drop the "reserved / not yet available" claim for Ask Sayre.
13. **Verify** in order: `npx tsc --noEmit`, then the `apps/web` test suite, then lint.

## Acceptance criteria

**AC-1** — Ticket AC1. Submitting a non-blank question calls ChatClient.postTurn against POST /api/core/chat/conversations/:id/turns with body exactly { question, scope: { view, anchorNodeId }, idempotencyKey } and appends the returned userTurn plus the pending assistantTurn to the transcript in ordinal order. No other field (org id, repository id, user id) is ever placed in the body.

**AC-2** — Ticket AC1. The conversation is created lazily exactly once per workspace session via POST /api/core/chat/conversations (body {}), reused by every later turn, and reset (transcript cleared, socket closed) when the repository/ref scope changes. A second concurrent ask never creates a second conversation.

**AC-3** — Ticket AC1. chat.turn.progress pushes for the active conversation and a known turnId promote that assistant turn from 'pending' to 'running' and render an ordered progress ticker; a 'tool_call' line renders the tool name and detail in the quiet mono style, a 'status' line renders only its detail.

**AC-4** — Ticket AC1. chat.turn.completed collapses the ticker and renders, in order, the markdown answer as safe block elements, the citation chip row, and the metrics footer formatted as 'N context nodes · X tokens · R× less than full repo'.

**AC-5** — Ticket AC2. citationTarget(citation, { view, knownFeatureIds }) resolves: kind 'file'|'folder' -> select-node on resolvedNodeId ?? nodeId; kind 'feature' in the product view with a known feature id -> select-feature; kind 'feature'|'ticket' otherwise with a non-null resolvedNodeId -> select-node; anything else -> none. The panel dispatches select-node through selection.selectNode when the current view is 'technical' and selection.openNodeInTechnicalView otherwise, and select-feature through selection.selectFeature — the same mechanism DependenciesModule already uses — so the cited node becomes the canvas focus and is zoomed to.

**AC-6** — Ticket AC2. A citation that resolves to 'none' renders as a non-interactive <span> chip carrying the 'not on canvas' hint and dispatches nothing. The accepted citation kind set is exactly file|folder|feature|ticket; any other kind is parsed to 'unknown' and can only resolve to 'none', so no code path in apps/web/app/workspace/chat/ can select or render a Function or Class node on canvas.

**AC-7** — Ticket AC3. The scope chip above the input shows the current view and, when a node is selected, that node's label; it is a real dismissible button. Dismissing clears only anchorNodeId (the view stays), and the anchor re-attaches when a different node is subsequently selected.

**AC-8** — Ticket AC3. The scope object sent in postTurn is byte-for-byte the chip's current state: { view: <current ViewId>, anchorNodeId: <selected node id or null after dismissal> }, and the turn stores that scope so a retry re-sends the same one.

**AC-9** — Ticket AC4. With no turns, the panel renders the empty state whose per-view suggested prompt is a real <button type="button"> ('technical' -> 'Explain this folder', 'product' -> 'What feature does this belong to?', 'onboarding' -> 'What should I start first?'); activating it submits that prompt as a turn.

**AC-10** — Ticket AC4. When providerConfigurationStatus(providerSettings().settings.generation) is not 'configured', the panel renders the provider-unconfigured notice, disables the input with a stated reason, and offers a labeled button that opens the 'providers' settings section via navigation.openSettings('providers'). Any failure to read provider settings (including the 403 a member receives) resolves to 'unknown' and does NOT block the input.

**AC-11** — Ticket AC4. chat.turn.error renders an inline error turn showing the server's sanitized message and a 'Try again' button; activating it re-posts that turn's stored question and scope with a NEW idempotency key and appends a fresh user + pending assistant pair.

**AC-12** — Ticket AC5. On provider mount with an existing conversation and on every (re)connect of the chat socket, GET /api/core/chat/conversations/:id reconciles the transcript by turn id: the Postgres status/content/citations/metrics/error win, no turn id is duplicated, no locally known turn is dropped, and locally accumulated progress lines survive.

**AC-13** — Ticket AC6. The composer is a <form> containing a labeled <input id="ask-sayre-input"> so Enter submits natively; the dock toggle, the scope chip, every drawable citation chip, the suggested-prompt buttons, and the retry button are all real <button type="button"> elements with accessible names, reachable by Tab and activated by Enter.

**AC-14** — Ticket AC6. The progress ticker is rendered inside a container carrying aria-live="polite" (and role="status") so appended progress lines are announced without stealing focus.

**AC-15** — Ticket AC7. The panel renders only server-delivered data. No module under apps/web/app/workspace/chat/ performs graph traversal, node-stripping, or any permission-like predicate; the only client-side filtering is the closed presentational citation-kind enum and canvas drawability, both of which are rendering decisions, not authorization.

**AC-16** — The 'ask-sayre' entry is registered in apps/web/app/workspace/askSayreRegistry.ts following the moduleRegistry conventions (id/title/defaultOpen/capability/availability plus a dedicated renderer map), every registered id has exactly one renderer, no new canonical data shape is introduced, and AskSayreDock renders the panel with the correct view-scoped chip and suggested prompt for each of 'technical', 'product', and 'onboarding'.

**AC-17** — The markdown answer is rendered through parseAnswerBlocks into React text nodes only: no dangerouslySetInnerHTML anywhere in apps/web/app/workspace/chat/, and no anchor/href is ever constructed from answer, citation, tool, or detail text.

**AC-18** — The dock is collapsible: expanded it renders the panel with a labeled toggle carrying aria-expanded="true" and aria-controls="ask-sayre-panel"; collapsed it renders only a slim rail whose single labeled button carries aria-expanded="false", and the panel body is not rendered.

## Edge cases

**EC-1** — A duplicate chat.turn.progress (same turnId and same seq delivered twice) is applied exactly once — the ticker shows one line, lastProgressSeq is unchanged by the repeat.

**EC-2** — Out-of-order progress (seq 3 then seq 2 for the same turnId) drops the lower seq; the rendered ticker order is strictly increasing and never rewrites already-rendered lines.

**EC-3** — Gapped progress (seq 1 then seq 4) renders both lines, invents no filler line for 2 and 3, and does not stall or buffer waiting for the gap to close.

**EC-4** — A chat.turn.progress arriving AFTER chat.turn.completed or chat.turn.error for the same turnId is ignored: the collapsed ticker is not reopened, the answer is not replaced, and status stays terminal.

**EC-5** — Any chat.turn.* push whose conversationId is not the active conversation is ignored entirely — no turn is created, mutated, or reordered.

**EC-6** — Any chat.turn.* push whose turnId is not already in the transcript is ignored — the client never fabricates a phantom turn from a push alone.

**EC-7** — Terminal events carry NO seq per the pinned contract; if a terminal event nevertheless carries one, the client ignores that field, never advances lastProgressSeq from it, and a later progress event is still compared only against the progress-derived lastProgressSeq.

**EC-8** — A second terminal event for the same turn (completed after error, error after completed, or completed twice) is ignored — the first terminal event wins and the rendered turn does not flip.

**EC-9** — The gateway WebSocket is unavailable or never connects (browserRealtimeUrl returns null, construction throws, or the socket closes before open): the panel enters the REST-only degraded path, polls GET /api/core/chat/conversations/:id every CHAT_DEGRADED_POLL_INTERVAL_MS while any assistant turn is non-terminal, stops after CHAT_DEGRADED_POLL_MAX_ATTEMPTS, and shows a visible note that live progress is unavailable plus a 'Check again' button. Turns still complete.

**EC-10** — Reconnect mid-turn: while the socket is down the turn completes server-side; on reconnect the REST reconcile adopts the completed row without duplicating the assistant turn, without losing it, and without re-appending the user turn.

**EC-11** — chat.turn.completed with citations: [] renders the answer and the metrics footer and omits the citation row entirely (no empty container, no placeholder chip).

**EC-12** — A 'feature' or 'ticket' citation with resolvedNodeId: null renders as a non-interactive chip with the 'not on canvas' hint and dispatches no selection.

**EC-13** — A citation whose kind is a value the client does not draw (anything outside file|folder|feature|ticket, including 'function' or 'class') is parsed to kind 'unknown', kept in the citation list so the evidence is not silently dropped, rendered non-interactive with the 'not on canvas' hint, and can never produce a selection.

**EC-14** — metrics.baselineTokens is 0, or ratio is 0/negative/non-finite: the footer renders 'N context nodes · X tokens' and omits the 'R× less than full repo' clause. The client never divides baselineTokens by tokensUsed — it only formats the server-supplied ratio — so no divide-by-zero is reachable.

**EC-15** — metrics is missing, not an object, or has a non-numeric/non-finite field: parseChatMetrics returns null, no footer renders, and the answer and citations still render.

**EC-16** — chat.turn.error with code 'chat.mcp_unauthorized' — including the case of a turn that sat in queue backlog past the 300s ephemeral-credential TTL — renders the same inline error turn with a working 'Try again' affordance; no credential, provider, or queue detail is displayed.

**EC-17** — Submitting while this conversation's own turn is pending or running: the input is disabled with a stated reason, and a programmatic submit performs no request and appends no turn.

**EC-18** — An empty or whitespace-only question performs no request, appends no turn, leaves the field contents untouched, keeps the submit button disabled, and shows a role="status" hint.

**EC-19** — POST /chat/conversations or POST .../turns fails (400, 502, network, malformed JSON, contract violation): an inline composer error with a retry is shown, the question text is preserved for editing, and no phantom user or assistant turn is left in the transcript.

**EC-20** — A malformed WebSocket frame (non-JSON, non-object, missing/wrongly-typed conversationId, turnId, seq, kind, ts, answer, code, or message) makes parseChatGatewayMessage return null; the frame is discarded without throwing and without touching transcript state.

**EC-21** — The answer markdown contains raw HTML, a <script> tag, or a javascript: URL: it is rendered as literal text through React text nodes; no HTML is injected and no anchor is constructed from answer content.

**EC-22** — The repository or ref scope changes mid-conversation: the transcript is cleared, the chat socket is unsubscribed and closed, degraded polling stops, and no turn from the previous scope remains rendered.

**EC-23** — A question longer than CHAT_QUESTION_MAX_CHARACTERS (8000, CH-03's limit) is capped by the input's maxLength; if the server still rejects it, the 400 surfaces through EC-19's inline composer error rather than a thrown render.

**EC-24** — Session expiry — a 401 from any chat REST call, or a gateway 'error' frame with code 'unauthenticated', or a socket close with code 4401 — stops polling and the socket and defers to the workspace's existing session-expired handling rather than showing a chat-specific message or retrying in a loop.

**EC-25** — The active view changes while a turn is pending: the pending turn keeps the scope it was posted with (its stored turn.scope), while the composer's chip immediately reflects the new view for the next question.

**EC-26** — A citation chip is activated while the current view is 'product' or 'onboarding' and resolves to select-node: the panel uses selection.openNodeInTechnicalView so the Technical Tree becomes active and the node is selected there, rather than selecting an id the current canvas cannot draw.

## Open questions

**OQ-1 — Should the three pinned `chat.turn.*` variants eventually join `@sayre/shared-types`'s `GatewayToClientMessage` union?**
This ticket deliberately keeps `ChatGatewayMessage` as an `apps/web`-local, structurally-validated type in `chat/chatContract.ts` rather than extending the shared union, for two reasons: `packages/shared-types/` is outside `apps/web/` and this ticket's diff is confined to `apps/web/`, and CH-05 owns the gateway side of the contract. The cost is one duplicated shape, and the risk is that the local parser and the eventual shared type drift. Recommendation for a follow-up ticket that legitimately spans both packages: move the three variants into `GatewayToClientMessage`, have `chat/chatContract.ts` import them, and keep the runtime parser here (a shared type is not a runtime guard). **Needs a human decision on whether that follow-up is filed now or deferred.**

**OQ-2 — Dependence on CH-05 for a live end-to-end path.**
Nothing in this ticket may require running gateway code, and nothing does: every behavioral test drives `parseChatGatewayMessage` / `applyChatEvent` with hand-built frames, or a fake `WebSocket`, and the degraded REST-only path (EC-9) is a first-class, fully-tested mode — turns still complete with the gateway entirely absent. What CH-06 *pins unilaterally*, and what CH-05 must therefore match for a live path to exist, is:
  1. the frame shape — the worker envelope's `type` hoisted to a top-level `type` and its payload fields flattened alongside (`{ type: 'chat.turn.progress', conversationId, turnId, seq, kind, tool, detail, ts }` and the two terminal variants), mirroring how `graph.delta`/`graph.resync` already arrive;
  2. terminal frames carrying **no** `seq` (EC-7 makes the client tolerant either way, but the contract says no);
  3. the subscription verbs `{ type: 'subscribe', channel: 'chat', conversationId }` / `{ type: 'unsubscribe', channel: 'chat', conversationId }` after the existing `auth` → `ready` handshake, with the client never gating rendering on an ack. **Amended round 2, re-gate fix:** this bullet previously pinned `{ type: 'chat.subscribe', conversationId }` / `{ type: 'chat.unsubscribe', conversationId }` — a shape CH-05's now-real gateway (`packages/shared-types`'s `ClientToGatewayMessage`, `services/gateway/src/ws/protocol.ts`) never accepted. That mismatch was invisible while CH-05 was a mocked parallel lane; review.md's C-1 (this ticket's re-gate against CH-05's real gateway) caught it. The verb/shape correction above is CH-05's actual, ratified contract, confirmed field-for-field against `packages/shared-types/src/index.ts`.
If CH-05 lands a different frame shape or verb, reconciling the two is a follow-up on the `apps/web` side only. **Needs confirmation from whoever owns CH-05 that these three points are acceptable, ideally before CH-05 merges.**

**OQ-3 — Behaviour in the fixture / mock data source.**
The ticket says nothing about the non-`live` workspace data source, which has no chat backend behind it. Resolved here as: the dock still renders (so layout and the collapsible affordance are exercisable), but `inert` is true — the composer is disabled with a stated reason and no conversation is created, no socket opens, and no poll runs. The alternative (hiding the dock entirely in fixture mode) would make the mock workspace stop resembling the product. **Flagging in case the intended demo story is the opposite.**

**OQ-4 — Degraded-poll constants.**
`CHAT_DEGRADED_POLL_INTERVAL_MS = 3_000` and `CHAT_DEGRADED_POLL_MAX_ATTEMPTS = 20` (≈60s of polling) are chosen, not specified by the ticket. The ACs/ECs reference the constants by name rather than by value, so tuning them later is not a spec amendment. **Confirm the ~60s ceiling is acceptable before a long-running turn is common.**

**OQ-5 — Layout placement.**
The dock is mounted directly in `views/LegacyWorkspaceView.tsx`'s `WorkspaceBody` rather than registered as a `packages/workspace-packs` catalog component in a layout region, because the latter requires a change in `packages/workspace-packs/` (outside `apps/web/`) and would drag in the edit-mode drag/drop integration this ticket explicitly excludes. **A follow-up ticket should decide whether Ask Sayre becomes a first-class, rearrangeable region.**

**OQ-6 — Node label for the scope chip.**
AC-7 requires the chip to show "that node's label". This spec resolves it as a lookup of `selection.selectedNodeId` in the already-authorized `useWorkspaceQueries().graph.nodes` (a server-delivered list — not a traversal, per AC-15), falling back to the raw id when the node is not in the currently loaded view's node set. **Confirm that showing the raw id is acceptable in that fallback rather than showing no anchor at all.**

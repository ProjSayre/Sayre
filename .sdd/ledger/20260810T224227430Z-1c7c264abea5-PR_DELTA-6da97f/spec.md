# CH-02 — get_ready_tickets service function + MCP tool

## Ticket Check

**What I'm about to build**
Sayre will be able to answer "which tickets are unblocked and ready to start?" from the code graph
alone, with no guessing. It returns a list of tickets that are still open and whose prerequisite
tickets are all finished, sorted into groups by the product feature each one belongs to (with a
"no feature" group at the end for the rest). The same answer is available to Sayre's own chat
assistant and to any outside AI agent connected to Sayre through its agent gateway.

**What I'm explicitly not doing**
No screens, no chat window, no chat behaviour — that is the other tickets in this set. Nothing here
creates, edits, closes, or reorders a ticket in Jira or Linear; this only reads what has already been
synced. It does not invent any new kind of thing in the graph, and it adds no new web address (API
route) to the product — the answer is reachable through the agent gateway and through Sayre's own
internal code, not through a public URL.

**How you'll know it worked**
Point an MCP client (Claude Code, or Sayre's own agent) at the Sayre gateway with a valid key, list
the available tools, and see a new one called `get_ready_tickets`. Call it with no arguments and get
back a grouped list of ready tickets. Call it twice and get the identical answer both times. Use a
key that is scoped to a different organisation (or to only part of a repository) and see none of the
first organisation's tickets come back.

**What I had to guess**
Five things, all of which the ticket left open and any of which you can overrule:
1. **The tool takes no arguments at all.** It returns every ready ticket the caller's key is allowed
   to see, across every repository that key covers, capped at 200. The alternative was requiring the
   caller to name a repository first; I judged that worse for the "what should I start first?"
   question, which nobody wants to answer by first looking up a repository ID.
2. **What counts as "done", "in progress", and "not started".** Jira and Linear let each team invent
   its own status names, so I wrote down an explicit list of the common ones. Anything not on the
   list is treated as *unknown*, and unknown is deliberately unhelpful in both directions: an unknown
   ticket is never offered as ready, and an unknown prerequisite never counts as finished. That means
   a team with unusual status names gets fewer answers rather than wrong ones.
3. **Who is allowed to see tickets.** Tickets are not attached to a file or folder, so a key that is
   scoped to a sub-folder of a repository cannot be checked against them. Such a key sees no tickets
   at all; only a key granted the whole repository does. This copies exactly how the existing
   onboarding-steps feature already handles the same problem.
4. **Nothing in Sayre currently records that one ticket blocks another, or that a ticket belongs to a
   feature.** The links this reads (prerequisite links, and the feature-membership link the ticket
   asked for by name) are ones nothing writes yet. So on today's real data this will correctly report
   every open ticket as ready, all in the "no feature" group. That is honest, not broken — but it
   means the flagship demo needs a follow-up ticket that writes those links, or a decision to reuse
   the feature link that *is* already written today (see Resolved decisions 1 and 2).
5. **When a ticket belongs to more than one feature**, it is listed once, under the
   alphabetically-first one, rather than appearing twice.

## Goal

Give Sayre a deterministic, graph-computed answer to "which tickets are unblocked and ready to start
right now?" — an ordered, feature-grouped list of open tickets whose prerequisite tickets are all
done — exposed once as a service-layer function and once as a read-only MCP tool, so the CH-04 chat
agent and any external MCP client get the identical, server-authorized answer with the model only
narrating it.

## Scope

**In**

- A new service-layer module `services/core/src/services/ticketReadinessService.ts` exporting
  `getReadyTickets(ctx, graph?)`, the status-classification vocabulary it uses, and the result types.
- A new Graph Query Service read: `TicketReadinessGraphQueryService.getTicketReadiness(ctx)`, its
  openCypher constant `GET_READY_TICKETS_CYPHER`, and its record mapper, all inside the existing
  `services/core/src/graph-query/` boundary, implemented on `RbacGraphQueryService`.
- A new MCP tool `get_ready_tickets` registered in `services/core/src/mcp/gateway.ts` with the same
  `READ_ONLY` annotations object every existing tool uses, plus the thin handler
  `services/core/src/mcp/handlers/getReadyTickets.ts` and its `McpToolServices` entry.
- The mechanical fallout of adding a tenth tool: `handlerContract.test.ts`'s expected handler-file
  list, `gateway.test.ts`'s tool inventory + fixture, the MCP interop harness's `V1_TOOL_CASES` and
  fixture gateway, `MCP_TOOL_CONTRACT.md`, and `docs/mcp-gateway.md`.
- `packages/graph-schema/schema.md`: record the endpoint pairs this read relies on
  (`REQUIRES`/`DEPENDS_ON` between two `Ticket`s, `PART_OF` from `Ticket` to `Feature`). No new label,
  no new relationship type.
- **Bounded, declared incidental fix:** `services/core/src/mcp/gateway.test.ts`'s `fixtureServices()`
  object is currently missing the `checkLiveness` property required by `McpToolServices` (it is
  invisible today only because `services/core/tsconfig.json` excludes `*.test.ts`). Dev must add the
  missing `checkLiveness` entry alongside the new `getReadyTickets` entry rather than leave a
  knowingly-incomplete literal in a file it is already editing, and must call this out explicitly in
  `changes.md`. Nothing else in that file may change beyond what the new tool requires.
- **Bounded, declared incidental fix:** `MCP_TOOL_CONTRACT.md`'s "For each of the eight tools" /
  "16 local-model selections and 32 measured MCP calls" paragraph is already stale (there are nine
  tools today). Dev updates those three numbers to the post-change values (ten / 20 / 40).

**Out**

- Any UI, chat panel, chat loop, agent loop, WebSocket event, or prompt template (CH-03..CH-06).
- Any ticket write, mutation, status transition, or ordering suggestion ("which one *should* I do"
  ranking beyond the deterministic sort defined below).
- Any writer that creates `Ticket -[:REQUIRES|DEPENDS_ON]-> Ticket` or `Ticket -[:PART_OF]-> Feature`
  edges. This ticket is read-only; the edges are consumed if present.
- Any new node label or relationship type. The closed sets in `.claude/rules/graph-schema.md` suffice.
- Any new REST route under `services/core/src/http/` or `apps/web/`. The capability is reachable
  through the service layer and the MCP gateway only.
- Any change to `services/core/src/services/ticketSyncService.ts`, the ticket providers, the ticket
  cache store, or `graphTicketStore.ts`.
- Any Postgres schema/migration change. The read is graph-only; permissions come from the existing
  `PostgresPermissionStore`.
- Any change to `RbacGraphQueryService`'s existing methods or their Cypher.

## Affected files

**Created**

| Path | Purpose |
|---|---|
| `services/core/src/services/ticketReadinessService.ts` | The service-layer function, status vocabulary, result types. |
| `services/core/src/services/ticketReadinessService.test.ts` | Behavioral tests for readiness/grouping/ordering/classification (AC-1..AC-3, AC-9..AC-11 and most ECs). |
| `services/core/src/graph-query/ticketReadiness.test.ts` | Behavioral tests for the graph boundary: org isolation, RBAC, mapper de-duplication, row-cap truncation, and the schema-doc assertion (AC-4..AC-6, AC-13). |
| `services/core/src/mcp/handlers/getReadyTickets.ts` | Thin MCP handler; delegates, holds no logic. |

**Modified**

| Path | Change |
|---|---|
| `services/core/src/graph-query/types.ts` | Add `TicketReadinessPrerequisite`, `TicketReadinessFeature`, `TicketReadinessTicket`, `TicketReadinessGraphQueryService`. |
| `services/core/src/graph-query/index.ts` | Add `GET_READY_TICKETS_CYPHER`, `GET_READY_TICKETS_ROW_LIMIT`, the `mapTicketReadiness` mapper, the `getTicketReadiness` method on `RbacGraphQueryService`, the new interface in its `implements` list, and the new interface in the exported `graphQueryService` const's type union. |
| `services/core/src/mcp/toolServices.ts` | Add `getReadyTickets(ctx)` to `McpToolServices` and wire it to the service function. |
| `services/core/src/mcp/gateway.ts` | Import the handler; `server.registerTool('get_ready_tickets', …)` with `READ_ONLY` annotations and **no** `inputSchema`. |
| `services/core/src/mcp/handlerContract.test.ts` | Add `'getReadyTickets.ts'` to the expected handler-file list. |
| `services/core/src/mcp/gateway.test.ts` | Add `get_ready_tickets` to the expected `listTools` inventory and to the `calls` table; add `getReadyTickets` (and the missing `checkLiveness`) to `fixtureServices()`; bump the measurement-count assertions accordingly. |
| `services/core/test/mcp-interop/contract.ts` | Add `'get_ready_tickets'` to `InteropToolCase['name']` and a `{ name: 'get_ready_tickets', arguments: {} }` entry to `V1_TOOL_CASES`. |
| `services/core/test/mcp-interop/fixtureGateway.ts` | Add a `getReadyTickets` implementation to `fixtureServices` (required: this file is typechecked by `npm run typecheck`). |
| `MCP_TOOL_CONTRACT.md` | Add a `### \`get_ready_tickets\`` section (asserted by `interop.test.ts`), a line covering zero-argument tools in "Input rules", and the corrected tool/selection/call counts. |
| `docs/mcp-gateway.md` | Add `get_ready_tickets()` to the tool list and a short section describing it. |
| `packages/graph-schema/schema.md` | Extend the `REQUIRES`, `DEPENDS_ON`, and `PART_OF` rows' canonical-direction column with the ticket endpoint pairs. |

`node_modules` was still installing in this worktree while this spec was written; if a command fails
purely on a missing dependency, note it in the stage report rather than working around it.

## Interfaces / signatures

### 1. Graph Query Service types — `services/core/src/graph-query/types.ts` (additions)

```ts
/**
 * Ticket and Feature carry no `path`, so they are authorized exactly the way the
 * Onboarding projection already authorizes pathless EnvStep nodes: by a
 * repository-root-level grant (`path_prefix IS NULL`) for the ticket's own
 * (repo_id, ref_name). A path-scoped grant therefore authorizes no Ticket at all —
 * fail-closed by construction, not by convention.
 */
export interface TicketReadinessPrerequisite {
  /** Prerequisite Ticket node uid. Present even when `visible` is false. */
  id: string;
  /** Raw provider status. ALWAYS null when `visible` is false. */
  status: string | null;
  /** False when the prerequisite exists but is outside the caller's read scope. */
  visible: boolean;
}

export interface TicketReadinessFeature {
  id: string;
  name: string;
}

export interface TicketReadinessTicket {
  id: string;               // Ticket.uid
  externalId: string;       // Ticket.external_id, e.g. "SAY-142"
  system: string;           // Ticket.system, 'jira' | 'linear' as stored
  title: string | null;
  status: string | null;    // raw provider status name, unclassified
  url: string | null;       // http/https only (safeWebUrl), else null
  repositoryId: string;     // Ticket.repo_id
  refName: string;          // Ticket.ref_name
  /** De-duplicated by prerequisite id, ordered by id ascending. */
  prerequisites: TicketReadinessPrerequisite[];
  /** Lowest-ordered (name, id) PART_OF Feature, or null when the ticket has none. */
  feature: TicketReadinessFeature | null;
}

/**
 * Kept separate from GraphQueryService so existing canvas/realtime/retrieval test
 * doubles do not need a ticket method. RbacGraphQueryService implements it, and
 * services/ticketReadinessService depends only on this narrow contract.
 */
export interface TicketReadinessGraphQueryService {
  getTicketReadiness(ctx: AuthContext): Promise<TicketReadinessTicket[]>;
}
```

### 2. Cypher — `services/core/src/graph-query/index.ts` (addition)

```ts
/**
 * Row cap. When the executor returns exactly this many records the result may
 * have been truncated mid-ticket, so the mapper drops the final row's ticket —
 * a partially-read prerequisite list must never be able to make a blocked
 * ticket look ready.
 */
export const GET_READY_TICKETS_ROW_LIMIT = 4096;

export const GET_READY_TICKETS_CYPHER = `
MATCH (ticket:Ticket)
WHERE ticket.org_id = $org_id
  AND ticket.uid IS NOT NULL
  AND ticket.external_id IS NOT NULL
  AND ticket.system IS NOT NULL
  AND ticket.repo_id IS NOT NULL
  AND ticket.ref_name IS NOT NULL
  AND ANY(rule IN $allow_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = ticket.repo_id) AND
    (rule.branch IS NULL OR rule.branch = ticket.ref_name) AND
    rule.path_prefix IS NULL)
  AND NOT ANY(rule IN $deny_rules WHERE
    (rule.repo_id IS NULL OR rule.repo_id = ticket.repo_id) AND
    (rule.branch IS NULL OR rule.branch = ticket.ref_name) AND
    rule.path_prefix IS NULL)
OPTIONAL MATCH (ticket)-[prerequisite_edge]->(prerequisite:Ticket)
WHERE prerequisite_edge.org_id = $org_id
  AND prerequisite.org_id = $org_id
  AND prerequisite.uid IS NOT NULL
  AND type(prerequisite_edge) IN ['REQUIRES', 'DEPENDS_ON']
OPTIONAL MATCH (ticket)-[membership:PART_OF]->(feature:Feature)
WHERE membership.org_id = $org_id
  AND feature.org_id = $org_id
  AND feature.uid IS NOT NULL
  AND feature.name IS NOT NULL
  AND feature.repo_id = ticket.repo_id
  AND feature.ref_name = ticket.ref_name
RETURN ticket.uid AS ticket_id,
       ticket.org_id AS ticket_org_id,
       ticket.external_id AS ticket_external_id,
       ticket.system AS ticket_system,
       ticket.title AS ticket_title,
       ticket.status AS ticket_status,
       ticket.url AS ticket_url,
       ticket.repo_id AS ticket_repo_id,
       ticket.ref_name AS ticket_ref_name,
       prerequisite.uid AS prerequisite_id,
       prerequisite.org_id AS prerequisite_org_id,
       prerequisite.repo_id AS prerequisite_repo_id,
       prerequisite.ref_name AS prerequisite_ref_name,
       prerequisite.status AS prerequisite_status,
       prerequisite_edge.org_id AS prerequisite_edge_org_id,
       type(prerequisite_edge) AS prerequisite_edge_type,
       feature.uid AS feature_id,
       feature.name AS feature_name,
       feature.org_id AS feature_org_id,
       feature.repo_id AS feature_repo_id,
       feature.ref_name AS feature_ref_name,
       membership.org_id AS membership_org_id
ORDER BY ticket_external_id, ticket_id, feature_name, feature_id, prerequisite_id
LIMIT ${GET_READY_TICKETS_ROW_LIMIT}
`;
```

Notes that are load-bearing, not stylistic:

- **The prerequisite is deliberately NOT RBAC-filtered inside the query.** Filtering it there would
  turn "there is a prerequisite you may not see" into "there is no prerequisite", which is the exact
  wrong direction. It is org-scoped in the query and authorization-classified in the mapper instead.
- `type(prerequisite_edge) IN ['REQUIRES', 'DEPENDS_ON']` over an untyped relationship matches
  `GET_STRUCTURAL_EDGES_CYPHER`'s existing house idiom and stays plainly openCypher-portable.
- `ticket.org_id = $org_id` satisfies `assertOrgScopedCypher`'s predicate check
  (`services/core/src/security/graphOrgGuard.ts`) and the static scan in
  `services/core/src/security/cypherOrgIdScan.test.ts`, which enumerates every `*_CYPHER` export from
  `graph-query/index.ts` automatically — no test change needed there, but the constant must keep the
  `_CYPHER` suffix and stay exported.
- `ORDER BY` on RETURN aliases mirrors `GET_NODE_OVERLAY_CYPHER`.

### 3. Graph Query Service method — `services/core/src/graph-query/index.ts` (addition)

```ts
async getTicketReadiness(ctx: AuthContext): Promise<TicketReadinessTicket[]>
```

on `RbacGraphQueryService` (added to its `implements` list and to the exported `graphQueryService`
const's type union). Behaviour, in order:

1. `const scope = await this.permissions.getReadScope(ctx);` — no `repoId` argument (the read is
   org-wide across the caller's authorized repositories).
2. `if (scope.allows.length === 0) return [];` — no graph round trip, mirroring every sibling method.
3. `this.graph.run(ctx.orgId, 'traversal', GET_READY_TICKETS_CYPHER, { org_id: ctx.orgId, ...scopeParameters(scope) })`.
4. `return mapTicketReadiness(result.records, ctx.orgId, scope);`

Mapper `mapTicketReadiness(records, orgId, scope): TicketReadinessTicket[]` (module-private):

- Reuses the existing helpers `valueAsString`, `valueAsOptionalString`, `safeWebUrl`,
  `canReadResource`.
- **Ticket row admission:** `ticket_id`, `ticket_external_id`, `ticket_system`, `ticket_repo_id`,
  `ticket_ref_name` all non-empty; `ticket_org_id === orgId`; and
  `canReadResource(scope, { repoId: ticket_repo_id, refName: ticket_ref_name, path: '' })` — the
  TypeScript mirror of the query's `path_prefix IS NULL` predicate, the same defense-in-depth
  repetition every other mapper in this file performs. A row failing any of these is skipped.
- **Identity conflict:** if the same `ticket_id` appears on two rows with differing identity fields
  (external id, system, title, status, url, repo, ref), the ticket is dropped entirely and never
  re-added — the same posture `distinctFeatureClusters` takes with its `invalidClusters` set.
- **Prerequisites:** admitted when `prerequisite_id` is non-empty, `prerequisite_org_id === orgId`,
  `prerequisite_edge_org_id === orgId`, and `prerequisite_edge_type` is `'REQUIRES'` or
  `'DEPENDS_ON'`. A prerequisite whose id equals the ticket's own id is dropped (see EC-6). For an
  admitted prerequisite,
  `visible = canReadResource(scope, { repoId: prerequisite_repo_id, refName: prerequisite_ref_name, path: '' })`
  (false whenever repo/ref are missing), and `status = visible ? valueAsOptionalString(record, 'prerequisite_status') : null`.
  De-duplicated by id; sorted by `id.localeCompare`.
- **Feature:** admitted when `feature_id`/`feature_name` non-empty, `feature_org_id === orgId`,
  `membership_org_id === orgId`, `feature_repo_id === ticket_repo_id`, and
  `feature_ref_name === ticket_ref_name`. All admitted features are collected; the ticket's `feature`
  is the lowest by `name.localeCompare(name) || id.localeCompare(id)`.
- **Truncation guard:** if `records.length >= GET_READY_TICKETS_ROW_LIMIT`, read `ticket_id` off the
  final record and delete that ticket from the result map (its prerequisite list may be incomplete).
- Returns tickets ordered by `externalId.localeCompare(externalId) || id.localeCompare(id)`.

### 4. Service layer — `services/core/src/services/ticketReadinessService.ts` (new)

```ts
import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  TicketReadinessGraphQueryService,
  TicketReadinessTicket,
} from '../graph-query/types';

/**
 * Jira and Linear both expose a free-text workflow status name, so this is a
 * closed, documented vocabulary rather than an inference. Anything outside it —
 * including null and blank — is 'unknown', and 'unknown' is deliberately
 * unhelpful in both directions: never a ready candidate, never a satisfied
 * prerequisite. A team with custom status names therefore gets fewer answers,
 * never wrong ones.
 */
export type TicketStatusClass = 'done' | 'started' | 'open' | 'unknown';

/** Normalized (see `normalizeTicketStatus`) status literals per class. */
export const DONE_TICKET_STATUSES: readonly string[] = [
  'done', 'closed', 'complete', 'completed', 'resolved', 'shipped', 'released',
  'merged', 'deployed', 'cancelled', 'canceled', 'duplicate', 'rejected',
  'wont do', 'wont fix', 'will not do', 'abandoned',
];
export const STARTED_TICKET_STATUSES: readonly string[] = [
  'in progress', 'in development', 'in dev', 'in review', 'in qa', 'in testing',
  'started', 'doing', 'review', 'code review', 'qa', 'testing', 'blocked',
  'on hold', 'paused', 'waiting',
];
export const OPEN_TICKET_STATUSES: readonly string[] = [
  'open', 'reopened', 'to do', 'todo', 'backlog', 'new', 'ready',
  'ready for dev', 'ready for development', 'selected for development',
  'triage', 'unstarted', 'planned', 'not started',
];

/** lowercase, apostrophes removed, `[\s_-]+` collapsed to one space, trimmed. */
export function normalizeTicketStatus(status: string | null): string;

export function classifyTicketStatus(status: string | null): TicketStatusClass;

/** Maximum ready tickets carried in `groups`; `totalReady` still reports the true count. */
export const READY_TICKETS_LIMIT = 200;

export interface ReadyTicketFeature {
  id: string;
  name: string;
}

export interface ReadyTicket {
  id: string;
  externalId: string;
  system: string;
  title: string | null;
  status: string | null;
  url: string | null;
  repositoryId: string;
  refName: string;
  /** Count of this ticket's prerequisites — all of which are done, or it would not be here. */
  satisfiedPrerequisites: number;
  /** Always identical to the enclosing group's `feature`. */
  feature: ReadyTicketFeature | null;
}

export interface ReadyTicketGroup {
  /** null is the ungrouped bucket; it is always the last group. */
  feature: ReadyTicketFeature | null;
  tickets: ReadyTicket[];
}

export interface ReadyTicketsResult {
  authorization: 'server-filtered';
  /** Ready tickets found before READY_TICKETS_LIMIT was applied. */
  totalReady: number;
  /** True when `totalReady` exceeds the number of tickets carried in `groups`. */
  truncated: boolean;
  groups: ReadyTicketGroup[];
}

export async function getReadyTickets(
  ctx: AuthContext,
  graph: TicketReadinessGraphQueryService = graphQueryService,
): Promise<ReadyTicketsResult>;
```

`getReadyTickets` behaviour, in order:

1. `const tickets = await graph.getTicketReadiness(ctx);`
2. **Candidate filter:** keep a ticket when `classifyTicketStatus(ticket.status) === 'open'` **and**
   every entry of `ticket.prerequisites` satisfies
   `prerequisite.visible === true && classifyTicketStatus(prerequisite.status) === 'done'`.
3. Map each survivor to a `ReadyTicket` with
   `satisfiedPrerequisites = ticket.prerequisites.length` and `feature = ticket.feature`.
4. **Sort** the flat list by, in order: featured-before-ungrouped
   (`ticket.feature === null ? 1 : 0`), then `feature.name.localeCompare` then
   `feature.id.localeCompare` (only when both have a feature), then
   `externalId.localeCompare`, then `id.localeCompare`.
5. `totalReady = list.length`; take the first `READY_TICKETS_LIMIT`; `truncated = totalReady > taken.length`.
6. Fold the (already contiguous) taken list into `groups`, one group per distinct feature id plus at
   most one trailing `feature: null` group. A group is emitted only when it has ≥ 1 ticket.
7. Return `{ authorization: 'server-filtered', totalReady, truncated, groups }`.

No `org_id`, `repoId`, or ref is ever accepted as a parameter — `ctx` is the only identity input, and
`ctx.orgId` is server-resolved from the verified credential.

### 5. MCP handler — `services/core/src/mcp/handlers/getReadyTickets.ts` (new, exact content)

```ts
import type { AuthContext } from '../../auth/context';
import type { McpToolServices } from '../toolServices';

export function getReadyTicketsHandler(
  ctx: AuthContext,
  services: McpToolServices,
): Promise<unknown> {
  return services.getReadyTickets(ctx);
}
```

This satisfies every rule `handlerContract.test.ts` enforces: under 20 lines, no `drizzle-orm` /
`neo4j-driver` / `node:fs` / `node:child_process` / `/db/` / `/graph-query/` reference, and a
`services.getReadyTickets` call.

### 6. `services/core/src/mcp/toolServices.ts` (additions)

```ts
import { getReadyTickets } from '../services/ticketReadinessService';
// …
export interface McpToolServices {
  // …existing members unchanged…
  getReadyTickets(ctx: AuthContext): Promise<unknown>;
}

export const mcpToolServices: McpToolServices = {
  // …existing members unchanged…
  getReadyTickets,
};
```

### 7. `services/core/src/mcp/gateway.ts` (addition, registered last inside `createServer`)

```ts
server.registerTool(
  'get_ready_tickets',
  {
    description:
      'List the authorized tickets that are unblocked and ready to start — ' +
      'every prerequisite ticket is already done — grouped by the feature each ' +
      'belongs to, with an ungrouped bucket for tickets that have none. Takes ' +
      'no arguments; scope comes from the credential, never from the caller.',
    annotations: READ_ONLY,
  },
  () =>
    execute('get_ready_tickets', () =>
      getReadyTicketsHandler(credential.context, deps.services),
    ),
);
```

`inputSchema` is **omitted deliberately**, not set to `{}`. With no `inputSchema` the SDK
(`@modelcontextprotocol/sdk` 1.29.x, `server/mcp.js`) advertises its `EMPTY_OBJECT_JSON_SCHEMA`
(`{ type: 'object', properties: {} }`), skips argument validation entirely, and invokes the callback
as `cb(extra)` — which the zero-parameter arrow above satisfies. This is the documented zero-argument
form and it also avoids the zod dual-package `as any` widening the file's existing block comment
describes.

### 8. Interop harness (required — `test/mcp-interop/` is typechecked and run by the default suite)

- `contract.ts`: add `'get_ready_tickets'` to `InteropToolCase['name']`'s union and
  `{ name: 'get_ready_tickets', arguments: {} }` to `V1_TOOL_CASES`.
- `fixtureGateway.ts`: add a `getReadyTickets(ctx)` implementation. **`runInterop.ts`'s
  `assertScopeBoundary` requires that every tool's full-scope result contains the substring
  `private` (case-insensitively) and that its limited-scope result does not** — so the full-scope
  fixture must return a ready ticket whose title mentions "private" (e.g. a group
  `Private billing` holding `SAY-1 / Harden private billing authorization`), and the limited-scope
  fixture must return `{ authorization: 'server-filtered', totalReady: 0, truncated: false, groups: [] }`
  or an equivalent result containing no such substring.

## Approach

Build in this order; each step compiles and is independently testable.

1. **Types first** — add the four declarations to `graph-query/types.ts`. Nothing else references
   them yet.
2. **Cypher + mapper + method** in `graph-query/index.ts`. Add `GET_READY_TICKETS_ROW_LIMIT` and
   `GET_READY_TICKETS_CYPHER`, then `mapTicketReadiness`, then `getTicketReadiness` on
   `RbacGraphQueryService`, then extend the class's `implements` list and the exported
   `graphQueryService` const's type union. Reuse `scopeParameters`, `valueAsString`,
   `valueAsOptionalString`, `safeWebUrl`, `canReadResource` — do not introduce parallel helpers.
3. **Service layer** — `ticketReadinessService.ts`. Status vocabulary and `classifyTicketStatus`
   first (pure, trivially testable), then `getReadyTickets`. The graph parameter defaults to
   `graphQueryService`, matching `nodeOverlayService`/`retrievalContextService`, so tests inject a
   narrow double.
4. **MCP wiring** — handler file, `toolServices.ts` entry, `gateway.ts` registration, in that order.
5. **Test-facing fallout** — `handlerContract.test.ts` list, `gateway.test.ts` inventory/fixture/
   counts (plus the declared `checkLiveness` fix), `test/mcp-interop/contract.ts`,
   `test/mcp-interop/fixtureGateway.ts`.
6. **Docs** — `MCP_TOOL_CONTRACT.md` (new `### ` section, zero-argument input note, corrected
   counts), `docs/mcp-gateway.md` (tool list + section), `packages/graph-schema/schema.md` (three
   endpoint-pair rows).
7. **Verify** in CLAUDE.md's order: `npx tsc --noEmit` (and `npm run typecheck -w @sayre/core`, which
   additionally typechecks `test/mcp-interop`), `npm run test -w @sayre/core`, `npm run lint`.

## Acceptance criteria

- **AC-1** — Given a fixture graph of tickets in mixed states with a `REQUIRES` chain, the service
  returns exactly the unblocked open set: a ticket whose prerequisite is in any non-done state
  (open, started, or unknown) is excluded, and a ticket whose prerequisites are all done is included.
  Verified in `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-2** — A `DEPENDS_ON` prerequisite is treated identically to a `REQUIRES` prerequisite, both in
  the graph query (`type(edge) IN ['REQUIRES','DEPENDS_ON']`) and in the mapper's admission check.
  Verified in `services/core/src/graph-query/ticketReadiness.test.ts`.
- **AC-3** — Results are grouped by owning `Feature` via `PART_OF`; a ticket with no `PART_OF`
  Feature lands in a single trailing group whose `feature` is `null`, and that ungrouped group is
  always last. Verified in `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-4** — Org isolation: the Cypher binds `$org_id` from `ctx.orgId` alone; neither the MCP tool's
  input nor any exported function signature accepts an org id; and the mapper drops any record whose
  `ticket_org_id`, `prerequisite_org_id`, `prerequisite_edge_org_id`, `feature_org_id`, or
  `membership_org_id` differs from `ctx.orgId`, so tenant A's call can never return tenant B's
  tickets. Verified in `services/core/src/graph-query/ticketReadiness.test.ts`.
- **AC-5** — Node-level RBAC is enforced server-side in the Graph Query Service: a caller with no
  repository-root-level allow rule (`path_prefix IS NULL`) for a ticket's `(repo_id, ref_name)`
  receives none of that repository's tickets, a matching deny removes them, and a caller with zero
  allow rules gets `[]` without a graph round trip. Verified in
  `services/core/src/graph-query/ticketReadiness.test.ts`.
- **AC-6** — A prerequisite that exists but is outside the caller's read scope is returned with
  `visible: false` and `status: null`, is never counted as satisfied, and therefore blocks its
  dependent — and neither its id nor any of its fields appears in the service's result. Verified in
  `services/core/src/graph-query/ticketReadiness.test.ts` and
  `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-7** — The MCP gateway lists `get_ready_tickets` among its tools with
  `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`, accepts a
  call with no arguments from an authorized credential, and returns the service function's result
  verbatim inside the `{"data": …}` envelope, with one metered `ok` measurement. Verified in
  `services/core/src/mcp/gateway.test.ts`.
- **AC-8** — `services/core/src/mcp/handlers/getReadyTickets.ts` satisfies the thin-handler contract:
  it is in `handlerContract.test.ts`'s expected file list, is under 20 lines, contains no
  data-access import, and delegates via `services.getReadyTickets`. Verified in
  `services/core/src/mcp/handlerContract.test.ts`.
- **AC-9** — Ordering is deterministic and stable across runs: two invocations over the same input
  produce deeply equal results; groups are ordered by `feature.name` then `feature.id` with the
  ungrouped group last; tickets within a group are ordered by `externalId` then node `id`. Verified
  in `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-10** — Each returned entry carries the narration payload the ticket asked for — `id`,
  `externalId`, `title`, `status`, `satisfiedPrerequisites`, and `feature` (`id`/`name`) — with
  `satisfiedPrerequisites` equal to the number of distinct done prerequisites (0 when the ticket has
  none). Verified in `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-11** — `classifyTicketStatus` maps `DONE_TICKET_STATUSES` / `STARTED_TICKET_STATUSES` /
  `OPEN_TICKET_STATUSES` case-, whitespace-, underscore-, hyphen-, and apostrophe-insensitively, and
  returns `'unknown'` for `null`, blank, and any unrecognized status; `'unknown'` is never treated as
  `'open'` (never a candidate) and never as `'done'` (never satisfies a prerequisite). Verified in
  `services/core/src/services/ticketReadinessService.test.ts`.
- **AC-12** — The published contract and the interop harness stay in sync with the gateway:
  `V1_TOOL_CASES` contains `{ name: 'get_ready_tickets', arguments: {} }`, `MCP_TOOL_CONTRACT.md`
  contains a `### \`get_ready_tickets\`` section, and `test/mcp-interop/interop.test.ts` passes —
  which requires the fixture's full-scope result to contain `private` and its limited-scope result
  not to. Verified in `services/core/test/mcp-interop/interop.test.ts`.
- **AC-13** — `packages/graph-schema/schema.md` records the endpoint pairs this read depends on —
  `Ticket->Ticket` for both `REQUIRES` and `DEPENDS_ON`, and `Ticket->Feature` for `PART_OF` — with
  no new node label and no new relationship type added to either closed set. Verified in
  `services/core/src/graph-query/ticketReadiness.test.ts` (a documentation assertion, in the same
  style as `interop.test.ts`'s existing `MCP_TOOL_CONTRACT.md` check).

## Edge cases

- **EC-1** — No `Ticket` nodes at all: returns
  `{ authorization: 'server-filtered', totalReady: 0, truncated: false, groups: [] }`. Never `null`,
  never a throw.
- **EC-2** — The caller's read scope has zero allow rules: `getTicketReadiness` returns `[]` without
  calling the graph executor at all (assert the executor's `run` was never invoked).
- **EC-3** — A ticket whose `status` is `null`, blank, or an unrecognized workflow name classifies as
  `'unknown'`: it is not offered as ready, and as a prerequisite it blocks its dependent.
- **EC-4** — A ticket already in a done state is never returned as ready, even with zero
  prerequisites.
- **EC-5** — A ticket in a started state (`in progress`, `in review`, `blocked`, `on hold`, …) is not
  returned — "ready to start" excludes work already begun or explicitly held.
- **EC-6** — A self-referential prerequisite (`ticket -[:REQUIRES]-> same ticket`) is dropped by the
  mapper: it is neither counted in `satisfiedPrerequisites` nor allowed to block, since a self-loop
  would otherwise hide the ticket permanently.
- **EC-7** — A prerequisite cycle (A requires B, B requires A, both open) yields neither ticket as
  ready, with no unbounded traversal — the query is single-hop by construction.
- **EC-8** — A ticket that is `PART_OF` more than one `Feature` appears exactly once, under the
  feature with the lowest `(name, id)` ordering.
- **EC-9** — A `Feature` in a different repository, ref, or org than the ticket is ignored; the
  ticket falls into the ungrouped bucket rather than being grouped under it.
- **EC-10** — A prerequisite relationship carrying a foreign `org_id` on the *edge* is ignored
  entirely: for this tenant the relationship does not exist, so it neither counts nor blocks.
- **EC-11** — The same ticket uid appearing on rows with conflicting identity fields (a corrupt or
  concurrently-rewritten projection) causes that ticket to be dropped from the result entirely and
  never re-added, mirroring `distinctFeatureClusters`' invalid-cluster handling.
- **EC-12** — Row-cap truncation: when the executor returns exactly `GET_READY_TICKETS_ROW_LIMIT`
  records, the final record's ticket is dropped as possibly-incomplete, so a partially-read
  prerequisite list can never make a blocked ticket look ready.
- **EC-13** — More than `READY_TICKETS_LIMIT` ready tickets: `groups` carry the first 200 in the
  deterministic order, `totalReady` reports the true pre-cap count, and `truncated` is `true`.
- **EC-14** — A `Ticket.url` that is not `http:`/`https:` (e.g. a `javascript:` value) is emitted as
  `null` via the existing `safeWebUrl` helper.
- **EC-15** — MCP failure paths are unchanged and reveal nothing: a rate-limited call returns
  `isError: true` with the fixed text `MCP rate limit exceeded.`, and a service throw returns
  `isError: true` with `MCP tool execution failed.` and no graph, database, or validation detail.
- **EC-16** — Blank-string `title`, `status`, or `url` values normalize to `null` (via
  `valueAsOptionalString`) rather than surfacing as empty strings.
- **EC-17** — A `Ticket` missing `repo_id` or `ref_name` (a legacy row written before those were set)
  is dropped: it cannot be authorized, so it is never returned and, as a prerequisite, is never
  visible and therefore blocks.
- **EC-18** — No `Ticket -[:PART_OF]-> Feature` edge exists anywhere (today's real-data state, since
  the ticket sync writer emits `REFERENCES`): every ready ticket lands in the single ungrouped
  bucket and the result is still well-formed.
- **EC-19** — A `Ticket -[:REFERENCES]-> Feature` edge must **not** group the ticket; only `PART_OF`
  does. (Asserted so a future change to the writer cannot silently alter grouping.)
- **EC-20** — The tool is called with unexpected arguments (e.g. `{ "org_id": "<other tenant>" }`):
  because no `inputSchema` is registered the SDK ignores them, the handler receives only
  `credential.context`, and the result is byte-identical to a no-argument call — a client-supplied
  org id can never influence the query.

## Resolved decisions (no open questions remain)

The seven items this spec originally raised as Open questions were put to the ticket owner and
ratified on 2026-08-10. Every one resolved to the default this spec already implements, so **no
interface, Cypher shape, acceptance criterion, or edge case changed as a result** — this section is
the record of the decision, not a change to the design above. Nothing remains open; `red` and `dev`
may proceed against this spec as written.

1. **`PART_OF` only, exactly as the ticket names it; `REFERENCES` must not group.** The read does not
   accept `Ticket -[:REFERENCES]-> Feature` as a grouping edge, and EC-19 stands as specified.
   *Rationale (ticket owner):* the ticket names `PART_OF` explicitly and forbids new edge types;
   reusing `REFERENCES` would silently conflate "mentions a feature tag" with "belongs to a feature."
2. **No writer exists for `Ticket -[:REQUIRES|DEPENDS_ON]-> Ticket`, a follow-up ticket owns it, and
   the direction is *dependent → prerequisite*.** CH-02 stays read-only and consumes the edges if
   present. *Rationale:* the "every open ticket is vacuously ready today" consequence recorded in
   Ticket Check → What I had to guess #4 is the honest, accepted state, and that paragraph stands.
3. **Zero-argument tool, org-wide, capped at 200, as specified.** No `repo_id`/`ref_name` filter in
   this ticket. *Rationale:* adding an optional filter later is additive and non-breaking; removing
   a required one is not.
4. **Status vocabulary as specified, fail-closed on unknown.** An unrecognized status is never ready
   and never satisfies a prerequisite. *Rationale:* a team with custom workflow names gets fewer
   answers rather than wrong ones.
5. **Pathless-node RBAC requires a repository-root-level grant; a path-scoped key sees no tickets.**
   *Rationale:* matching the existing `EnvStep`/onboarding precedent
   (`GET_ONBOARDING_STEPS_CYPHER`) is exactly right, and it fails closed by construction.
6. **The `packages/graph-schema/schema.md` endpoint-pair documentation update is sufficient.** No
   graph migration, no new node label, no new relationship type. *Rationale:* only new endpoint pairs
   for three existing relationship types, exactly as `REFERENCES` and `CONTAINS` already carry
   multiple pairs.
7. **Both bounded incidental fixes are approved as scoped in Affected files** — the missing
   `checkLiveness` entry in `gateway.test.ts`'s `fixtureServices()`, and `MCP_TOOL_CONTRACT.md`'s
   stale eight/16/32 counts corrected to ten/20/40. *Rationale:* both sit in the exact lines this
   change already edits; they stay bounded, and dev must declare each explicitly in `changes.md`.

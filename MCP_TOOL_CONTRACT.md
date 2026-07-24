# Sayre MCP read-only v1 tool contract

This document is the customer-facing contract for building an MCP client against
Sayre's Agent Context Layer. It describes the complete v1 surface. A client does
not need a Sayre source checkout, a specific agent vendor, or a hosted model.

## Connection

| Item | Contract |
| --- | --- |
| Transport | MCP Streamable HTTP |
| Endpoint | `POST https://<sayre-host>/mcp` |
| Authentication | `Authorization: Bearer <scoped-key>` on every request |
| Session model | Stateless; do not depend on a session ID |
| Tool results | One MCP text content item containing a JSON `{"data": ...}` envelope |
| Mutations | None in v1 |

Use normal MCP initialization and tool discovery before calling a tool. Every
advertised v1 tool has these annotations:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

`GET /mcp` and `DELETE /mcp` are not supported and return HTTP 405. Native
clients should omit `Origin`. Browser clients must send an origin allowlisted by
the Sayre operator.

## Credentials and authorization

An organization owner or admin creates a key at `/settings/mcp`, choosing one or
more repository, branch, and path-prefix read grants. The cleartext key is shown
once. Store it in the client's secret store and never commit or log it.

The requested grants are only a ceiling. On every request Sayre intersects that
ceiling with the issuing admin's current effective permissions, then performs
tenant and node filtering in the Graph Query Service. Demotion, permission
narrowing, key expiry, key revocation, or removal of the issuer therefore takes
effect on the next request.

Clients never send an organization ID, role, repository scope, or user identity.
Those values come only from the bearer credential. A hidden node and an unknown
node deliberately have the same result, `{"data":null}`. Lists omit hidden
members. This prevents clients from using the tools as an existence oracle.

## Input rules

All input objects are closed by the published tool schema; send only the named
properties.

- `node_id`: required string, 1–512 characters, no leading or trailing
  whitespace, and no NUL character.
- `query` and `intent`: required string, 1–2,000 characters, at least one
  non-whitespace character, and no NUL character.

Search processing uses at most 12 unique normalized terms. `find_relevant_nodes`
returns at most 8 anchors. `traverse_from` is bounded to 2 graph hops and at most
64 authorized Folder/File nodes.

## Shared result types

The following TypeScript-like declarations are documentation notation, not a
required client language:

```ts
type CanvasNode = {
  id: string;
  label: "Folder" | "File";
  name: string;
  path: string;
  repositoryId: string;
  refName: string;
  revisionSha: string;
};

type RetrievalNode = CanvasNode & {
  distance: number;
};

type RecentChange = {
  commitId: string;
  sha: string;
  message: string | null;
  timestamp: string; // ISO 8601
  authorName: string | null;
  authorLogin: string | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
};

type Feature = {
  id: string;
  name: string;
  description: string | null;
  team: string | null;
};
```

## Tools

### `find_relevant_nodes`

Find authorized Folder/File anchors for a natural-language task.

```json
{
  "query": "billing webhook authorization"
}
```

`data` is `RetrievalNode[]`, ordered by the server's relevance rules. An empty
array means no authorized match.

### `traverse_from`

Fetch a bounded, authorized graph neighborhood around one Folder/File anchor.

```json
{
  "node_id": "file:src/billing/webhook.ts",
  "intent": "dependencies needed to change signature verification"
}
```

`data` is the following object or `null`:

```ts
{
  anchor: RetrievalNode;
  nodes: RetrievalNode[];
}
```

The anchor is also authorization-filtered. A missing or hidden anchor returns
`null`; the response never contains a hidden neighbor.

### `get_node_context`

Return the same server-filtered metadata snapshot used by Sayre's node overlay.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  authorization: "server-filtered";
  node: CanvasNode;
  dependencies: Array<{
    id: string;
    label: "Folder" | "File";
    name: string;
    path: string;
    relationship: "IMPORTS";
    direction: "outbound" | "inbound";
  }>;
  recentChanges: RecentChange[];
  specificFeatures: Feature[];
  agentSkillMd: {
    version: number;
    content: string;
    editorUserId: string | null;
    editorLabel: string;
    createdAt: string; // ISO 8601
  } | null;
  description: string | null;
  specificTickets: Array<{
    id: string;
    externalId: string;
    system: string;
    title: string | null;
    status: string | null;
    url: string | null;
  }>;
}
```

### `get_agent_skill_md`

Return the latest immutable Agent/Skill Markdown version visible for a node.
The document, when present, contains `Allowed Tools`, `Required Context`, and
`Guardrails` sections in that order.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  nodeId: string;
  repositoryId: string;
  refName: string;
  document: {
    version: number;
    content: string;
    editorUserId: string | null;
    editorLabel: string;
    createdAt: string; // ISO 8601
  } | null;
}
```

The outer `null` means the node is missing or hidden. A `document` value of
`null` means the node is visible but no Agent/Skill document has been authored.

### `get_style_rules`

Resolve inherited coding and comment rules for a node.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  nodeId: string;
  codingStyle: {
    value: string | null;
    sourceNodeId: string | null;
  };
  commentStyle: {
    value: string | null;
    sourceNodeId: string | null;
  };
}
```

Each `sourceNodeId` identifies the visible node from which an effective value
was inherited. Both fields are `null` when no applicable rule exists.

### `get_covering_tests`

Return authorized tests connected through `COVERS`, including measured status
and freshness.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  node: CanvasNode;
  tests: Array<{
    id: string;
    name: string;
    path: string;
    coverageStatus: "pass" | "fail" | "unknown";
    edgeStatus: "inferred" | "measured";
    lastRun: string | null; // ISO 8601 when present
    freshness: "inferred" | "fresh" | "stale";
  }>;
}
```

Both the requested node and every returned Test node are independently
authorization-filtered.

### `get_feature_cluster`

Return product feature metadata attached to an authorized node.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  node: CanvasNode;
  featureClusters: Feature[];
}
```

### `get_recent_changes`

Return recent authorized commit, editor, and pull-request metadata for a node.

```json
{
  "node_id": "file:src/billing/webhook.ts"
}
```

`data` is the following object or `null`:

```ts
{
  node: CanvasNode;
  recentChanges: RecentChange[];
}
```

## Errors, rate limits, and retries

Authentication failures return HTTP 401 with a JSON-RPC error whose public
message is `Unauthorized.`. Disallowed browser origins return HTTP 403.
Unsupported transport methods return HTTP 405.

Tool-level failures use an MCP result with `isError: true` and one of two fixed
text messages:

- `MCP rate limit exceeded.`
- `MCP tool execution failed.`

The server intentionally does not return graph, database, validation, or secret
details. Rate limiting is per organization and public key prefix, using the
organization's persisted calls-per-minute setting. Back off with jitter after a
rate-limit result. Retrying a read is safe, but repeated malformed input should
be corrected rather than retried.

Every invocation, including errors, records `mcp_tool_call_count` and
`mcp_context_tokens_served` tagged by organization, public key prefix, tool, and
outcome. Context tokens are a transport estimate:
`ceil(UTF-8 response bytes / 4)`.

## Minimal SDK client

This example uses the official open-source TypeScript MCP SDK. Supply the token
through a secret manager or an untracked runtime variable.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = /* retrieve from your secret store */;
const client = new Client({ name: "customer-agent", version: "1.0.0" });

await client.connect(
  new StreamableHTTPClientTransport(
    new URL("https://sayre.example/mcp"),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  ),
);

const inventory = await client.listTools();
const result = await client.callTool({
  name: "get_covering_tests",
  arguments: { node_id: "file:src/billing/webhook.ts" },
});

if (result.isError) throw new Error("Sayre MCP tool failed");
const item = Array.isArray(result.content) ? result.content[0] : null;
if (!item || item.type !== "text") throw new Error("Unexpected MCP result");
const { data } = JSON.parse(item.text);

await client.close();
```

## Claude Code configuration

A project-scoped `.mcp.json` has this shape:

```json
{
  "mcpServers": {
    "sayre": {
      "type": "http",
      "url": "https://sayre.example/mcp",
      "headers": {
        "Authorization": "Bearer ${SAYRE_MCP_TOKEN}"
      }
    }
  }
}
```

Keep `.mcp.json` untracked if the chosen client version does not resolve secret
placeholders. Do not replace the placeholder with a key in a committed file.
The same endpoint and scoped key work for Claude Code, other MCP clients, and
agents driven by a self-hosted model.

## Local-model interoperability verification

The reference harness is under `services/core/test/mcp-interop/`. It uses the
official open-source MCP SDK and an OpenAI-compatible chat-completion endpoint.
The reference model endpoint is restricted to unauthenticated loopback HTTP, so
the harness cannot silently send fixture context to a hosted model.

Run the deterministic CI version:

```sh
npm run test:mcp-interop -w @sayre/core
```

Run the real-model version with Ollama or an equivalent local server:

```sh
npm run mcp-interop:local -w @sayre/core -- \
  --model hf.co/unsloth/gemma-4-12b-it-GGUF:Q8_0 \
  --model-url http://127.0.0.1:11434/v1
```

For each of the eight tools, the harness:

1. gives exactly the discovered MCP schema to the local model and requires one
   exact tool selection;
2. executes that call through an official MCP client;
3. executes the equivalent Claude Code protocol call through a second client
   against the same fixture gateway and key;
4. compares canonical result data byte-for-byte;
5. repeats with full and limited scopes; and
6. asserts that limited-scope results contain none of the hidden fixture
   context.

That is 16 local-model selections and 32 measured MCP calls. Client identity
does not create a second authorization or metering path. W4-07 changes only the
client harness, tests, scripts, and this contract; it requires no MCP Gateway
code change.

## Compatibility and versioning

Clients should discover tools and validate schemas at startup instead of
assuming that an undocumented field exists. The contract above is read-only
v1. Additive optional response fields may appear without changing tool names;
removing a field, changing its meaning, changing an input schema, or adding
write behavior requires a new contract version. Write/propose tools are outside
the v1 surface.

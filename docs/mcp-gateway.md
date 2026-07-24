# Read-only MCP gateway

Wave 4 exposes Sayre's authorized graph context at `POST /mcp` using the MCP
Streamable HTTP transport. It is deliberately read-only: the server advertises
only read-only tools, creates no mutation resources or prompts, and rejects
`GET`/`DELETE` transport operations in stateless mode.

The standalone customer contract, including every input and result schema plus
reference client code, is published in [`MCP_TOOL_CONTRACT.md`](../MCP_TOOL_CONTRACT.md).

## Administration

Organization owners and admins manage credentials at `/settings/mcp`.

- A credential receives one or more repository/branch/path read grants.
- The requested grants must fit inside the issuing administrator's current
  effective read scope. The stored grants are the issuance ceiling.
- Every graph query re-intersects that ceiling with the issuer's current
  effective scope. Demotion, permission narrowing, deletion, expiry, or
  revocation therefore fails closed without a key cache.
- The server returns a 256-bit token once. Postgres stores only its public
  prefix and a pepper-versioned HMAC-SHA-256 digest.
- Revocation is a soft, audited update and is checked on the next HTTP call.
- The per-key calls-per-minute policy is persisted per organization.

The gateway requires `MCP_TOKEN_PEPPER` through the shared secret loader.
`MCP_TOKEN_PEPPER_VERSION` selects the active digest version. Set
`MCP_ALLOWED_ORIGINS` to a JSON array of exact browser origins; native clients
that omit `Origin` are supported.

## Client configuration

Use Streamable HTTP with the issued token as a bearer credential:

```json
{
  "mcpServers": {
    "sayre": {
      "type": "streamable-http",
      "url": "https://sayre.example/mcp",
      "headers": {
        "Authorization": "Bearer ${SAYRE_MCP_TOKEN}"
      }
    }
  }
}
```

The v1 tool set is:

- `find_relevant_nodes(query)`
- `traverse_from(node_id, intent)`
- `get_node_context(node_id)`
- `get_agent_skill_md(node_id)`
- `get_style_rules(node_id)`
- `get_covering_tests(node_id)`
- `get_feature_cluster(node_id)`
- `get_recent_changes(node_id)`

Every successful tool response is one text content block containing JSON shaped
as `{"data": ...}`. A hidden or absent node returns `{"data":null}`; it is not
distinguishable from an unknown node. Errors use fixed messages and do not
reflect graph, database, or secret details.

Every invocation records `mcp_tool_call_count` and
`mcp_context_tokens_served`, tagged with public key prefix, organization, tool,
and outcome. The context-token count is a documented transport estimate
(`ceil(UTF-8 response bytes / 4)`), since the gateway is model-neutral.

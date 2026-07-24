# Agent/Skill MD contract

Agent/Skill MD is node-scoped operating guidance for a Folder or File. Humans
author it in the Technical Tree overlay. Sayre's Retrieval Service and the
read-only MCP `get_agent_skill_md` tool consume the same service-layer read, so
they observe the same saved version on their next request.

## Required structure

A document contains exactly these three level-two headings, in this order.
Each section must have non-blank Markdown content:

```md
## Allowed Tools

- Tools or operations an agent may use for this node.

## Required Context

- Rules, files, tests, or architecture an agent must read first.

## Guardrails

- Security, tenancy, data, and change boundaries the agent must preserve.
```

Free-form Markdown is allowed inside each section, including level-three and
deeper headings. Additional level-two headings, missing/duplicate headings,
blank sections, NUL characters, and documents over 32,768 characters are
rejected.

## Authorization and visibility

- A live Graph Query Service lookup authorizes the Folder/File before any
  document read, history read, or write.
- Hidden and absent nodes both yield no document.
- Human organization owners and admins may append a version for a node they can
  read. Members and agent keys cannot write.
- The server injects organization identity from the verified credential.
  Clients cannot supply or override it.

## Versioning

Every save appends an immutable PostgreSQL row under forced organization RLS.
The row captures repository, ref, graph node, path, graph revision, editor, and
timestamp. The raw edit history is never updated or deleted by the runtime
role.

Saves include `expectedVersion` (`0` for the first version). A stale value
returns a conflict rather than overwriting another editor. Restoring older
guidance means saving that prior content as a new version, preserving the audit
trail.

There is no cross-request content cache. A successful save is therefore visible
to the shared service read, Retrieval, the overlay, and MCP on the next normal
request cycle.

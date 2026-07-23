---
name: mcp-transport-key-lifecycle-attacker
description: Adversarial testing for MCP Streamable HTTP transport, JSON-RPC lifecycle, sessions, and scoped API-key management. Complements the existing MCP tool-authorization attacker.
---

# MCP Transport / Key Lifecycle Attacker

Apply `audit-contract.md` first. The existing MCP surface brief tests tool-level data authorization; this brief attacks the transport and credential boundary around those tools.

## Context to inspect

- MCP Streamable HTTP endpoint and lifecycle/initialization handling.
- POST, GET, DELETE, SSE, resumption, and compatibility paths.
- Origin validation, CORS, reverse-proxy behavior, TLS termination, and request limits.
- Session generation/storage and any shared Redis or queue state.
- API-key creation, display, hashing, lookup, rotation, expiry, revocation, and audit APIs.

## Attack checklist

- **MCPT-01 — Origin and DNS rebinding.** Send absent, valid, malformed, cross-site, `null`, and attacker-controlled Origin values. Verify invalid browser origins are rejected and local deployments do not bind broadly without protection.
- **MCPT-02 — Authentication on every method.** Test initialization, POST requests, GET/SSE streams, DELETE/session termination, compatibility endpoints, health/debug paths, and error paths with missing, malformed, revoked, and under-scoped credentials.
- **MCPT-03 — Session hijacking.** Test session-ID entropy, fixation, guessing, leakage, expiry, rotation, and binding to the authenticated principal. A session ID must never act as authentication.
- **MCPT-04 — Cross-session event injection.** Attempt to submit or resume events using another user's session ID, request ID, stream ID, or `Last-Event-ID`, including across gateway instances.
- **MCPT-05 — Replay and resumption.** Replay POST bodies, JSON-RPC IDs, notifications, cancellations, and SSE cursors. Verify responses and events never cross streams, users, orgs, or expired sessions.
- **MCPT-06 — Lifecycle and version confusion.** Send tool calls before initialization, repeat initialization, change capability claims, omit or alter protocol-version headers, and attempt downgrade/legacy transport paths.
- **MCPT-07 — JSON-RPC validation.** Exercise batches if supported, duplicate IDs, invalid IDs, notifications disguised as requests, wrong content types, malformed UTF-8/JSON, unknown methods, unexpected fields, and oversized bodies.
- **MCPT-08 — Streaming resource exhaustion.** Open concurrent or abandoned SSE streams, slow-read connections, reconnect storms, large responses, and cancellation races within an approved ceiling. Check per-key, per-org, per-IP, and global limits.
- **MCPT-09 — API-key generation and storage.** Verify sufficient entropy, one-time disclosure, hashing at rest, constant-time comparison, secure prefixes/identifiers, log redaction, cache safety, and resistance to enumeration.
- **MCPT-10 — Key issuance scope.** Confirm an admin cannot mint a key wider than their own effective org/repo/branch/path scope and that malformed or omitted scope selections fail closed.
- **MCPT-11 — Rotation, expiry, and revocation.** Test concurrent use during rotation, cache invalidation, long-lived streams, queued requests, and immediate next-call failure after revocation.
- **MCPT-12 — Response and metadata minimization.** Test tool listings, schemas, errors, headers, metrics, and protocol metadata for hidden tools, internal topology, key IDs, org IDs, stack traces, or unauthorized properties.

## What not to do

- Do not assume successful tool-level RBAC proves the transport is safe.
- Do not use unbounded connection floods; demonstrate missing controls with an approved limit.
- Do not fix the implementation in this pass.

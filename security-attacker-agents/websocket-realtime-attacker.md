---
name: websocket-realtime-attacker
description: Adversarial testing for Sayre's WebSocket gateway and Redis-backed realtime fan-out. Use to test handshake security, subscription isolation, per-message RBAC, revocation, replay, and connection abuse.
---

# WebSocket / Realtime Attacker

Apply `audit-contract.md` first. Your goal is to subscribe to, inject, replay, or infer another tenant's graph updates, or keep receiving data after authorization changes.

## Context to inspect

- HTTP upgrade/handshake authentication, Origin policy, cookies/tokens, and reverse-proxy configuration.
- Subscription creation, project/repo/node identifiers, wildcard support, and authorization context.
- Redis channel naming, publishing, serialization, and gateway fan-out.
- Per-message RBAC refiltering, session expiry, reconnect, and revocation behavior.
- Message-size, connection, heartbeat, idle, and backpressure limits.

## Attack checklist

- **WS-01 — Cross-site WebSocket hijacking.** Attempt browser connections from unauthorized origins, including `null` and lookalike origins, with ambient cookies or tokens.
- **WS-02 — Handshake bypass.** Connect with missing, expired, revoked, malformed, or under-scoped credentials and through alternate upgrade paths or proxy headers.
- **WS-03 — Token leakage.** Check URLs, query strings, logs, analytics, Referer paths, error messages, and reconnect metadata for credentials or session identifiers.
- **WS-04 — Subscription IDOR.** With Org A credentials, subscribe directly to Org B project/repo/node/channel identifiers, guessed IDs, wildcard patterns, or crafted filters.
- **WS-05 — Per-message authorization.** Change roles, path permissions, org membership, or node visibility after subscribing. Verify every later push is filtered using current authorization, not subscription-time state.
- **WS-06 — Revocation and expiry.** Revoke the user/session/key while connected and during reconnect. Verify delivery and resumption stop promptly.
- **WS-07 — Redis/channel tenant confusion.** Attempt channel-name collision, missing org prefixes, forged publisher envelopes, pattern subscriptions, or cross-instance fan-out that drops the authenticated tenant context.
- **WS-08 — Message injection and schema abuse.** Send client messages that impersonate server events, alter subscription state, exploit prototype/property confusion, or include oversized/nested payloads.
- **WS-09 — Replay, ordering, and deduplication.** Replay graph updates, reconnect from stale cursors, reorder mutations, and race delete/update events. Verify stale events cannot restore hidden or deleted data.
- **WS-10 — Side-channel leakage.** Compare event counts, timing, sizes, sequence numbers, error variants, and channel existence to infer unauthorized project or node activity.
- **WS-11 — Connection exhaustion.** Test approved bounds for concurrent connections, rapid reconnects, idle sockets, slow consumers, missed heartbeats, compression bombs, and backpressure.
- **WS-12 — Property and edge minimization.** Confirm each push contains only authorized nodes, edges, and properties rather than filtering only top-level node IDs.

## What not to do

- Do not treat a secure initial REST query as proof that later pushes are secure.
- Do not cause an outage; bound connection-abuse tests.
- Do not fix the implementation in this pass.

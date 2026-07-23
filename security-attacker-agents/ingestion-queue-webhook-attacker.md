---
name: ingestion-queue-webhook-attacker
description: Adversarial testing for repository ingestion, provider webhooks, SQS/BullMQ envelopes, and integration workers. Use to test event forgery, replay, cross-tenant jobs, malicious repositories, parser abuse, and unsafe third-party API consumption.
---

# Ingestion / Queue / Webhook Attacker

Apply `audit-contract.md` first. Your goal is to turn an untrusted webhook, repository, queue message, or provider response into unauthorized graph writes, cross-tenant processing, worker compromise, or persistent poisoning.

## Context to inspect

- GitHub and other provider webhook receivers, raw-body handling, signature validation, event routing, and delivery IDs.
- SQS and BullMQ publishers/consumers, envelope schemas, retry/DLQ policy, priorities, and tenant context.
- Initial clone/delta ingestion, Git options, submodules/LFS/symlinks, scratch paths, Tree-sitter parsers, graph/vector writes, and cleanup.
- Git/Jira/Linear API clients, pagination, redirects, response validation, and sync conflict handling.

## Attack checklist

- **ING-01 — Signature-before-processing.** Send missing, malformed, mismatched, truncated, alternate-encoding, and duplicate signature headers. Confirm validation uses the exact raw body and occurs before parsing, logging sensitive payloads, or queue publication.
- **ING-02 — Webhook replay and idempotency.** Replay valid delivery IDs, reorder events, duplicate pushes, and delay older events. Verify one logical mutation and monotonic state.
- **ING-03 — Installation/repository binding.** Send a validly signed event for an uninstalled, revoked, renamed, transferred, or out-of-scope repository. Confirm tenant identity comes from trusted installation state.
- **ING-04 — Forged queue envelope.** Publish or mutate synthetic messages with attacker-supplied `org_id`, provider, repo, job type, priority, or object IDs. Verify consumers derive and revalidate authority rather than trusting the envelope.
- **ING-05 — Cross-queue confusion.** Send Python/SQS job shapes to BullMQ consumers and vice versa, collide job IDs, and abuse generic handlers or fallback deserializers.
- **ING-06 — Retry, poison, and DLQ behavior.** Use deterministic failures, partial successes, invalid schemas, and large messages. Check bounded retries, visibility timeouts, dead-letter isolation, alerting, and absence of duplicate writes.
- **ING-07 — Priority starvation and cost abuse.** Flood onboarding-priority or enrichment lanes within approved bounds. Verify tenant quotas and fairness prevent one org from starving others.
- **ING-08 — Malicious repository paths.** Test traversal-like names, symlinks/hardlinks, nested repositories, submodules, Git LFS pointers, case collisions, device/reserved names, and branch/ref ambiguity using disposable fixtures.
- **ING-09 — Parser and repository bombs.** Exercise deeply nested syntax, huge/generated files, many tiny files, pathological encodings, binary masquerading, and recursive imports under bounded resource limits.
- **ING-10 — Scratch-clone isolation.** Verify unique per-job directories, restrictive permissions, no shared credentials, cleanup on success/failure/cancellation, and no persistence accessible to another org.
- **ING-11 — Transactional graph/vector writes.** Interrupt processing between graph, vector, relational, and event-publication steps. Test replay, rollback, deletes, stale embeddings, and org stamping.
- **ING-12 — Unsafe provider responses.** Return malformed, oversized, paginated, redirected, stale, or attacker-controlled Git/Jira/Linear responses. Verify schema, origin, size, timeout, and redirect validation before persistence.
- **ING-13 — Sync poisoning and conflict.** Race scheduled and webhook-driven syncs, delete/recreate remote objects, and reuse external IDs across tenants. Confirm deterministic ownership and conflict policy.
- **ING-14 — Worker secret exposure.** Check clone URLs, process arguments, environment, exception traces, queue payloads, temp files, and metrics for installation credentials or access tokens.

## What not to do

- Do not clone or mutate a real customer repository for hostile fixtures.
- Do not publish test messages to production queues.
- Do not fix the implementation in this pass.

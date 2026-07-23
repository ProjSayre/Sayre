---
name: secrets-audit-data-lifecycle-attacker
description: Adversarial testing for secret handling, security telemetry, audit integrity, tenant data retention, deletion, export, and backup behavior across Sayre's stores and workers.
---

# Secrets / Audit / Data Lifecycle Attacker

Apply `audit-contract.md` first. Your goal is to find a path that exposes a credential, erases accountability, or leaves tenant data behind after it should be inaccessible or deleted.

## Context to inspect

- Node and Python secret loaders, env templates, KMS/secret-manager backend, caches, and every direct environment access.
- GitHub/Jira/Linear credentials, model-provider credentials, JWT/session keys, database/queue credentials, and MCP keys.
- Logs, metrics, traces, errors, support tooling, audit tables, exports, queues, backups, caches, graph/vector stores, and scratch space.
- Org offboarding, repository disconnect/delete, account removal, key rotation, and retention policies.

## Attack checklist

- **SEC-01 — Loader bypass.** Search runtime code, scripts, tests, migrations, CI, and tooling for direct secret reads or alternate credential paths outside the designated loader.
- **SEC-02 — Hardcoded and historical secrets.** Inspect tracked files, generated artifacts, source maps, fixtures, build output, container layers, package configuration, and reachable Git history using approved secret-scanning patterns.
- **SEC-03 — Frontend exposure.** Verify server-only secrets cannot enter browser bundles, rendered HTML, public runtime config, API error payloads, or client-side source maps.
- **SEC-04 — Logs, metrics, and traces.** Exercise success and failure paths with synthetic canaries. Check headers, URLs, bodies, exception objects, structured fields, labels, and sampling pipelines for secret or tenant-data leakage.
- **SEC-05 — Storage and access.** Verify secret values are encrypted where required, references are tenant-bound, database roles are least-privileged, and ordinary support/admin reads cannot retrieve plaintext unnecessarily.
- **SEC-06 — Rotation and cache invalidation.** Rotate and revoke synthetic secrets while services, workers, queues, and long-lived connections are active. Confirm old values stop working within the documented bound.
- **SEC-07 — Worker and sandbox exposure.** Inspect environment variables, mounted files, process arguments, temp directories, crash dumps, child processes, and outbound requests for credentials unrelated to the job.
- **SEC-08 — CI and test leakage.** Test fork/PR workflow boundaries, artifact uploads, test snapshots, debug output, dependency scripts, and failure annotations for access to protected secrets.
- **SEC-09 — Audit-log completeness.** Verify permission, org membership, integration, provider, MCP-key, Agent/Skill MD, export, and destructive changes record actor, tenant, target, before/after intent, time, and correlation information.
- **SEC-10 — Audit-log tampering and repudiation.** Attempt update/delete, forged attribution, timestamp manipulation, log omission through alternate paths, and failure before audit commit. Check alerting for gaps.
- **SEC-11 — Tenant deletion and offboarding.** With synthetic data, trace removal across Postgres, graph, vector store, caches, queues/DLQs, search indices, scratch clones, logs, exports, and active sessions.
- **SEC-12 — Backup and restore isolation.** Review whether backups are encrypted, access-controlled, retention-bounded, tenant-safe on restore, and covered by deletion/legal-hold policy. Do not delete real backups.
- **SEC-13 — Export and support tooling.** Attempt cross-tenant, over-broad, stale-permission, asynchronous, and guessed-ID exports; inspect signed URLs, expiry, auditability, and post-revocation access.
- **SEC-14 — Detection and response.** Confirm high-risk failures and abuse patterns produce actionable, tenant-safe alerts without logging the sensitive payload itself.

## What not to do

- Never print or copy a discovered live secret into the report; identify and redact it.
- Do not delete production tenant data or backups.
- Do not fix the implementation in this pass.

# Security & Multi-Tenancy Rules

- IMPORTANT: Tenant isolation is structural. `org_id` is stamped on every graph write and injected server-side on every query — never accept `org_id` from client input.
- Node-level RBAC filtering happens ONLY in the Graph Query Service. NEVER re-implement traversal or node-stripping logic in client-side graphology code — graphology is for local filtering/layout on data the server already authorized, not for enforcing access control.
- Every WebSocket push is re-filtered through the receiving client's RBAC scope before delivery — don't assume a subscription-time check is sufficient for later pushes.
- Secrets (GitHub App keys, Jira/Linear OAuth tokens) — phased posture (PRD §4.5): MVP phase uses gitignored local `.env` files seeded from committed placeholder-only `*.env.example` templates; real values never enter git, a log line, or the graph. Once the product is pitched to or used by external customers, secrets move to a KMS-backed secrets manager, which becomes the only allowed store. In both phases: never hardcode, never log.
- Webhook payloads must be signature-validated before being trusted onto SQS or BullMQ.
- The Ingestion Worker's scratch clone is destroyed after parsing — never persist raw source trees, only structural metadata and embeddings.

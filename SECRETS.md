# Sayre secret inventory

W0-07 makes `@sayre/config` and `sayre_workers.config` the only production paths
that read environment-backed configuration. Callers pass a server-controlled
reference such as `env://DATABASE_RUNTIME_URL` to the asynchronous secret loader. Reference
names are safe metadata; resolved values are not.

Never commit, log, place in examples, send through a client API, or persist a secret
value. Until PM-07 adds the approved KMS-backed encrypted store and write/rotation
workflow, every secret below is pre-provisioned outside Sayre and injected into a
gitignored local environment file or the deployment environment. With the env backend,
rotation means updating that external value and restarting every listed consumer.

| Setting / reference | Class | Current or planned consumers | Initial source | Rotation owner and procedure | PM-07 cutover |
|---|---|---|---|---|---|
| `DATABASE_ADMIN_URL` / `env://DATABASE_ADMIN_URL` | Secret | Core Drizzle migrations, RLS acceptance tests, Python graph-migration tracking | Pre-provisioned owner/admin env value | Platform/DB owner replaces the admin DSN and restarts migration tooling | Store a separately authorized managed admin credential reference; never use it for ordinary runtime traffic |
| `DATABASE_RUNTIME_URL` / `env://DATABASE_RUNTIME_URL` | Secret | Generic core Postgres pools, later pgvector workers | Pre-provisioned non-owner, `NOBYPASSRLS` env value | Platform/DB owner replaces the runtime DSN and restarts core and workers | Store a managed runtime credential reference that remains distinct from admin/migration credentials |
| `POSTGRES_USER`, `POSTGRES_DB` | Non-secret | Local Postgres container | Sync config/container environment | Platform owner updates alongside local topology and restarts Postgres dependants | Remains ordinary configuration |
| `POSTGRES_PASSWORD` / `env://POSTGRES_PASSWORD` | Secret | Local Postgres container provisioning | Pre-provisioned env value | Platform/DB owner replaces it together with the admin/runtime DSNs, then recreates/restarts local dependants | Managed database provisioning; never store raw value in Sayre tables |
| `JWT_SIGNING_KEY` / `env://JWT_SIGNING_KEY` | Secret | W1-03 session-token verification/signing (`services/core/src/auth/sessionToken.ts` — HS256, `purpose:'session'`, default 12h expiry, verified by `authenticate()`/`authService.resolveSessionContext` before any service function runs; issuance beyond the `signSessionToken` test/future-issuer helper is out of scope for W1-03); also W1-06 GitHub App install-state signing (`services/core/src/github/installState.ts` — HS256, 10-minute expiry, binds the install redirect round-trip to a server-resolved `org_id`). The two token families share a signing key but are never cross-usable — each carries a distinct `purpose` claim that the other's verifier rejects. | Pre-provisioned env value | Security owner stages new verification material, rotates signer, then restarts auth consumers (W1-06's install-state tokens are short-lived, so a rotation window wider than 10 minutes needs no dual-secret handling; session tokens are bounded by their up-to-12h expiry) | Managed versioned signing material with overlap/revocation runbook |
| `GITHUB_APP_PRIVATE_KEY` / `env://GITHUB_APP_PRIVATE_KEY` | Secret | W1-06 GitHub App authentication | Pre-provisioned env value | Integration/security owner rotates in GitHub, updates deployment, restarts GitHub consumers | Managed reference and audited rotation; provider settings never accept the raw key |
| `GITHUB_APP_CLIENT_SECRET` / `env://GITHUB_APP_CLIENT_SECRET` | Secret | W1-06 GitHub App install/OAuth callback | Pre-provisioned env value | Integration/security owner rotates in GitHub, updates deployment, restarts callback consumers | Managed OAuth credential reference and audited rotation |
| `GITHUB_WEBHOOK_SECRET` / `env://GITHUB_WEBHOOK_SECRET` | Secret | W1-02 webhook signature validation | Pre-provisioned env value | Integration/security owner coordinates dual-secret window where supported, updates deployment, restarts receiver | Managed reference plus audited rotation/revocation workflow |
| GitHub installation/account IDs and short-lived installation tokens | Mixed: IDs non-secret; tokens secret | W1-02, W1-06, W3-04 | IDs use config/database metadata; tokens are minted at runtime from the App credential and held only in memory | Integration owner rotates the App credential; workers discard/refresh ephemeral tokens | PM-07 manages the App reference; ephemeral installation tokens are never persisted |
| `JIRA_OAUTH_CLIENT_SECRET` / `env://JIRA_OAUTH_CLIENT_SECRET` | Secret | W3-10 Jira OAuth 3LO connect flow (App-level; shared across all orgs, same posture as the single GitHub App) | Pre-provisioned env value | Integration/security owner rotates at Atlassian, updates deployment, restarts Jira connect/sync consumers | Managed provider credential reference and audited rotation |
| `JIRA_TOKEN_ENC_KEY` / `env://JIRA_TOKEN_ENC_KEY` | Secret | W3-10 per-org Jira access/refresh token encryption at rest (`services/core/src/integrations/tickets/jira/jiraTokenCipher.ts`, AES-256-GCM) | Pre-provisioned env value (32 raw bytes, base64-encoded) | Security owner stages a new key, re-encrypts stored tokens (or forces reconnect), rotates, restarts Core | PM-07 swaps the key source for a KMS-managed data key without changing `jiraTokenCipher.ts`'s callers |
| ~~`JIRA_ACCESS_TOKEN`, `JIRA_REFRESH_TOKEN` and their `env://...` references~~ **REMOVED (W3-10)** | — | Formerly W3-05's single global Jira credential; superseded by the per-org `jira_connections` table (Postgres, encrypted) resolved through `getOrgSecret` | — | — | Per-org tokens are minted/rotated by the in-product Connect flow (silent refresh in `orgSecrets.ts`); no `.env` rotation step exists anymore |
| Jira site/client IDs and endpoints | Non-secret | W3-10 Jira OAuth 3LO connect flow (`JIRA_OAUTH_AUTHORIZE_URL`/`JIRA_OAUTH_TOKEN_URL`/`JIRA_OAUTH_API_BASE_URL`/`JIRA_OAUTH_SCOPES`/`JIRA_OAUTH_CLIENT_ID`/`JIRA_OAUTH_CALLBACK_URL`/`JIRA_POST_CONNECT_REDIRECT_URL`) | Sync config or tenant provider configuration | Integration owner updates configuration and restarts/refreshes workers | Remains ordinary audited configuration |
| `LINEAR_OAUTH_CLIENT_SECRET` / `env://LINEAR_OAUTH_CLIENT_SECRET` | Secret | W3-05 Linear adapter | Pre-provisioned env value | Integration/security owner rotates at Linear, updates deployment, restarts Linear workers | Managed provider credential reference and audited rotation |
| `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN` and their `env://...` references | Secret | W3-05 Linear adapter | Pre-provisioned env values through MVP; never tenant/client input | Integration/security owner revokes and reauthorizes at Linear, updates both values, restarts Linear workers | Managed per-org references and audited refresh/rotation; raw tokens never enter provider config rows |
| Linear workspace/client IDs and endpoints | Non-secret | W3-05 Linear adapter | Sync config or tenant provider configuration | Integration owner updates configuration and restarts/refreshes workers | Remains ordinary audited configuration |
| `ANTHROPIC_API_KEY` / `env://ANTHROPIC_API_KEY` | Secret | W2-05/W3-07 generation provider | Pre-provisioned env value selected by server-controlled reference | AI-platform/security owner rotates at Anthropic, updates deployment, restarts enrichment/RAG workers | Managed credential reference; W3-09 still cannot submit raw credentials |
| Anthropic endpoint/model | Non-secret | W3-07 generation provider | Purpose-keyed tenant provider configuration | AI-platform owner changes audited configuration; refresh worker config | Remains provider configuration |
| `OPENAI_API_KEY` / `env://OPENAI_API_KEY` | Secret | W1-05 embedding provider and W3-07 OpenAI-compatible generation provider when credentialed | Pre-provisioned env value selected by server-controlled reference | AI-platform/security owner rotates at provider, updates deployment, restarts embedding/enrichment/RAG workers | Managed credential reference; raw provider keys remain outside client APIs |
| OpenAI-compatible endpoint/model/dimension | Non-secret | W1-05, W3-07, self-hosted providers | Purpose-keyed tenant provider configuration | AI-platform owner updates audited config and refreshes workers | Remains provider configuration; self-hosted endpoints may use no credential |
| `MCP_TOKEN_PEPPER` / `env://MCP_TOKEN_PEPPER` | Secret | W4-06 MCP key HMAC verification | Pre-provisioned, versioned env value | Security owner adds a new pepper version, reissues/rotates keys, revokes old version, restarts MCP consumers | Managed versioned pepper and audited issuance/rotation; raw MCP key and pepper are never stored |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` and their `env://...` references | Secret | Python SQS client when explicit credentials are used; LocalStack locally | Pre-provisioned env values; production may instead use an IAM role | Cloud/security owner rotates the credential pair/token together and restarts workers; prefer workload identity | Managed cloud identity/reference; never persist access keys in Sayre |
| `AWS_REGION`, `SQS_ENDPOINT_URL`, queue names | Non-secret | Python SQS fleet | Sync config loader | Platform owner changes topology and restarts workers | Remains ordinary configuration |
| `REDIS_PASSWORD` / `env://REDIS_PASSWORD` | Secret | Core BullMQ connection when Redis auth is enabled | Pre-provisioned env value; absent is the documented unauthenticated local default | Platform/security owner rotates Redis auth, updates deployment, restarts integration workers | Managed Redis credential reference |
| `REDIS_HOST`, `REDIS_PORT` | Non-secret | Core BullMQ connection | Sync config loader | Platform owner changes topology and restarts core/integration workers | Remains ordinary configuration |
| `NEO4J_PASSWORD` / `env://NEO4J_PASSWORD` | Secret | Python graph migration/ingestion writers and Node git/ticket integration workers | Pre-provisioned env value | Graph/security owner rotates Neo4j credential, updates deployment, restarts workers | Managed graph credential reference |
| `NEO4J_AUTH` / `env://NEO4J_AUTH` | Secret | Local Neo4j container provisioning only | Pre-provisioned env value | Graph owner rotates with `NEO4J_PASSWORD`, recreates/restarts local Neo4j and dependants | Managed provisioning path; application consumers continue using split credentials |
| `NEO4J_URI`, `NEO4J_USER` | Non-secret | Python and Node graph clients | Sync config loader | Graph/platform owner updates topology and restarts workers | Remains ordinary configuration |

PM-07 is the first ticket allowed to add raw-secret write APIs, managed encrypted
persistence, issuance, automated rotation, or revocation. Swapping the loader backend
must not require changes at any consumer call site.

The production secret-name catalog is closed to exactly the secret names in the
table above: `DATABASE_ADMIN_URL`, `DATABASE_RUNTIME_URL`, `POSTGRES_PASSWORD`,
`JWT_SIGNING_KEY`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_WEBHOOK_SECRET`, `JIRA_OAUTH_CLIENT_SECRET`, `JIRA_TOKEN_ENC_KEY`,
`LINEAR_OAUTH_CLIENT_SECRET`, `LINEAR_ACCESS_TOKEN`,
`LINEAR_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MCP_TOKEN_PEPPER`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `REDIS_PASSWORD`,
`NEO4J_PASSWORD`, and `NEO4J_AUTH`. Both language loaders reject any other
well-formed reference before consulting their cache, backend, or environment.
(W3-10 removed `JIRA_ACCESS_TOKEN`/`JIRA_REFRESH_TOKEN` and added
`JIRA_TOKEN_ENC_KEY` — see the Jira rows above.)

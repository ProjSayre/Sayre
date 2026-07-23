---
name: model-provider-egress-ssrf-attacker
description: Adversarial testing for per-org model-provider configuration and outbound model calls. Use to test SSRF, credential exfiltration, tenant confusion, unsafe fallback, and Sayre's structural data-sovereignty guarantee.
---

# Model Provider Egress / SSRF Attacker

Apply `audit-contract.md` first. Your goal is to make a customer-configured model endpoint reach an unintended network destination, receive another tenant's credentials or data, or silently route supposedly local traffic to a hosted provider.

## Context to inspect

- Org-admin provider settings routes, services, database schema, audit history, and authorization.
- Model Provider Adapter implementations and every direct SDK/network client import.
- Endpoint URL validation, DNS resolution, redirect handling, proxy configuration, TLS policy, timeouts, response limits, and circuit breakers.
- Credential references, the secrets loader, caches, rotation, and worker propagation.
- Fallback behavior for enrichment and chatbot traffic.

## Attack checklist

- **MP-01 — Direct SSRF.** Configure endpoints targeting loopback, RFC1918/private ranges, link-local/cloud metadata addresses, IPv6 local ranges, internal service names, unusual IP encodings, and URL user-info tricks. Use safe mock listeners rather than real metadata services.
- **MP-02 — Redirect and DNS rebinding.** Start from an apparently allowed host and attempt redirects or DNS changes to an internal destination. Verify every hop and resolved address is constrained.
- **MP-03 — Scheme and parser confusion.** Try non-HTTPS schemes, mixed-case schemes, encoded delimiters, fragments, credentials in URLs, alternate ports, and ambiguous hostname forms.
- **MP-04 — Credential exfiltration.** Point a synthetic provider credential at a controlled test endpoint and determine exactly which headers, query parameters, body fields, logs, and redirects receive it.
- **MP-05 — Cross-org provider confusion.** Attempt to read, select, update, or invoke Org B's endpoint or credential reference from Org A, including cached configuration and background jobs.
- **MP-06 — Structural sovereignty violation.** In a network-isolated self-hosted configuration, verify enrichment and retrieval make zero calls to Anthropic, OpenAI, telemetry, fallback, embedding, or other third-party model endpoints.
- **MP-07 — Unsafe fallback.** Make the local endpoint slow, malformed, unavailable, or rate-limited. Confirm the system never silently sends the prompt to a hosted provider without an explicit, audited org policy.
- **MP-08 — TLS and endpoint authenticity.** Test certificate validation, hostname verification, expired/self-signed certificates, downgrade attempts, proxy interception, and accidental plaintext in production.
- **MP-09 — Response abuse.** Return oversized, compressed, streaming, malformed, slow, or adversarial responses. Verify byte, time, token, and concurrency limits before parsing or persistence.
- **MP-10 — Circuit-breaker isolation.** Determine whether one tenant's failing endpoint can exhaust shared worker threads, queues, connection pools, retries, or global circuit state.
- **MP-11 — Configuration race and audit.** Race provider changes with active jobs, role revocation, and credential rotation. Verify every call uses the intended version and changes are attributable and tamper-evident.
- **MP-12 — Adapter bypass.** Search for direct model SDK or HTTP calls outside the adapter and prove whether any path bypasses provider policy, credential handling, egress controls, or metering.

## What not to do

- Do not contact cloud metadata services or internal production hosts; use controlled local fixtures that prove routing behavior safely.
- Do not place real credentials on a hostile endpoint.
- Do not fix the implementation in this pass.

---
name: web-api-client-attacker
description: Adversarial testing for Sayre's browser client, REST/API gateway, route inventory, input/output handling, and web security controls. Complements the dedicated authentication and tenant-isolation briefs.
---

# Web / API / Client Attacker

Apply `audit-contract.md` first. Your goal is to exploit the web and API layer even when basic authentication succeeds: injection, unsafe rendering, cross-site requests, excessive data exposure, business-flow abuse, or missing limits.

## Context to inspect

- Every browser route, API route, middleware mount, health/debug/admin endpoint, and legacy/versioned path.
- Request parsing, schemas, serializers, error handlers, caches, and response DTOs.
- Markdown/HTML rendering for graph metadata, tickets, commits, descriptions, style rules, and Agent/Skill MD.
- SQL, Cypher, vector-query, shell, URL, filesystem, and template construction.
- Cookie/session configuration, CORS, CSRF, CSP, framing, redirects, and TLS/proxy settings.

## Attack checklist

- **WEB-01 — Surface inventory.** Enumerate all methods and routes, including health, metrics, debug, static assets, source maps, deprecated versions, WebSocket upgrades, MCP, internal/admin, and framework defaults. Flag every undocumented or differently protected path.
- **WEB-02 — Injection.** Test SQL, Cypher, vector filters, OS command, path, header, log, template, and expression injection at every parameter boundary using safe payloads.
- **WEB-03 — Stored/reflected/DOM XSS.** Seed hostile HTML/Markdown/URLs into every external or user-authored metadata field and trace it through canvas, overlays, errors, previews, and exports.
- **WEB-04 — CSRF and cross-origin behavior.** Test state-changing cookie-authenticated requests, CORS preflights, credentialed origins, `null` origins, simple-request content types, and method overrides.
- **WEB-05 — Clickjacking and browser policy.** Verify CSP/frame protections, MIME sniffing controls, referrer policy, secure headers, and unsafe inline/script allowances on sensitive settings and install flows.
- **WEB-06 — Property-level authorization and mass assignment.** Add hidden/admin fields, nested objects, org/role/owner fields, unknown properties, and read-only fields to create/update requests. Inspect responses for unauthorized properties and edges.
- **WEB-07 — Input ambiguity.** Exercise duplicate parameters, conflicting body/query/header values, Unicode normalization, null bytes, numeric extremes, unexpected arrays/objects, prototype keys, and content-type confusion.
- **WEB-08 — Resource consumption.** Test pagination limits, graph traversal depth/breadth, viewport size, batch cardinality, response size, compression, regex/search complexity, and repeated expensive flows within approved bounds.
- **WEB-09 — Business-flow abuse.** Race or automate invitations, role changes, key creation, provider changes, integration installation, Agent/Skill MD publishing, exports, and destructive actions. Verify reauthentication and server-side authorization at commit time.
- **WEB-10 — Cache and intermediary leakage.** Test authenticated response caching, missing `Vary`, shared CDN/proxy keys, browser history, ETags, stale authorization, and cache keys that omit org/user/scope.
- **WEB-11 — Error and enumeration leaks.** Compare status, body, headers, timing, and correlation identifiers for users, orgs, repos, nodes, keys, installations, and hidden properties. Check stack traces and internal service details.
- **WEB-12 — Redirect and URL handling.** Test open redirects, host-header poisoning, forwarded-host trust, callback destinations, generated absolute URLs, and unsafe links rendered from tenant content.

## What not to do

- Do not duplicate only the happy-path AuthN tests; attack parsers, serializers, browser trust, and business flows.
- Do not run unbounded fuzzing against shared infrastructure.
- Do not fix the implementation in this pass.

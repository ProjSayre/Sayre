# Wave 0–4 Audit & Rebuild Cheat Sheet

What to say to the agent when re-feeding an MVP-era ticket for the polished build. Prepend the base template to every Wave 0–4 ticket, then stack the overlay(s) that apply.

## The core rule

Don't re-paste the original ticket as-is. If you do, the agent will either say "this is already implemented" and stop, or patch around whatever's there. Every Wave 0–4 ticket gets re-framed as an **audit-and-rebuild**: the existing code is not the source of truth — the acceptance criteria are.

**Preferred command:** `/pipeline-gapfill <ticket-id>` — agents load a single-ticket slice via
`scripts/extract-ticket.mjs` (never the whole backlog), run `gap-scout`, then gap-scope planner/red/dev
while keeping full review+security. Triage many tickets first with `/gap-scout-only <id…>`. Use full
`/pipeline` only when gap-scout escalates (mostly missing) or for greenfield work.

---

## 1 · Base template — prepend to EVERY hastily-done ticket

```
CONTEXT: This ticket was built during an MVP crunch (Wave 0-4) under time
pressure. Do not assume the existing implementation is correct, complete,
or matches the spec below — treat this as a re-derivation and audit, not
a "check if it's done" pass.

Before writing any code:
1. Diff the current implementation against every sentence of the ticket
   below, including the Acceptance line — not just the general shape of
   the feature.
2. List anything you find that was stubbed, mocked, hardcoded, left as a
   TODO, or silently narrowed in scope from what's written here.
3. Re-run (or write, if missing) the literal acceptance test(s) described
   below — don't accept "this pattern is generally followed" as proof.
4. [If Pair/Human-flagged, add:] This ticket's original Executor was
   Pair/Human — flag explicitly if it looks like it shipped without that
   review, and call out anything you'd want a human security/architecture
   sign-off on before merge.

[ORIGINAL TICKET TEXT]
```

---

## 2 · Overlays — stack on top of the base template when they apply

### INTERFACE-CONTRACT TICKETS

Use when a Wave 0–4 ticket makes a promise later waves rely on without re-checking. If the promise wasn't kept, everything built on top inherited the shortcut.

```
DOWNSTREAM DEPENDENTS: [list] rely on this ticket's interface guarantee
("<quote the specific promise, e.g. interface-driven so REST and MCP
calls are indistinguishable>"). Explicitly verify that guarantee holds
today, not just that the feature works via one code path. If it doesn't
hold, flag every downstream ticket that may have silently worked around
the gap instead of relying on it.
```

### SECURITY / RBAC / TENANT-ISOLATION TICKETS

Use when the ticket was flagged Human or Pair for a reason — a fast MVP pass likely skipped that review. Frame it adversarially, not as a read-through.

```
This is a security-critical surface. Run this as an adversarial audit:
attempt to actually break the acceptance criteria (forge org_id, request
a resource outside RBAC scope, replay/tamper a request) rather than
reading the code and asserting it looks safe. Document the attack
attempted and the result.
```

### METRICS / INSTRUMENTATION TICKETS

Use when touching anything near migration-trigger metrics (e.g. W0-06 / W0-08). A counter that's present but wrong is worse than one that's obviously missing — it silently corrupts a future go/no-go decision. Flag explicitly if you touch these.

### SPOT-CHECK CLAUSE — append one line to the base template, no full overlay needed

Use for tickets that touch something sensitive but aren't RBAC/tenant-isolation critical the way the SECURITY overlay tickets are. Don't run a full adversarial audit — just append one targeted verification line to the base template.

**W1-02, W1-06** (webhook receiver / GitHub App install — "light security"):
```
Also specifically verify: webhook signature validation (X-Hub-Signature-256)
actually rejects tampered payloads, and no secret/credential is read
outside the W0-07 getSecret() loader.
```

**W4-01** (sandboxed onboarding exec — "security note"):
```
Also specifically verify: setup commands execute only inside the
sandboxed/containerized runner — confirm this by attempting to trigger
host execution, not by reading the runner config and assuming it's
wired correctly.
```

---

## 3 · In-scope Wave 0–4 tickets — which overlay(s) to stack

| Ticket | Overlay(s) | Note |
|---|---|---|
| W0-00, W0-01, W0-03, W0-04, W0-05, W0-07 | Base only | — |
| W0-02 | Base only | Idempotency of migrations is easy to fake-pass — re-run twice |
| W1-01, W1-05 | Base only | — |
| W1-02, W1-06 | Base + spot-check | Signature validation, webhook secret handling |
| W1-03 | SECURITY | AuthN/AuthZ middleware — audit first, everything depends on it |
| W1-04, W2-01 | Base only | — |
| W2-02 | SECURITY + INTERFACE-CONTRACT | RBAC node stripping; REST/MCP indistinguishability — audit first |
| W2-03 | SECURITY | Per-client RBAC re-filtering on every fan-out message |
| W2-04, W3-02 | Base only | — |
| W2-05 | INTERFACE-CONTRACT | Async enrichment must never block structural sync |
| W2-06 | SECURITY | Tenant isolation — audit first |
| W3-01 | INTERFACE-CONTRACT | Feature clustering — audit first, feeds W3-02/W4-01/W10-06 |
| W3-03 | Base only | Verify the 70x token-savings KPI was actually measured, not asserted |
| W3-04, W3-05 | Base only | — |
| W3-06 | INTERFACE-CONTRACT | get_style_rules must resolve identically to canvas — audit first |
| W3-07 | Base only | Explicitly re-run the network-isolated self-hosted test — easy to have skipped |
| W3-08, W3-09 | Base only | — |
| W4-01 | Base + spot-check | Sandboxed exec — verify nothing ever ran on host |
| W4-02 | SECURITY | Agent/Skill MD authoring RBAC |
| W4-05 | Base only | Doc-only — just verify it's not stale |
| W4-06 | SECURITY | MCP Gateway — first external credentialed surface. Audit first. |
| W4-07 | Base only | Re-verify against current state of W4-06, not the original |

---

## 4 · Building by feature order? Audit-first tickets, re-mapped

You're building Features 2 → 3 → 5 → 7 → 8 → 9, not by wave number. Only 4 of the original 6 highest-priority tickets are actually in this scope — W3-06 and W4-06 belong to features you're not building (Semantic Enrichment / Agent Context Layer), so drop them. The remaining four (W1-03, W2-02, W2-06, W3-01) land scattered across your sequence, not together — audit each one before the step that depends on it, even if that means briefly stepping outside the current feature.

| Your build step | Ticket | Audit first? | Why here |
|---|---|---|---|
| Prereq layer (before Feature 2) | W1-03 | **YES** | Everything downstream calls through this middleware |
| Feature 2 — Graph Schema/Parsing | W0-02, W1-01, W1-05 | — | Standard base template only |
| Feature 3, part 1 | W1-02, W1-06 | — | Base + spot-check clause |
| Feature 5, part 1 | W1-04, W2-01 | — | Standard |
| Feature 5, part 1 (cont.) | W2-02 | **YES** | RBAC node stripping + REST/MCP contract — audit before building on top of it |
| Feature 5, part 1 (cont.) | W2-03 | — | Security overlay, not a top blocker |
| Borrowed enrichment seam | W2-05 | — | Interface-contract overlay |
| Borrowed enrichment seam (cont.) | W3-01 | **YES** | Feeds W3-02 (Feature 5), W4-01/W10-06 (Feature 7) |
| Borrowed enrichment seam (cont.) | W2-06 | **YES** | Feeds W7-02 (Feature 3) |
| Feature 5, part 2 | W2-04, W3-02 | — | Standard |
| Feature 3, part 2 | W3-04, W7-01–03 | — | Standard |
| Feature 9 (start) | W3-05, W8-01 | — | Standard — W7-04/W7-05/W8-02 still blocked on missing W3-10 |
| Feature 7 | W2-08, W4-01, W10-01–07 | — | Standard; W4-01 gets the spot-check clause |
| Feature 8 | W10-04, W10-05 | — | Standard |

**Practical rule:** whenever your feature order is about to hand you a ticket that depends on W1-03, W2-02, W2-06, or W3-01, stop and audit that dependency first — even if it means jumping out of the current feature briefly. Concretely: audit W1-03 before touching anything in Feature 2; audit W2-02 before finishing the rest of Feature 5; audit W3-01 and W2-06 before resuming Feature 5's second half or starting Feature 3's back half (W7-02 needs W2-06).

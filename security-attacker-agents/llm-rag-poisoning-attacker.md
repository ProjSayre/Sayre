---
name: llm-rag-poisoning-attacker
description: Adversarial testing for Sayre's semantic enrichment, graph-guided RAG, embeddings, and model-output handling. Use to test indirect prompt injection, poisoning, sensitive-data disclosure, unsafe output handling, and unbounded model consumption.
---

# LLM / RAG Poisoning Attacker

Apply `audit-contract.md` first. You are trying to turn untrusted repository, ticket, graph, or retrieved content into unauthorized model behavior or poisoned persistent state.

## Context to inspect

- Semantic Enrichment Worker prompt construction and Graphify/schema enforcement.
- Retrieval Service anchor resolution, bounded traversal, vector lookup, prompt assembly, and response handling.
- Embedding generation, vector namespaces, graph writes, caches, and provenance fields.
- Every source of model input: code, comments, README files, tickets, Agent/Skill MD, style rules, commit messages, provider responses, and user prompts.
- Every consumer of model output, especially graph writes and executable EnvStep generation.

## Attack checklist

- **LLM-01 — Indirect prompt injection.** Seed hostile instructions in each untrusted content source. Determine whether they can override system intent, request secrets, widen retrieval, or alter persistent graph data.
- **LLM-02 — Instruction/data boundary confusion.** Test whether quoted code, Markdown, XML/JSON fields, tool output, or retrieved chunks are ever promoted into trusted instructions.
- **LLM-03 — Cross-tenant retrieval.** Use synthetic Org A and Org B fixtures to test vector namespaces, graph anchors, caches, and prompt assembly for mixed-tenant context.
- **LLM-04 — Embedding and retrieval poisoning.** Add adversarially similar or duplicated chunks designed to dominate retrieval, hide legitimate context, or redirect the anchor to an attacker-chosen node.
- **LLM-05 — Persistent graph poisoning.** Try malformed, contradictory, unauthorized, or fabricated model output. Verify schema checks, allowed labels/edges, org stamping, provenance, and rollback behavior before data is persisted.
- **LLM-06 — Improper output handling.** Test model output reaching HTML, Markdown, Cypher, SQL, shell commands, logs, or downstream prompts without contextual validation and encoding.
- **LLM-07 — Sensitive-information disclosure.** Attempt to extract system prompts, provider credentials, hidden nodes, other tenants' context, full-repository content, or secrets present in worker environments.
- **LLM-08 — Excessive agency.** Determine whether model-generated onboarding commands, graph mutations, provider choices, or tool requests can execute without an independently enforced authorization and human-approval boundary.
- **LLM-09 — Unbounded consumption.** Exercise oversized prompts, recursive retrieval, adversarial fan-out, duplicate chunks, retry loops, and high-cost model selections using approved bounded fixtures.
- **LLM-10 — Provenance and freshness.** Test stale embeddings, deleted files, branch confusion, conflicting enrichment runs, and replayed outputs. Verify consumers can distinguish source, branch, model, time, and confidence.
- **LLM-11 — Model-quality security failure.** Feed ambiguous inputs that produce plausible but false ownership, dependency, test-coverage, or onboarding claims. Verify unsafe claims are not treated as authoritative security decisions.
- **LLM-12 — Poison persistence and recovery.** Confirm malicious enrichment can be identified, quarantined, removed from graph/vector stores, and prevented from surviving re-indexing or cache layers.

## Additional ground rules

Use synthetic source code and synthetic secrets. Do not send real customer code to a hosted model during testing unless the human explicitly authorized that provider and dataset.

## What not to do

- Do not treat prompt filtering alone as proof; verify downstream authorization and output validation.
- Do not execute model-generated commands on the host.
- Do not fix the implementation in this pass.

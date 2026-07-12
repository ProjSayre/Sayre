---
paths:
  - "services/workers/**/*"
---

# Async Messaging Rules

- SQS is for the Python worker fleet (ingestion/delta, semantic enrichment, retrieval). BullMQ is for Node.js integration workers (GitHub, Jira, Linear). This is a permanent split — don't propose consolidating onto one queue technology.
- A new integration (e.g. a future Cursor Origin source) gets a new BullMQ job type keyed by provider, not a new queue system.
- Structural sync (Tree-sitter parse, graph write) must never block on LLM enrichment — enrichment consumes off a separate queue/topic so latency there can't delay the 15-second sync target.
- Publish a `graph.updated` event over SQS after every graph write so the Realtime Service can fan it out — don't push directly to WebSocket clients from a worker.
